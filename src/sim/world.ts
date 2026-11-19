/** Shared world context + logging helpers used by all engine modules. */
import type { Aircraft, Airport, EventKind, Position, RequestType, Severity, SimState } from './types';
import { sayCallsign, cap } from './phraseology';

export interface World {
  s: SimState;
  ap: Airport;
}

export const AIRBORNE: ReadonlySet<string> = new Set(['inbound', 'approach', 'final', 'departure', 'go_around']);
export const isAirborne = (ac: Aircraft) => AIRBORNE.has(ac.phase);
export const isActive = (ac: Aircraft) => ac.phase !== 'gone' && ac.phase !== 'crashed';
export const onSurface = (ac: Aircraft) => isActive(ac) && !isAirborne(ac);

export function acById(w: World, id: number): Aircraft | undefined {
  return w.s.aircraft.find((a) => a.id === id);
}
export function acByCallsign(w: World, cs: string): Aircraft | undefined {
  const u = cs.toUpperCase();
  return w.s.aircraft.find((a) => a.callsign === u && a.phase !== 'gone');
}

export function logEvent(w: World, kind: EventKind, sev: Severity, text: string, ac?: Aircraft[]) {
  w.s.events.push({ t: w.s.t, kind, sev, text, ac: ac?.map((a) => a.id), x: ac?.[0]?.x, y: ac?.[0]?.y });
  if (w.s.events.length > 600) w.s.events.splice(0, w.s.events.length - 600);
}

export function radioPilot(w: World, ac: Aircraft, text: string, emergency = false) {
  w.s.radio.push({ t: w.s.t, from: 'pilot', ac: ac.id, callsign: ac.callsign, text, emergency, pos: positionFor(ac) });
  ac.lastContact = w.s.t;
  trimRadio(w);
}
export function radioAtc(w: World, ac: Aircraft, text: string) {
  w.s.radio.push({ t: w.s.t, from: 'atc', ac: ac.id, callsign: ac.callsign, text, pos: positionFor(ac) });
  trimRadio(w);
}
export function radioSystem(w: World, text: string) {
  w.s.radio.push({ t: w.s.t, from: 'system', text });
  trimRadio(w);
}
function trimRadio(w: World) {
  if (w.s.radio.length > 400) w.s.radio.splice(0, w.s.radio.length - 400);
}

/** which controller position is responsible for the aircraft right now */
export function positionFor(ac: Aircraft): Position {
  switch (ac.phase) {
    case 'parked': return ac.depCleared ? 'ground' : 'delivery';
    case 'pushback': case 'push_done': case 'taxi_out': case 'taxi_in': case 'vacated': case 'disabled': return 'ground';
    case 'holding_short': case 'lining_up': case 'lined_up': case 'takeoff_roll': case 'landing_roll': case 'final': return 'tower';
    case 'departure': return 'departure';
    default: return 'approach';
  }
}

/** Raise (or refresh) a pilot request. Logs the radio call. */
export function setRequest(w: World, ac: Aircraft, type: RequestType, text: string, rwy?: string) {
  if (ac.request?.type === type && ac.request.rwy === rwy) return;
  ac.request = { type, since: w.s.t, text, rwy };
  radioPilot(w, ac, text, type === 'emergency');
}
export function clearRequest(ac: Aircraft, ...types: RequestType[]) {
  if (ac.request && (types.length === 0 || types.includes(ac.request.type))) ac.request = undefined;
}

export const csay = (ac: Aircraft) => cap(sayCallsign(ac));
