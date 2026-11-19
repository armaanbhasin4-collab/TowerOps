import { Sim, defaultConfig } from '../src/sim/sim';
import type { Aircraft, ScenarioConfig } from '../src/sim/types';
import { NM } from '../src/sim/util';
import { suggest, applySuggestion } from '../src/sim/delegation';

export function quietConfig(airport = 'ATL', over: Partial<ScenarioConfig> = {}): ScenarioConfig {
  const cfg = defaultConfig(airport, 'intermediate');
  cfg.emptyStart = true;
  cfg.difficulty.radioComplexity = 0;
  cfg.difficulty.emergencyFreq = 0;
  cfg.difficulty.arrivalRate = 0;
  cfg.weatherPreset = 'custom';
  cfg.customWeather = { windDir: 270, windKt: 5, gustKt: 0 };
  return { ...cfg, ...over };
}

export function until(sim: Sim, cond: () => boolean, maxSec: number, label: string, each?: () => void) {
  for (let i = 0; i < maxSec && !cond(); i++) {
    sim.advance(1);
    each?.();
  }
  if (!cond()) throw new Error(`timeout waiting for: ${label} (t=${sim.s.t.toFixed(0)})`);
}

export function ok(sim: Sim, text: string) {
  const r = sim.commandText(text);
  if (!r.ok) throw new Error(`command "${text}" failed: ${r.message}`);
  sim.advance(4); // readback delay
}

export const distNm = (a: Aircraft, x = 0, y = 0) => Math.hypot(a.x - x, a.y - y) / NM;

/** drive an aircraft with the suggestion engine through the normal command pipeline */
export function autoControl(sim: Sim, ac: Aircraft) {
  const sg = suggest(sim, ac);
  if (sg && sg.cmds.length) applySuggestion(sim, ac, sg, 'player');
}

// ───────────────────────── scenario construction helpers ─────────────────────────
import type { Command, Difficulty, SimEvent } from '../src/sim/types';
import { blankAircraft, spawnParked } from '../src/sim/traffic';
import { endRef, edgeBetween } from '../src/sim/airport/query';
import { typeOf } from '../src/sim/data/aircraft';
import { GS_FT_PER_M } from '../src/sim/air';
import { vecOf, hdgOf } from '../src/sim/util';

/** quiet, scripted sim with optional difficulty overrides */
export function mkSim(airport = 'ATL', over: Partial<ScenarioConfig> = {}, diff: Partial<Difficulty> = {}): Sim {
  const cfg = quietConfig(airport, over);
  Object.assign(cfg.difficulty, diff);
  return new Sim(cfg);
}

/** issue structured commands, fail loudly if rejected, wait for the readback */
export function cmd(sim: Sim, ac: Aircraft, ...cmds: Command[]) {
  const r = sim.command(ac, cmds);
  if (!r.ok) throw new Error(`command ${JSON.stringify(cmds)} to ${ac.callsign} failed: ${r.message}`);
  sim.advance(4);
}

export interface DepOpts { airline?: string; type?: string; callsign?: string; dest?: string }
/** a parked aircraft whose turnaround has just completed (kind 'departure', stage 'ready') */
export function readyDeparture(sim: Sim, gate: string, o: DepOpts = {}): Aircraft {
  const ac = spawnParked(sim, gate, { airline: o.airline ?? 'DAL', type: o.type ?? 'A321', callsign: o.callsign, dest: o.dest ?? 'LGA', readyIn: 1 });
  if (!ac) throw new Error(`could not spawn at gate ${gate}`);
  sim.advance(3);
  if (ac.kind !== 'departure' || ac.turn?.stage !== 'ready') throw new Error('departure not ready');
  return ac;
}
/** departure clearance + pushback, returns once the pushback is complete */
export function pushedBack(sim: Sim, gate: string, o: DepOpts = {}): Aircraft {
  const ac = readyDeparture(sim, gate, o);
  cmd(sim, ac, { t: 'DEP_CLEARANCE' });
  cmd(sim, ac, { t: 'PUSHBACK' });
  until(sim, () => ac.phase === 'push_done', 300, 'pushback complete');
  return ac;
}
/** departure taxied all the way to the hold line of `rwy` (crossings are cleared on request) */
export function atHoldShort(sim: Sim, gate: string, rwy: string, o: DepOpts = {}): Aircraft {
  const ac = pushedBack(sim, gate, o);
  cmd(sim, ac, { t: 'TAXI', rwy });
  until(sim, () => ac.phase === 'holding_short', 1500, `holding short ${rwy}`, () => {
    if (ac.request?.type === 'crossing' && !ac.flags.pending) sim.command(ac, [{ t: 'CROSS', rwy: sim.ap.runways.find((r) => r.id === ac.request!.rwy)!.ends[0].name }]);
  });
  return ac;
}

