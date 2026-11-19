/**
 * Voice front-end normaliser: converts a speech-recognition transcript such as
 *   "Delta fourteen twenty-six, runway two seven right, cleared for takeoff"
 * into the typed command syntax ("DAL1426 RUNWAY 27R CLEARED FOR TAKEOFF"), which then goes
 * through the same parser/validator as typed and clicked commands.
 */
import { AIRLINES } from './data/airlines';
import { PHONETIC } from './phraseology';

const ONES: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, to: 2, too: 2, three: 3, tree: 3, four: 4, for: 4, five: 5, fife: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, niner: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const LETTERS: Record<string, string> = {};
for (const [l, w] of Object.entries(PHONETIC)) LETTERS[w.toLowerCase().replace('-', '')] = l;
LETTERS.alfa = 'A'; LETTERS.juliet = 'J'; LETTERS.xray = 'X';

/** collapse spoken number words into digit strings; "four thousand" → 4000, "two seven right" → 27R */
function numbers(words: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  const strict = (w: string) => w in ONES && !['to', 'too', 'for', 'ate', 'oh'].includes(w);
  while (i < words.length) {
    const w = words[i];
    const digitish = strict(w) || w in TEENS || w in TENS || /^\d+$/.test(w) || ((w === 'to' || w === 'too' || w === 'for' || w === 'oh') && out.length > 0 && /^\d+$/.test(out[out.length - 1]) && (strict(words[i + 1] ?? '') || /^\d+$/.test(words[i + 1] ?? '')));
    if (!digitish) { out.push(w); i++; continue; }
    let digits = '';
    while (i < words.length) {
      const x = words[i];
      if (/^\d+$/.test(x)) { digits += x; i++; }
      else if (x in TENS) {
        const nx = words[i + 1];
        if (nx && nx in ONES && ONES[nx] > 0 && strict(nx)) { digits += String(TENS[x] + ONES[nx]); i += 2; }
        else { digits += String(TENS[x]); i++; }
      } else if (x in TEENS) { digits += String(TEENS[x]); i++; }
      else if (x in ONES && (strict(x) || digits.length > 0)) { digits += String(ONES[x]); i++; }
      else break;
    }
    if (words[i] === 'thousand') {
      i++;
      let rest = '000';
      if (words[i] in ONES && words[i + 1] === 'hundred') { rest = `${ONES[words[i]]}00`; i += 2; }
      else if (/^\d$/.test(words[i] ?? '') && words[i + 1] === 'hundred') { rest = `${words[i]}00`; i += 2; }
      digits += rest;
    } else if (words[i] === 'hundred') { digits += '00'; i++; }
    out.push(digits);
  }
  return out;
}

export function voiceToCommand(transcript: string): string {
  let t = transcript.toLowerCase().replace(/[.,;:!?]/g, ' ').replace(/-/g, ' ');
  // multi-word airline telephony first (longest names first)
  const tele = Object.values(AIRLINES).map((a) => [a.callsign.toLowerCase(), a.icao] as const).sort((a, b) => b[0].length - a[0].length);
  let callsignPrefix = '';
  for (const [name, icao] of tele) {
    if (icao === 'GA') continue;
    if (t.trimStart().startsWith(name + ' ')) {
      callsignPrefix = icao;
      t = t.trimStart().slice(name.length);
      break;
    }
  }
  t = t
    .replace(/\bline ?up and wait\b/g, ' line up wait ')
    .replace(/\bcleared (for|to) take ?off\b/g, ' cleared takeoff ')
    .replace(/\btake off\b/g, 'takeoff')
    .replace(/\bcleared to land\b/g, ' cleared land ')
    .replace(/\bpush ?back\b/g, 'pushback')
    .replace(/\bgo around\b/g, ' go around ')
    .replace(/\bhold short( of)?\b/g, ' hold short ')
    .replace(/\b(descend|climb) and maintain\b/g, '$1')
    .replace(/\bflight level\b/g, 'fl')
    .replace(/\bknots\b/g, '')
    .replace(/\b(heavy|super)\b/g, '')
    .replace(/\bturn (left|right) heading\b/g, 'turn $1 heading')
    .replace(/\bi l s\b/g, 'ils')
    .replace(/\bx ray\b/g, 'xray');
  let words = numbers(t.split(/\s+/).filter(Boolean));
  // runway suffixes and phonetic letters
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = out[out.length - 1];
    if ((w === 'left' || w === 'right' || w === 'center' || w === 'centre') && prev && /^\d{1,2}$/.test(prev) && out[out.length - 2] !== 'heading') {
      out[out.length - 1] = prev + w[0].toUpperCase();
    } else if (LETTERS[w] && !(w === 'delta' && i === 0)) {
      // taxiway / gate letters: join with a following number ("bravo 18" → B18) or letter ("sierra charlie" → SC)
      if (prev && /^[A-Z]{1,2}$/.test(prev) && out[out.length - 2] !== 'VIA' && !/^(VIA|GATE|SHORT|EXIT)$/.test(prev) && words[i - 1] && LETTERS[words[i - 1]] && false) out[out.length - 1] = prev + LETTERS[w];
      else out.push(LETTERS[w]);
    } else if (/^\d+$/.test(w) && prev && /^[A-Z]$/.test(prev) && w.length <= 2 && words[i - 1] && LETTERS[words[i - 1]]) {
      out[out.length - 1] = prev + w;
    } else out.push(w);
  }
  let res = out.join(' ').toUpperCase();
  if (callsignPrefix) res = callsignPrefix + res.replace(/^\s*(\d+)/, '$1').replace(/^ /, '');
  // the first token after the airline prefix must be glued: "DAL 1426" → "DAL1426"
  res = res.replace(/^([A-Z]{3})\s+(\d+)/, '$1$2');
  return res.replace(/\s+/g, ' ').trim();
}
