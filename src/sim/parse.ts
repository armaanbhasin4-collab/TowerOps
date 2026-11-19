/**
 * Typed ATC command parser. Converts simplified phraseology such as
 *   "DAL1426 TAXI VIA B M HOLD SHORT 27R"   "UAL892 DESCEND 4000, HEADING 240"
 * into structured Command objects. The same structures are produced by the click UI and by
 * the voice front-end, so every input method shares one validation/execution path.
 */
import type { Airport, Command } from './types';
import { normRwyName, gateByName } from './airport/query';

export interface Parsed {
  callsign: string;
  cmds: Command[];
}
export class ParseError extends Error {}

const FILLER = new Set(['AND', 'THE', 'FOR', 'TO', 'RUNWAY', 'RWY', 'PLEASE', 'MAINTAIN', 'FLY', 'PROCEED', 'YOU', 'ARE', 'IS', 'OF', 'AT', 'YOUR']);
const isNum = (t: string | undefined) => !!t && /^\d+$/.test(t);

export function parseCommand(ap: Airport, text: string, knownCallsigns: string[] = []): Parsed {
  const raw = text.toUpperCase().replace(/[,.;:]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (raw.length < 2) throw new ParseError('Enter a callsign followed by an instruction, e.g. "DAL1426 PUSHBACK APPROVED".');
  let callsign = raw[0];
  if (!knownCallsigns.includes(callsign)) {
    // allow unique partial matches: flight number only, or airline + partial
    const m = knownCallsigns.filter((c) => c.endsWith(callsign) || c.replace(/^[A-Z]+/, '') === callsign);
    if (m.length === 1) callsign = m[0];
    else if (m.length > 1) throw new ParseError(`"${raw[0]}" is ambiguous: ${m.slice(0, 4).join(', ')}`);
    else if (knownCallsigns.length) throw new ParseError(`Unknown callsign "${raw[0]}".`);
  }
  const tk = raw.slice(1);
  const cmds: Command[] = [];
  let i = 0;
  const peek = (o = 0) => tk[i + o];
  const rwyAt = (o = 0): string | undefined => {
    let p = i + o;
    while (tk[p] === 'RUNWAY' || tk[p] === 'RWY') p++;
    const t = tk[p];
    if (!t || !/^\d{1,2}[LRC]?$/.test(t)) return undefined;
    const n = normRwyName(ap, t);
    if (!n) throw new ParseError(`Runway ${t} does not exist at ${ap.icao}.`);
    i = p + 1 - 0;
    return n;
  };
  const skipFill = () => { while (peek() && FILLER.has(peek())) i++; };

  while (i < tk.length) {
    const t = tk[i];
    const n1 = tk[i + 1], n2 = tk[i + 2];
    if (t === 'PUSHBACK' || t === 'PUSH') {
      i++;
      if (peek() === 'BACK') i++;
      if (peek() === 'APPROVED') i++;
      let face: 'N' | 'E' | 'S' | 'W' | undefined;
      if (peek() === 'FACE' || peek() === 'FACING') {
        const f = tk[i + 1];
        const map: Record<string, 'N' | 'E' | 'S' | 'W'> = { N: 'N', NORTH: 'N', E: 'E', EAST: 'E', S: 'S', SOUTH: 'S', W: 'W', WEST: 'W' };
        if (!f || !map[f]) throw new ParseError('PUSHBACK FACE needs a direction (NORTH/EAST/SOUTH/WEST).');
        face = map[f];
        i += 2;
      }
      cmds.push({ t: 'PUSHBACK', face });
    } else if (t === 'CLEARANCE' || t === 'CLR' || (t === 'DEPARTURE' && n1 === 'CLEARANCE') || (t === 'CLEARED' && (n1 === 'AS' || (n1 === 'TO' && n2 !== 'LAND')))) {
      i++;
      while (peek() && !['PUSHBACK', 'PUSH', 'TAXI'].includes(peek())) i++;
      cmds.push({ t: 'DEP_CLEARANCE' });
    } else if (t === 'TAXI') {
      i++;
      const c: Extract<Command, { t: 'TAXI' }> = { t: 'TAXI' };
      for (;;) {
        skipFill();
        const x = peek();
        if (!x) break;
        if (x === 'GATE' || x === 'STAND') {
          const g = tk[i + 1];
          if (!g || !gateByName(ap, g)) throw new ParseError(`Gate ${g ?? ''} does not exist at ${ap.icao}.`);
          c.gate = g; i += 2;
        } else if (x === 'VIA') {
          i++;
          c.via = [];
          while (peek() && !['HOLD', 'GATE', 'STAND', 'CROSS', 'TO', 'RUNWAY', 'RWY'].includes(peek()) && /^[A-Z]{1,2}\d{0,2}$/.test(peek())) c.via.push(tk[i++]);
          if (!c.via.length) throw new ParseError('TAXI VIA needs at least one taxiway.');
        } else if (x === 'HOLD' && tk[i + 1] === 'SHORT') {
          i += 2;
          skipFill();
          const r = rwyAt();
          if (r) { c.holdShort = r; if (!c.rwy && !c.gate) c.rwy = r; }
          else if (peek()) c.holdShort = tk[i++];
          else throw new ParseError('HOLD SHORT of what?');
        } else if (/^\d{1,2}[LRC]?$/.test(x)) {
          c.rwy = rwyAt();
        } else if (gateByName(ap, x)) {
          c.gate = x; i++;
        } else break;
      }
      cmds.push(c);
    } else if ((t === 'HOLD' && n1 === 'POSITION') || t === 'STOP') {
      i += t === 'STOP' ? 1 : 2;
      cmds.push({ t: 'HOLD_POSITION' });
    } else if (t === 'CONTINUE' || t === 'RESUME' && n1 === 'TAXI') {
      i++;
      if (peek() === 'TAXI') i++;
      cmds.push({ t: 'CONTINUE_TAXI' });
    } else if (t === 'CROSS') {
      i++;
      const r = rwyAt();
      if (!r) throw new ParseError('CROSS needs a runway, e.g. "CROSS 27R".');
      cmds.push({ t: 'CROSS', rwy: r });
    } else if (t === 'LUAW' || (t === 'LINE' && n1 === 'UP')) {
      i += t === 'LUAW' ? 1 : 2;
      if (peek() === 'AND') i++;
      if (peek() === 'WAIT') i++;
      cmds.push({ t: 'LINE_UP', rwy: rwyAt() });
    } else if (t === 'CANCEL' || t === 'ABORT') {
      i++;
      while (peek() === 'TAKEOFF' || peek() === 'CLEARANCE') i++;
      cmds.push({ t: 'CANCEL_TAKEOFF' });
    } else if (t === 'TAKEOFF' || t === 'CTO' || (t === 'CLEARED' && (n1 === 'TAKEOFF' || (n1 === 'FOR' && n2 === 'TAKEOFF')))) {
      i += t === 'CLEARED' ? (n1 === 'FOR' ? 3 : 2) : 1;
      cmds.push({ t: 'TAKEOFF', rwy: rwyAt() });
    } else if (t === 'LAND' || t === 'CTL' || (t === 'CLEARED' && (n1 === 'LAND' || (n1 === 'TO' && n2 === 'LAND')))) {
      i += t === 'CLEARED' ? (n1 === 'TO' ? 3 : 2) : 1;
      cmds.push({ t: 'LAND', rwy: rwyAt() });
    } else if (t === 'ILS' || t === 'APPROACH' || t === 'VISUAL' || (t === 'CLEARED' && (n1 === 'ILS' || n1 === 'APPROACH' || n1 === 'VISUAL'))) {
      i += t === 'CLEARED' ? 2 : 1;
      while (peek() === 'APPROACH' || peek() === 'ILS') i++;
      const r = rwyAt();
      if (!r) throw new ParseError('Approach clearance needs a runway, e.g. "CLEARED ILS 26L".');
      if (peek() === 'APPROACH') i++;
      cmds.push({ t: 'APPROACH', rwy: r });
    } else if (t === 'GA' || (t === 'GO' && n1 === 'AROUND')) {
      i += t === 'GA' ? 1 : 2;
      cmds.push({ t: 'GO_AROUND' });
    } else if (t === 'HEADING' || t === 'HDG' || t === 'H' || t === 'TURN' || (t === 'FLY' && n1 === 'HEADING')) {
      i++;
      let dir: 'L' | 'R' | undefined;
      if (peek() === 'LEFT' || peek() === 'L') { dir = 'L'; i++; }
      else if (peek() === 'RIGHT' || peek() === 'R') { dir = 'R'; i++; }
      if (peek() === 'HEADING' || peek() === 'HDG') i++;
      if (!isNum(peek())) throw new ParseError('HEADING needs a value 001–360.');
      const h = +tk[i++];
      if (h < 1 || h > 360) throw new ParseError('Heading must be between 001 and 360.');
      cmds.push({ t: 'HEADING', hdg: h % 360, dir });
    } else if (t === 'DESCEND' || t === 'CLIMB' || t === 'ALTITUDE' || t === 'ALT' || t === 'A' || t === 'D' || t === 'C') {
      i++;
      while (peek() === 'AND' || peek() === 'MAINTAIN' || peek() === 'TO') i++;
      let tok = peek();
      if (tok && /^FL\d+$/.test(tok)) tok = String(+tok.slice(2) * 100);
      if (!isNum(tok)) throw new ParseError('Altitude needs a value in feet, e.g. "DESCEND 4000".');
      i++;
      let alt = +tok!;
      if (alt < 1000) alt *= 100;
      cmds.push({ t: 'ALTITUDE', alt });
    } else if (t === 'SPEED' || t === 'SPD' || t === 'S' || t === 'REDUCE' || t === 'INCREASE') {
      i++;
      if (peek() === 'SPEED') i++;
      if (peek() === 'TO') i++;
      if (peek() === 'NORMAL' || peek() === 'RESUME') { i++; cmds.push({ t: 'SPEED', spd: 0 }); }
      else {
        if (!isNum(peek())) throw new ParseError('SPEED needs a value in knots.');
        cmds.push({ t: 'SPEED', spd: +tk[i++] });
      }
    } else if (t === 'RESUME' && n1 === 'NORMAL') {
      i += 2;
      if (peek() === 'SPEED') i++;
      cmds.push({ t: 'SPEED', spd: 0 });
    } else if (t === 'DIRECT' || t === 'DCT' || (t === 'PROCEED' && n1 === 'DIRECT')) {
      i += t === 'PROCEED' ? 2 : 1;
      if (peek() === 'TO') i++;
      if (!peek()) throw new ParseError('DIRECT needs a fix name.');
      cmds.push({ t: 'DIRECT', fix: tk[i++] });
    } else if (t === 'HOLD') {
      i++;
      if (peek() === 'AT') i++;
      const f = peek() && /^[A-Z0-9]{3,6}$/.test(peek()) && ap.fixes.some((x) => x.name === peek()) ? tk[i++] : undefined;
      cmds.push({ t: 'HOLD', fix: f });
    } else if (t === 'EXPECT' || t === 'RUNWAY' || t === 'RWY') {
      i++;
      const r = rwyAt();
      if (!r) throw new ParseError('EXPECT needs a runway.');
      cmds.push({ t: 'ASSIGN_RUNWAY', rwy: r });
    } else if (t === 'GATE' || t === 'STAND') {
      const g = n1;
      if (!g || !gateByName(ap, g)) throw new ParseError(`Gate ${g ?? ''} does not exist at ${ap.icao}.`);
      i += 2;
      cmds.push({ t: 'ASSIGN_GATE', gate: g });
    } else if (t === 'EXIT' || t === 'VACATE') {
      i++;
      while (peek() === 'VIA' || peek() === 'AT' || peek() === 'LEFT' || peek() === 'RIGHT') i++;
      if (!peek()) throw new ParseError('EXIT needs a taxiway.');
      cmds.push({ t: 'EXIT', twy: tk[i++] });
    } else if (t === 'CONTACT' || t === 'HANDOFF') {
      i++;
      while (peek() && /^(CENTER|CENTRE|DEPARTURE|CONTROL|GOOD|DAY)$/.test(peek())) i++;
      cmds.push({ t: 'HANDOFF' });
    } else if (t === 'TOW') {
      i++;
      cmds.push({ t: 'TOW' });
    } else if (FILLER.has(t) || t === 'APPROVED' || t === 'WAIT' || t === 'CLEARED' || t === 'WIND' || t === 'CALM') {
      i++;
    } else if (t === 'MAINTAIN' && isNum(n1)) {
      i += 2;
      const v = +n1;
      cmds.push(v <= 400 ? { t: 'SPEED', spd: v } : { t: 'ALTITUDE', alt: v });
    } else {
      throw new ParseError(`Did not understand "${tk.slice(i).join(' ')}". Examples: PUSHBACK APPROVED · TAXI 27R VIA B M · CROSS 26L · LINE UP WAIT · CLEARED TAKEOFF · HEADING 240 · DESCEND 4000 · SPEED 180 · CLEARED ILS 26L · CLEARED LAND · GO AROUND · TAXI GATE C12 VIA N B`);
    }
  }
  if (!cmds.length) throw new ParseError('No instruction found after the callsign.');
  return { callsign, cmds };
}