export interface FinalOpts { airline?: string; type?: string; callsign?: string; landCleared?: boolean; gate?: string }
/** place an established arrival on the ILS of `rwy`, `dNm` from the threshold, on the glidepath */
export function placeFinal(sim: Sim, rwy: string, dNm: number, o: FinalOpts = {}): Aircraft {
  const e = endRef(sim.ap, rwy);
  if (!e) throw new Error(`no runway ${rwy}`);
  const type = o.type ?? 'B738';
  const t = typeOf(type);
  const [ux, uy] = vecOf(e.end.hdg);
  const d = dNm * NM;
  const airline = o.airline ?? 'UAL';
  const ias = dNm < 5 ? t.vref + 5 : 170;
  return blankAircraft(sim, {
    airline, type, callsign: o.callsign ?? `${airline}${800 + sim.s.nextId}`, kind: 'arrival', origin: 'ORD', dest: sim.ap.iata,
    phase: 'final', x: e.end.x - ux * d, y: e.end.y - uy * d, alt: (d + 300) * GS_FT_PER_M, hdg: e.end.hdg, track: e.end.hdg,
    ias, gs: ias, latMode: 'loc', tgtHdg: e.end.hdg, tgtAlt: 3000, rwy: e.end.name,
    apprCleared: true, established: true, landCleared: !!o.landCleared, checkedIn: true, gate: o.gate,
    sched: sim.s.t + 300, est: sim.s.t + 300,
    nextLeg: { callsign: `${airline}${1800 + sim.s.nextId}`, dest: 'ORD', sched: 0 },
  });
}

export interface AirOpts { airline?: string; type?: string; callsign?: string; x: number; y: number; alt: number; hdg: number; ias?: number; kind?: 'arrival' | 'departure' }
/** place a level airborne aircraft flying a fixed heading */
export function placeAirborne(sim: Sim, o: AirOpts): Aircraft {
  const airline = o.airline ?? 'DAL';
  const kind = o.kind ?? 'arrival';
  const ias = o.ias ?? 220;
  return blankAircraft(sim, {
    airline, type: o.type ?? 'B738', callsign: o.callsign ?? `${airline}${500 + sim.s.nextId}`, kind, origin: kind === 'arrival' ? 'ORD' : sim.ap.iata, dest: kind === 'arrival' ? sim.ap.iata : 'ORD',
    phase: kind === 'arrival' ? 'inbound' : 'departure', x: o.x, y: o.y, alt: o.alt, hdg: o.hdg, track: o.hdg, ias, gs: ias,
    latMode: 'hdg', tgtHdg: o.hdg, tgtAlt: o.alt, tgtSpd: ias, checkedIn: true, depCleared: kind === 'departure', sched: sim.s.t + 600,
  });
}

export interface RwyOpts { airline?: string; type?: string; callsign?: string; along?: number; phase?: Aircraft['phase']; gs?: number; takeoffCleared?: boolean; kind?: 'arrival' | 'departure' }
/** place an aircraft on the centreline of `rwy`, `along` metres past the threshold (default: lined up) */
export function placeOnRunway(sim: Sim, rwy: string, o: RwyOpts = {}): Aircraft {
  const e = endRef(sim.ap, rwy);
  if (!e) throw new Error(`no runway ${rwy}`);
  const [ux, uy] = vecOf(e.end.hdg);
  const along = o.along ?? 60;
  const airline = o.airline ?? 'DAL';
  const phase = o.phase ?? 'lined_up';
  const kind = o.kind ?? 'departure';
  return blankAircraft(sim, {
    airline, type: o.type ?? 'A321', callsign: o.callsign ?? `${airline}${300 + sim.s.nextId}`, kind, origin: sim.ap.iata, dest: 'LGA',
    phase, x: e.end.x + ux * along, y: e.end.y + uy * along, alt: 0, hdg: e.end.hdg, track: e.end.hdg, gs: o.gs ?? 0, ias: o.gs ?? 0,
    rwy: e.end.name, rwyDist: along, depCleared: true, pushApproved: true, lineUpCleared: kind === 'departure', takeoffCleared: !!o.takeoffCleared,
    tgtAlt: 5000, tgtHdg: e.end.hdg, checkedIn: true, sched: sim.s.t,
  });
}

/** node ids of a named taxiway sorted along its dominant axis (ascending x or y) */
export function taxiwayNodes(sim: Sim, name: string): number[] {
  const ids = new Set<number>();
  for (const e of sim.ap.edges) if (e.name === name && e.kind !== 'runway') { ids.add(e.a); ids.add(e.b); }
  const ns = [...ids].map((i) => sim.ap.nodes[i]);
  const dx = Math.max(...ns.map((n) => n.x)) - Math.min(...ns.map((n) => n.x));
  const dy = Math.max(...ns.map((n) => n.y)) - Math.min(...ns.map((n) => n.y));
  ns.sort((a, b) => (dx >= dy ? a.x - b.x : a.y - b.y));
  // keep only a contiguous chain (consecutive nodes joined by an edge)
  const out = [ns[0].id];
  for (let i = 1; i < ns.length; i++) if (edgeBetween(sim.ap, out[out.length - 1], ns[i].id)) out.push(ns[i].id);
  return out;
}

