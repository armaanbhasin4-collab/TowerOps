/** Aviation phraseology helpers: spoken numbers, callsigns, ATC transmissions and pilot readbacks. */
import type { Aircraft, Airport, Command } from './types';
import { airlineOf } from './data/airlines';
import { typeOf } from './data/aircraft';

const DIG = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
export const PHONETIC: Record<string, string> = {
  A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India',
  J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
  S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
};

export const sayDigits = (s: string | number) => String(s).split('').map((c) => (c >= '0' && c <= '9' ? DIG[+c] : PHONETIC[c] ?? c)).join(' ');

/** 0..99 as a group number: 26 -> "twenty-six", 5 -> "five" (with leading "zero" when padded) */
function sayPair(n: number, pad = false): string {
  if (n < 10) return (pad ? 'zero ' : '') + DIG[n].replace('niner', 'nine');
  if (n < 20) return TEENS[n - 10];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t}-${DIG[n % 10].replace('niner', 'nine')}` : t;
}
/** flight numbers in US group form: 1426 -> "fourteen twenty-six", 892 -> "eight ninety-two" */
export function sayFlightNumber(num: string): string {
  const n = num.replace(/\D/g, '');
  if (n.length <= 2) return sayPair(+n);
  if (n.length === 3) return `${DIG[+n[0]].replace('niner', 'nine')} ${sayPair(+n.slice(1), true)}`;
  if (n.length === 4) return `${sayPair(+n.slice(0, 2))} ${sayPair(+n.slice(2), true)}`;
  return sayDigits(n);
}

export function sayCallsign(ac: Pick<Aircraft, 'callsign' | 'airline' | 'type'>): string {
  const al = airlineOf(ac.airline);
  const t = typeOf(ac.type);
  if (ac.airline === 'GA') return `November ${sayDigits(ac.callsign.replace(/^N/, ''))}`;
  const num = ac.callsign.slice(al.icao.length);
  const suffix = t.wake === 'J' ? ' super' : t.wake === 'H' ? ' heavy' : '';
  return `${al.callsign} ${sayFlightNumber(num)}${suffix}`;
}

export function sayRwy(name: string): string {
  const m = /^(\d+)([LRC]?)$/.exec(name);
  if (!m) return name;
  const side = m[2] === 'L' ? ' left' : m[2] === 'R' ? ' right' : m[2] === 'C' ? ' center' : '';
  return `${m[1].padStart(2, '0').split('').map((c) => DIG[+c]).join(' ')}${side}`;
}
export function sayAlt(ft: number): string {
  const th = Math.floor(ft / 1000);
  const hu = Math.round((ft % 1000) / 100);
  const parts: string[] = [];
  if (th > 0) parts.push(`${sayDigits(th)} thousand`);
  if (hu > 0) parts.push(`${DIG[hu]} hundred`);
  return parts.join(' ') || 'zero';
}
export const sayHdg = (h: number) => sayDigits(String(Math.round(h) % 360 || 360).padStart(3, '0'));
export const saySpd = (s: number) => `${sayDigits(Math.round(s))} knots`;
export function sayTwy(name: string): string {
  return name.split('').map((c) => (c >= '0' && c <= '9' ? DIG[+c].replace('niner', 'nine') : PHONETIC[c.toUpperCase()] ?? c)).join(' ');
}
export const sayRoute = (names: string[]) => (names.length ? names.map(sayTwy).join(', ') : 'direct');
export function sayGate(name: string): string {
  const m = /^([A-Z]*)(\d*)([A-Z]*)$/.exec(name);
  if (!m) return name;
  const letters = m[1].split('').map((c) => PHONETIC[c]).join(' ');
  const num = m[2] ? (m[2].length <= 2 ? sayPair(+m[2]) : sayDigits(m[2])) : '';
  return [letters, num, m[3] ? sayTwy(m[3]) : ''].filter(Boolean).join(' ');
}
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** ATC transmission text for a list of commands. `names` are the resolved taxi route names. */
export function atcPhrase(ap: Airport, ac: Aircraft, cmds: Command[], ctx: { taxiNames?: string[]; wind?: string } = {}): string {
  const parts: string[] = [];
  const rw = (cmds.find((x) => x.t === 'APPROACH') as { rwy?: string } | undefined)?.rwy;
  for (const c of cmds) {
    switch (c.t) {
      case 'DEP_CLEARANCE':
        parts.push(`cleared to ${ac.dest} as filed, climb and maintain ${sayAlt(5000)}, departure frequency in the tower, squawk ${sayDigits(squawkOf(ac))}`);
        break;
      case 'PUSHBACK': parts.push(`pushback approved${c.face ? `, face ${{ N: 'north', E: 'east', S: 'south', W: 'west' }[c.face]}` : ''}`); break;
      case 'TAXI':
        if (c.gate) parts.push(`taxi to gate ${sayGate(c.gate)} via ${sayRoute(ctx.taxiNames ?? c.via ?? [])}`);
        else parts.push(`runway ${sayRwy(c.rwy ?? rw ?? ac.rwy ?? '')}, taxi via ${sayRoute(ctx.taxiNames ?? c.via ?? [])}${c.holdShort ? `, hold short of ${/^\d/.test(c.holdShort) ? 'runway ' + sayRwy(c.holdShort) : sayTwy(c.holdShort)}` : ''}`);
        break;
      case 'HOLD_POSITION': parts.push('hold position'); break;
      case 'CONTINUE_TAXI': parts.push('continue taxi'); break;
      case 'CROSS': parts.push(`cross runway ${sayRwy(c.rwy)}`); break;
      case 'LINE_UP': parts.push(`runway ${sayRwy(c.rwy ?? rw ?? ac.rwy ?? '')}, line up and wait`); break;
      case 'TAKEOFF': parts.push(`${ctx.wind ? `wind ${ctx.wind}, ` : ''}runway ${sayRwy(c.rwy ?? rw ?? ac.rwy ?? '')}, cleared for takeoff`); break;
      case 'CANCEL_TAKEOFF': parts.push('cancel takeoff clearance, hold position'); break;
      case 'HEADING': parts.push(`${c.dir === 'L' ? 'turn left' : c.dir === 'R' ? 'turn right' : 'fly'} heading ${sayHdg(c.hdg)}`); break;
      case 'ALTITUDE': parts.push(`${c.alt > ac.alt ? 'climb' : 'descend'} and maintain ${sayAlt(c.alt)}`); break;
      case 'SPEED': parts.push(c.spd ? `maintain ${saySpd(c.spd)}` : 'resume normal speed'); break;
      case 'DIRECT': parts.push(`proceed direct ${c.fix}`); break;
      case 'HOLD': parts.push(`hold ${c.fix ? `at ${c.fix}` : 'present position'} as published, expect further clearance in one zero minutes`); break;
      case 'APPROACH': parts.push(`cleared ILS runway ${sayRwy(c.rwy)} approach`); break;
      case 'LAND': parts.push(`${ctx.wind ? `wind ${ctx.wind}, ` : ''}runway ${sayRwy(c.rwy ?? rw ?? ac.rwy ?? '')}, cleared to land`); break;
      case 'GO_AROUND': parts.push('go around, fly runway heading, climb and maintain three thousand'); break;
      case 'ASSIGN_RUNWAY': parts.push(`expect runway ${sayRwy(c.rwy)}`); break;
      case 'ASSIGN_GATE': parts.push(`your gate is ${sayGate(c.gate)}`); break;
      case 'EXIT': parts.push(`plan to exit at ${sayTwy(c.twy)}`); break;
      case 'HANDOFF': parts.push('contact center, good day'); break;
      case 'TOW': parts.push('tug is on the way, expect reposition'); break;
    }
  }
  return `${cap(sayCallsign(ac))}, ${parts.join(', ')}.`;
}

export function readbackPhrase(ap: Airport, ac: Aircraft, cmds: Command[], ctx: { taxiNames?: string[] } = {}): string {
  const parts: string[] = [];
  const rw = (cmds.find((x) => x.t === 'APPROACH') as { rwy?: string } | undefined)?.rwy;
  for (const c of cmds) {
    switch (c.t) {
      case 'DEP_CLEARANCE': parts.push(`cleared to ${ac.dest}, maintain ${sayAlt(5000)}, squawk ${sayDigits(squawkOf(ac))}`); break;
      case 'PUSHBACK': parts.push('pushback approved'); break;
      case 'TAXI':
        if (c.gate) parts.push(`gate ${sayGate(c.gate)} via ${sayRoute(ctx.taxiNames ?? [])}`);
        else parts.push(`runway ${sayRwy(c.rwy ?? rw ?? ac.rwy ?? '')} via ${sayRoute(ctx.taxiNames ?? [])}${c.holdShort ? `, hold short ${/^\d/.test(c.holdShort) ? sayRwy(c.holdShort) : sayTwy(c.holdShort)}` : ''}`);
        break;
      case 'HOLD_POSITION': parts.push('holding position'); break;
      case 'CONTINUE_TAXI': parts.push('continuing taxi'); break;
      case 'CROSS': parts.push(`crossing runway ${sayRwy(c.rwy)}`); break;
      case 'LINE_UP': parts.push(`line up and wait ${sayRwy(c.rwy ?? rw ?? ac.rwy ?? '')}`); break;
      case 'TAKEOFF': parts.push(`cleared for takeoff ${sayRwy(c.rwy ?? rw ?? ac.rwy ?? '')}`); break;
      case 'CANCEL_TAKEOFF': parts.push('holding position'); break;
      case 'HEADING': parts.push(`${c.dir === 'L' ? 'left ' : c.dir === 'R' ? 'right ' : ''}heading ${sayHdg(c.hdg)}`); break;
      case 'ALTITUDE': parts.push(`${c.alt > ac.alt ? 'up to' : 'down to'} ${sayAlt(c.alt)}`); break;
      case 'SPEED': parts.push(c.spd ? saySpd(c.spd) : 'normal speed'); break;
      case 'DIRECT': parts.push(`direct ${c.fix}`); break;
      case 'HOLD': parts.push(`hold ${c.fix ? `at ${c.fix}` : 'present position'}`); break;
      case 'APPROACH': parts.push(`cleared ILS ${sayRwy(c.rwy)}`); break;
      case 'LAND': parts.push(`cleared to land ${sayRwy(c.rwy ?? rw ?? ac.rwy ?? '')}`); break;
      case 'GO_AROUND': parts.push('going around'); break;
      case 'ASSIGN_RUNWAY': parts.push(`expect ${sayRwy(c.rwy)}`); break;
      case 'ASSIGN_GATE': parts.push(`gate ${sayGate(c.gate)}`); break;
      case 'EXIT': parts.push(`exit at ${sayTwy(c.twy)}`); break;
      case 'HANDOFF': parts.push('over to center, good day'); break;
      case 'TOW': parts.push('standing by for the tug'); break;
    }
  }
  return `${cap(parts.join(', '))}, ${sayCallsign(ac)}.`;
}

/** deterministic transponder code derived from the aircraft id */
export function squawkOf(ac: Pick<Aircraft, 'id'>): string {
  let v = (ac.id * 2654435761) >>> 0;
  let s = '';
  for (let i = 0; i < 4; i++) { s += String(v % 8); v = Math.floor(v / 8); }
  return s;
}

export function facilityName(ap: Airport, pos: 'Ground' | 'Tower' | 'Approach' | 'Departure' | 'Clearance'): string {
  return `${ap.facility} ${pos}`;
}