export interface GroundOpts { airline?: string; type?: string; callsign?: string; kind?: 'arrival' | 'departure'; phase?: Aircraft['phase']; startS?: number; rwy?: string; gate?: string }
/** place a surface aircraft on an explicit node route (default: taxiing along it, cleared to its end) */
export function placeOnRoute(sim: Sim, route: number[], o: GroundOpts = {}): Aircraft {
  const ap = sim.ap;
  const kind = o.kind ?? 'departure';
  const airline = o.airline ?? 'DAL';
  const a = ap.nodes[route[0]], b = ap.nodes[route[1]];
  const h = hdgOf(b.x - a.x, b.y - a.y);
  const [ux, uy] = vecOf(h);
  const s0 = o.startS ?? 0;
  let end = 0;
  for (let i = 1; i < route.length; i++) end += Math.hypot(ap.nodes[route[i]].x - ap.nodes[route[i - 1]].x, ap.nodes[route[i]].y - ap.nodes[route[i - 1]].y);
  const phase = o.phase ?? (kind === 'departure' ? 'taxi_out' : 'taxi_in');
  const stationary = phase === 'push_done' || phase === 'vacated';
  return blankAircraft(sim, {
    airline, type: o.type ?? 'A321', callsign: o.callsign ?? `${airline}${100 + sim.s.nextId}`, kind, origin: kind === 'arrival' ? 'ORD' : ap.iata, dest: kind === 'arrival' ? ap.iata : 'ORD',
    phase, x: a.x + ux * s0, y: a.y + uy * s0, hdg: h, track: h, route: [...route], routeS: s0, routeStop: stationary ? s0 : end,
    depCleared: kind === 'departure', pushApproved: kind === 'departure', rwy: o.rwy, gate: o.gate, checkedIn: true, sched: sim.s.t,
    nextLeg: kind === 'arrival' ? { callsign: `${airline}${1500 + sim.s.nextId}`, dest: 'ORD', sched: 0 } : undefined,
  });
}

export const eventsOf = (sim: Sim, kind: SimEvent['kind']) => sim.s.events.filter((e) => e.kind === kind);
export const gapM = (a: Aircraft, b: Aircraft) => Math.hypot(a.x - b.x, a.y - b.y);

import { findRoute } from '../src/sim/pathfind';
import { nearestNode } from '../src/sim/airport/query';
/** id of the taxiway/runway graph node at (x, y) (±6 m) */
export function nodeAt(sim: Sim, x: number, y: number): number {
  const n = nearestNode(sim.ap, x, y, (q) => q.kind !== 'gate');
  if (!n || Math.hypot(n.x - x, n.y - y) > 6) throw new Error(`no node at ${x},${y}`);
  return n.id;
}
/** node route through the given waypoints (each must be a graph node position) */
export function routeVia(sim: Sim, pts: [number, number][]): number[] {
  const out = [nodeAt(sim, ...pts[0])];
  for (let i = 1; i < pts.length; i++) {
    const r = findRoute(sim.ap, out[out.length - 1], nodeAt(sim, ...pts[i]), { prev: out.length > 1 ? out[out.length - 2] : undefined });
    if (!r) throw new Error(`no route to waypoint ${pts[i]}`);
    out.push(...r.nodes.slice(1));
  }
  return out;
}

type Seg4 = [number, number, number, number];
function bodySegs(a: Aircraft): Seg4[] {
  const t = typeOf(a.type);
  const [ux, uy] = vecOf(a.hdg);
  const h = t.length / 2, w = t.span / 2;
  return [[a.x - ux * h, a.y - uy * h, a.x + ux * h, a.y + uy * h], [a.x - uy * w, a.y + ux * w, a.x + uy * w, a.y - ux * w]];
}
function ptSeg(px: number, py: number, s: Seg4) {
  const dx = s[2] - s[0], dy = s[3] - s[1];
  const t = Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - s[0] - dx * t, py - s[1] - dy * t);
}
function segSeg(a: Seg4, b: Seg4) {
  const c = (p: Seg4, x: number, y: number) => (p[2] - p[0]) * (y - p[1]) - (p[3] - p[1]) * (x - p[0]);
  if (c(a, b[0], b[1]) * c(a, b[2], b[3]) < 0 && c(b, a[0], a[1]) * c(b, a[2], a[3]) < 0) return 0;
  return Math.min(ptSeg(a[0], a[1], b), ptSeg(a[2], a[3], b), ptSeg(b[0], b[1], a), ptSeg(b[2], b[3], a));
}
/**
 * Physical clearance (m) between two aircraft modelled as a fuselage line (full length) crossed by a
 * wing line (full span). 0 means the airframes touch or overlap.
 */
export function clearanceM(a: Aircraft, b: Aircraft): number {
  let m = Infinity;
  for (const x of bodySegs(a)) for (const y of bodySegs(b)) m = Math.min(m, segSeg(x, y));
  return m;
}
