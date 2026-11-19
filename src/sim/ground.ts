/**
 * Surface movement: route following with braking, hold-short enforcement, give-way logic,
 * pushback, line-up, takeoff roll, landing roll-out / runway exit and gate turnaround.
 */
import type { Aircraft, Airport, GEdge, Runway } from './types';
import { KT, alongCross, angDiff, approach, clamp, dist, hdgOf, norm360, rand, randRange, vecOf } from './util';
import { typeOf } from './data/aircraft';
import { cityOf } from './data/airlines';
import { edgeBetween, endRef, gateByName, holdInfo, otherEnd, runwayById, runwayZoneAt, rwyLateral, segHdg, windComponents } from './airport/query';
import { routeCum } from './pathfind';
import { World, clearRequest, csay, logEvent, radioPilot, setRequest, isAirborne } from './world';
import { sayGate, sayRwy, sayTwy } from './phraseology';

const ACCEL = 0.8; // m/s² taxi acceleration
const DECEL = 1.3; // m/s² comfortable taxi braking

const cumCache = new WeakMap<number[], number[]>();
export function cumOf(ap: Airport, route: number[]): number[] {
  let c = cumCache.get(route);
  if (!c || c.length !== route.length) {
    c = routeCum(ap, route);
    cumCache.set(route, c);
  }
  return c;
}

/** position at distance s along a route */
export function posOnRoute(ap: Airport, route: number[], cum: number[], s: number): { x: number; y: number; hdg: number; i: number } {
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] <= s) i++;
  const a = ap.nodes[route[i]], b = ap.nodes[route[Math.min(i + 1, route.length - 1)]];
  const segLen = cum[i + 1] - cum[i] || 1;
  const f = clamp((s - cum[i]) / segLen, 0, 1);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, hdg: hdgOf(b.x - a.x, b.y - a.y), i };
}

/** current forward-facing segment of a surface aircraft: it is between a and b, d metres past a, facing b */
export function curSeg(ap: Airport, ac: Aircraft): { a: number; b: number; d: number } | undefined {
  if (ac.route.length < 2) return undefined;
  const cum = cumOf(ap, ac.route);
  const { i } = posOnRoute(ap, ac.route, cum, ac.routeS);
  if (ac.reverse) return { a: ac.route[i + 1], b: ac.route[i], d: cum[i + 1] - ac.routeS };
  return { a: ac.route[i], b: ac.route[i + 1], d: ac.routeS - cum[i] };
}

/** install a new forward route starting from the aircraft's current segment */
export function setRoute(ap: Airport, ac: Aircraft, pathFromB: number[], names: string[]) {
  const seg = curSeg(ap, ac);
  if (seg) {
    ac.route = [seg.a, ...pathFromB];
    ac.routeS = seg.d;
  } else {
    ac.route = pathFromB;
    ac.routeS = 0;
  }
  ac.reverse = false;
  ac.routeStop = cumOf(ap, ac.route)[ac.route.length - 1];
  ac.taxiNames = names;
}

export const depRunwayId = (ap: Airport, ac: Aircraft) => endRef(ap, ac.rwy)?.rwy.id;

interface HoldAhead { idx: number; s: number; rwy: string; final: boolean }
/** first holding position ahead on the route that the aircraft is not yet cleared through */
export function nextHoldAhead(w: World, ac: Aircraft, cum: number[]): HoldAhead | undefined {
  const { ap } = w;
  const t = typeOf(ac.type);
  const depId = depRunwayId(ap, ac);
  for (let i = 1; i < ac.route.length; i++) {
    const n = ap.nodes[ac.route[i]];
    if (n.kind !== 'hold' || !n.rwy) continue;
    const stopS = cum[i] - t.length / 2 - 2;
    if (stopS < ac.routeS - 4) continue; // already past the stop bar
    const final = i === ac.route.length - 1;
    if (!final) {
      const r = runwayById(ap, n.rwy)!;
      const nx = ap.nodes[ac.route[i + 1]];
      if (rwyLateral(r, nx.x, nx.y) >= rwyLateral(r, n.x, n.y)) continue; // leaving the runway, not entering
    }
    if (ac.crossCleared.includes(n.rwy)) continue;
    if ((ac.lineUpCleared || ac.takeoffCleared) && n.rwy === depId && !final) continue;
    return { idx: i, s: stopS, rwy: n.rwy, final };
  }
  return undefined;
}

export const MOVING_GROUND: ReadonlySet<string> = new Set(['pushback', 'taxi_out', 'taxi_in', 'lining_up']);
const isRouteMover = (ac: Aircraft) => (MOVING_GROUND.has(ac.phase) || (ac.phase === 'landing_roll' && ac.route.length > 1)) && ac.route.length > 1;

/** body circles used for surface conflict tests: centre (wings), nose, tail */
function circles(ac: Aircraft): [number, number, number][] {
  const t = typeOf(ac.type);
  const [ux, uy] = vecOf(ac.hdg);
  const h = t.length * 0.42;
  return [[ac.x, ac.y, t.span / 2], [ac.x + ux * h, ac.y + uy * h, 4], [ac.x - ux * h, ac.y - uy * h, 6]];
}

export interface GroundLimit { s: number; by: number }

/** Compute give-way / following limits for every route-following aircraft. */
export function computeGroundLimits(w: World): Map<number, GroundLimit> {
  const { ap, s } = w;
  const out = new Map<number, GroundLimit>();
  const surface = s.aircraft.filter((a) => !isAirborne(a) && a.phase !== 'gone');
  const movers = surface.filter(isRouteMover);
  if (!movers.length) return out;
  const assist = s.cfg.difficulty.pilotAssist;
  // precompute samples
  interface Samp { d: number[]; x: number[]; y: number[]; look: number }
  const samples = new Map<number, Samp>();
  for (const a of movers) {
    const t = typeOf(a.type);
    const cum = cumOf(ap, a.route);
    const v = a.gs * KT;
    const look = (v * v) / (2 * DECEL) + t.length / 2 + 60;
    const hold = nextHoldAhead(w, a, cum);
    const cap = Math.min(a.routeStop, hold ? hold.s : Infinity, cum[cum.length - 1]);
    const sm: Samp = { d: [], x: [], y: [], look };
    for (let d = 0; d <= look; d += 10) {
      // samples beyond the aircraft's own clearance limit are not part of its intended path
      if (a.routeS + d > cap + t.length / 2 + 4 && d > 0) break;
      const p = posOnRoute(ap, a.route, cum, a.routeS + d);
      sm.d.push(d); sm.x.push(p.x); sm.y.push(p.y);
    }
    samples.set(a.id, sm);
  }
  for (const a of movers) {
    const ta = typeOf(a.type);
    const sa = samples.get(a.id)!;
    let lim = Infinity, by = -1;
    const va = Math.max(a.gs * KT, 3);
    for (const b of surface) {
      if (b.id === a.id) continue;
      if ((b.phase === 'takeoff_roll' || (b.phase === 'landing_roll' && b.route.length < 2)) && b.gs > 30) continue;
      const tb = typeOf(b.type);
      const gap = dist(a.x, a.y, b.x, b.y);
      if (gap > sa.look + 160) continue;
      // 1. physical body in my path
      const cs = circles(b);
      let hit = -1;
      for (let i = 0; i < sa.d.length && hit < 0; i++) {
        for (const [cx, cy, cr] of cs) {
          if (dist(sa.x[i], sa.y[i], cx, cy) < ta.span / 2 + cr + 2) { hit = i; break; }
        }
      }
      if (hit === 0) {
        // already overlapping the protected zone: only stop if the other aircraft is ahead of us
        const [al] = alongCross(b.x, b.y, a.x, a.y, a.reverse ? norm360(a.hdg + 180) : a.hdg);
        if (al > 2) { if (a.routeS < lim) { lim = a.routeS; by = b.id; } }
        continue;
      }
      if (hit > 0) {
        const l = a.routeS + sa.d[hit] - 10;
        if (l < lim) { lim = l; by = b.id; }
        continue;
      }
      // 2. intended paths cross: the later arrival gives way (pilots see-and-avoid)
      const sb = samples.get(b.id);
      if (!sb || (!assist && s.weather.visSM < 0.5)) continue;
      const vb = Math.max(b.gs * KT, 3);
      const need = (ta.span + tb.span) / 2 + 2;
      let found = false;
      for (let i = 1; i < sa.d.length && !found; i++) {
        for (let j = 1; j < sb.d.length; j++) {
          if (dist(sa.x[i], sa.y[i], sb.x[j], sb.y[j]) < need) {
            const tA = sa.d[i] / va, tB = sb.d[j] / vb;
            if (tA > tB + 0.01 || (Math.abs(tA - tB) <= 0.01 && a.id > b.id)) {
              const l = a.routeS + sa.d[i - 1] - 5;
              if (l < lim) { lim = l; by = b.id; }
            }
            found = true;
            break;
          }
        }
      }
    }
    if (by >= 0) out.set(a.id, { s: lim, by });
  }
  return out;
}

/** true when a runway is "hot": an aircraft is rolling on it or on short final to it */
export function runwayHot(w: World, r: Runway, except?: Aircraft): Aircraft | undefined {
  for (const o of w.s.aircraft) {
    if (o === except) continue;
    const e = endRef(w.ap, o.rwy);
    if (!e || e.rwy.id !== r.id) continue;
    if (o.phase === 'takeoff_roll') return o;
    if (o.phase === 'landing_roll' && o.route.length < 2 && o.gs > 25) return o;
    if (o.phase === 'lined_up' && o.takeoffCleared) return o;
    if (o.phase === 'final' || o.phase === 'approach') {
      const d = dist(o.x, o.y, e.end.x, e.end.y);
      if (d < 2.2 * 1852 && o.alt < 1500) return o;
    }
  }
  return undefined;
}

/** surface aircraft physically inside a runway's protected area */
export function runwayOccupants(w: World, r: Runway, except?: Aircraft): Aircraft[] {
  return w.s.aircraft.filter((o) => o !== except && !isAirborne(o) && o.phase !== 'gone' && o.phase !== 'parked' && runwayZoneAt(w.ap, o.x, o.y)?.id === r.id);
}

function taxiSpeedLimit(w: World, ac: Aircraft, e: GEdge | undefined): number {
  const t = typeOf(ac.type);
  const wx = w.s.weather;
  let v = t.taxiKt;
  if (!e || e.kind === 'apron' || e.kind === 'gate') v = Math.min(v, e?.kind === 'gate' ? 7 : 12);
  if (wx.visSM < 0.5) v *= 0.6;
  else if (wx.surface === 'snow' || wx.surface === 'ice') v *= 0.75;
  return v * KT;
}

/**
 * Advance an aircraft along its route. Returns 'limit' when it is stopped at its clearance limit,
 * 'hold' when stopped at an uncleared holding position, 'traffic' when giving way, else 'moving'.
 */
export function followRoute(w: World, ac: Aircraft, dt: number, limits: Map<number, GroundLimit>): 'moving' | 'limit' | 'hold' | 'traffic' | 'held' {
  const { ap } = w;
  const t = typeOf(ac.type);
  const cum = cumOf(ap, ac.route);
  const end = cum[cum.length - 1];
  let limit = Math.min(ac.routeStop, end);
  let reason: 'limit' | 'hold' | 'traffic' | 'held' = 'limit';
  let holdRwy: string | undefined;
  if (!ac.reverse) {
    const h = nextHoldAhead(w, ac, cum);
    if (h && h.s < limit) {
      limit = h.s;
      reason = h.final ? 'limit' : 'hold';
      holdRwy = h.rwy;
      // crossing clearance held but runway is hot: pilots wait (when they can see it / are assisted)
    }
  }
  const gl = limits.get(ac.id);
  if (gl && gl.s < limit) {
    limit = gl.s;
    reason = 'traffic';
  }
  if (ac.holdPos) {
    limit = Math.min(limit, ac.routeS);
    reason = 'held';
  }
  let v = ac.gs * KT;
  const pos0 = posOnRoute(ap, ac.route, cum, ac.routeS);
  const e = edgeBetween(ap, ac.route[pos0.i], ac.route[pos0.i + 1]);
  let vmax = ac.reverse ? (ac.flags.tow ? 2.2 : 1.9) : taxiSpeedLimit(w, ac, e);
  if (ac.phase === 'landing_roll') vmax = Math.max(vmax, Math.min(v, 23));
  if (e?.kind === 'runway' && !ac.reverse) vmax = Math.max(vmax, 15 * KT);
  // slow for the next corner
  if (!ac.reverse && pos0.i + 2 < ac.route.length) {
    const turn = Math.abs(angDiff(pos0.hdg, segHdg(ap, ac.route[pos0.i + 1], ac.route[pos0.i + 2])));
    if (turn > 25) {
      const vc = turn > 60 ? 4.5 : 7;
      const dToCorner = cum[pos0.i + 1] - ac.routeS;
      vmax = Math.min(vmax, Math.sqrt(vc * vc + 2 * DECEL * Math.max(0, dToCorner - 3)));
    }
  }
  const remaining = limit - ac.routeS;
  const vBrake = remaining > 0.3 ? Math.sqrt(2 * DECEL * remaining) : 0;
  const target = Math.min(vmax, vBrake);
  v = v < target ? Math.min(target, v + ACCEL * dt) : Math.max(target, v - (ac.phase === 'landing_roll' ? 2.2 : DECEL * 1.6) * dt);
  if (remaining <= 0.3) v = 0;
  ac.routeS = Math.min(ac.routeS + v * dt, Math.max(limit, ac.routeS));
  const p = posOnRoute(ap, ac.route, cum, ac.routeS);
  ac.x = p.x;
  ac.y = p.y;
  const want = ac.reverse ? norm360(p.hdg + 180) : p.hdg;
  if (v > 0.2) {
    const maxTurn = (ac.reverse ? 10 : 28) * dt;
    ac.hdg = norm360(ac.hdg + clamp(angDiff(ac.hdg, want), -maxTurn, maxTurn));
  }
  ac.gs = v / KT;
  ac.ias = ac.gs;
  ac.track = ac.reverse ? norm360(ac.hdg + 180) : ac.hdg;
  ac.vs = 0;

  // runway crossing clearance bookkeeping
  const zone = runwayZoneAt(ap, ac.x, ac.y);
  if (zone) ac.flags['in:' + zone.id] = 1;
  for (const id of ac.crossCleared.slice()) {
    if (ac.flags['in:' + id] && zone?.id !== id) {
      const r = runwayById(ap, id)!;
      if (rwyLateral(r, ac.x, ac.y) > ap.holdDist + t.length / 2 - 4) {
        ac.crossCleared = ac.crossCleared.filter((c) => c !== id);
        delete ac.flags['in:' + id];
      }
    }
  }

  if (v > 0.05) {
    ac.blockedBy = undefined;
    ac.blockedSince = undefined;
    return 'moving';
  }
  if (reason === 'traffic') {
    if (ac.blockedBy !== gl!.by) { ac.blockedBy = gl!.by; ac.blockedSince = w.s.t; }
  } else {
    ac.blockedBy = undefined;
    ac.blockedSince = undefined;
  }
  if (reason === 'hold' && holdRwy) ac.flags.holdAt = 1;
  if (reason === 'limit' && ac.routeS < Math.min(ac.routeStop, end) - 1 && !holdRwy) return 'moving';
  return reason;
}

// ───────────────────────── pushback ─────────────────────────

/** Build the tail-first pushback path for a parked aircraft. */
export function pushbackRoute(w: World, ac: Aircraft, face?: 'N' | 'E' | 'S' | 'W', towardNode?: number): number[] | undefined {
  const { ap } = w;
  const g = gateByName(ap, ac.gate);
  if (!g) return undefined;
  const t = typeOf(ac.type);
  const options: number[] = [];
  for (const eid of ap.adj[g.lane]) {
    const e = ap.edges[eid];
    if (e.kind === 'gate') continue;
    options.push(otherEnd(e, g.lane));
  }
  if (!options.length) return undefined;
  // the tail travels toward `first`; the nose then faces the opposite way
  let first = options[0];
  if (face) {
    const want = { N: 0, E: 90, S: 180, W: 270 }[face];
    let best = 1e9;
    for (const o of options) {
      const d = Math.abs(angDiff(norm360(segHdg(ap, g.lane, o) + 180), want));
      if (d < best) { best = d; first = o; }
    }
  } else if (towardNode !== undefined && options.length > 1) {
    // face toward the target: push the tail toward the option farthest from it
    let best = -1;
    for (const o of options) {
      const d = dist(ap.nodes[o].x, ap.nodes[o].y, ap.nodes[towardNode].x, ap.nodes[towardNode].y);
      if (d > best) { best = d; first = o; }
    }
  }
  const route = [g.node, g.lane, first];
  let need = t.length / 2 + 26 - dist(ap.nodes[g.lane].x, ap.nodes[g.lane].y, ap.nodes[first].x, ap.nodes[first].y);
  let guard = 0;
  while (need > 0 && guard++ < 8) {
    const prev = route[route.length - 2], cur = route[route.length - 1];
    const h = segHdg(ap, prev, cur);
    let nxt = -1, bestTurn = 50;
    for (const eid of ap.adj[cur]) {
      const e = ap.edges[eid];
      if (e.kind === 'gate' || e.kind === 'runway') continue;
      const v = otherEnd(e, cur);
      if (v === prev) continue;
      const turn = Math.abs(angDiff(h, segHdg(ap, cur, v)));
      if (turn < bestTurn) { bestTurn = turn; nxt = v; }
    }
    if (nxt < 0) break;
    need -= dist(ap.nodes[cur].x, ap.nodes[cur].y, ap.nodes[nxt].x, ap.nodes[nxt].y);
    route.push(nxt);
  }
  return route;
}

export function startPushback(w: World, ac: Aircraft, route: number[]) {
  const { ap } = w;
  const t = typeOf(ac.type);
  const cum = cumOf(ap, route);
  ac.route = route;
  ac.routeS = 0;
  ac.routeStop = Math.min(cum[cum.length - 1], cum[1] + t.length / 2 + 26);
  ac.reverse = true;
  ac.phase = 'pushback';
  ac.turn = undefined;
  ac.taxiStart = w.s.t;
  logEvent(w, 'pushback', 'info', `${ac.callsign} pushing back from gate ${ac.gate}`, [ac]);
}

/** convert a finished reverse movement into a forward-facing stationary segment */
function finishReverse(ap: Airport, ac: Aircraft) {
  const seg = curSeg(ap, ac);
  if (seg) {
    ac.route = [seg.a, seg.b];
    ac.routeS = seg.d;
    ac.routeStop = seg.d;
  }
  ac.reverse = false;
  delete ac.flags.tow;
}

/** tow an aircraft backwards along its route to the previous junction (deadlock recovery) */
export function startTow(w: World, ac: Aircraft): boolean {
  const { ap } = w;
  const seg = curSeg(ap, ac);
  if (!seg) return false;
  const route = [seg.b, seg.a];
  let total = seg.d;
  let guard = 0;
  while (guard++ < 30) {
    const prev = route[route.length - 2], cur = route[route.length - 1];
    const branches = ap.adj[cur].filter((eid) => ap.edges[eid].kind !== 'gate').length;
    if (total > 70 && branches >= 3) break;
    if (total > 320) break;
    const h = segHdg(ap, prev, cur);
    let nxt = -1, bestTurn = 70;
    for (const eid of ap.adj[cur]) {
      const e = ap.edges[eid];
      if (e.kind === 'gate') continue;
      const v = otherEnd(e, cur);
      if (v === prev) continue;
      if (ap.nodes[v].kind === 'rwy' || ap.nodes[cur].kind === 'hold') continue;
      const turn = Math.abs(angDiff(h, segHdg(ap, cur, v)));
      if (turn < bestTurn) { bestTurn = turn; nxt = v; }
    }
    if (nxt < 0) break;
    total += dist(ap.nodes[cur].x, ap.nodes[cur].y, ap.nodes[nxt].x, ap.nodes[nxt].y);
    route.push(nxt);
  }
  if (total < 15) return false;
  const full = dist(ap.nodes[seg.a].x, ap.nodes[seg.a].y, ap.nodes[seg.b].x, ap.nodes[seg.b].y);
  ac.route = route;
  ac.routeS = full - seg.d;
  ac.routeStop = cumOf(ap, route)[route.length - 1];
  ac.reverse = true;
  ac.flags.tow = 1;
  ac.holdPos = false;
  if (ac.phase === 'push_done' || ac.phase === 'holding_short' || ac.phase === 'vacated') ac.flags.towFrom = 1;
  return true;
}

// ───────────────────────── turnaround ─────────────────────────

const STAGES = ['deboarding', 'unloading', 'servicing', 'boarding'] as const;
const STAGE_FRAC = [0.2, 0.15, 0.33, 0.32];

export function turnaroundDuration(w: World, ac: Aircraft): number {
  const t = typeOf(ac.type);
  const base = t.size === 'XL' ? 840 : t.size === 'L' ? 700 : t.size === 'M' ? 440 : 340;
  const scale = w.s.cfg.mode === 'realism' ? 1.6 : 1;
  return base * scale * randRange(w.s, 0.85, 1.25);
}

export function beginTurnaround(w: World, ac: Aircraft, total: number, elapsed = 0) {
  ac.turn = { stage: 'deboarding', stageEnd: 0, readyAt: w.s.t + total - elapsed, progress: 0 };
  ac.flags.turnTotal = total;
  ac.flags.turnStart = w.s.t - elapsed;
  if (ac.nextLeg) ac.nextLeg.sched = w.s.t + total - elapsed + 120;
}

function updateParked(w: World, ac: Aircraft) {
  const { s, ap } = w;
  const turn = ac.turn;
  if (turn && turn.stage !== 'ready') {
    const total = ac.flags.turnTotal || 400;
    let p = clamp((s.t - (ac.flags.turnStart ?? s.t)) / total, 0, 1);
    turn.progress = p;
    if (p >= 1) {
      const needDeice = s.weather.precip === 'snow' || s.weather.surface === 'ice';
      if (needDeice && !ac.flags.deiced) {
        if (turn.stage !== 'deicing') {
          turn.stage = 'deicing';
          turn.stageEnd = s.t + 150 + rand(s) * 90;
          logEvent(w, 'weather', 'info', `${ac.callsign} de-icing at gate ${ac.gate}`, [ac]);
        } else if (s.t >= turn.stageEnd) ac.flags.deiced = 1;
        return;
      }
      turn.stage = 'ready';
      // become the outbound flight
      if (ac.nextLeg) {
        ac.callsign = ac.nextLeg.callsign;
        ac.kind = 'departure';
        ac.origin = ap.iata;
        ac.dest = ac.nextLeg.dest;
        ac.sched = ac.nextLeg.sched;
        ac.est = Math.max(ac.sched, s.t);
        ac.nextLeg = undefined;
        ac.depCleared = ac.pushApproved = ac.lineUpCleared = ac.takeoffCleared = false;
        ac.apprCleared = ac.landCleared = ac.established = false;
        ac.rwy = undefined;
        ac.actual = undefined;
        ac.delay = 0;
        ac.fuel = typeOf(ac.type).fuelBurnKgMin * randRange(s, 150, 320);
        s.stats.demand++;
      }
      return;
    }
    let acc = 0;
    for (let i = 0; i < STAGES.length; i++) {
      acc += STAGE_FRAC[i];
      if (p < acc) { turn.stage = STAGES[i]; break; }
    }
    return;
  }
  if (ac.kind !== 'departure') return;
  if (ac.emergency && !ac.emergency.resolved) return;
  ac.delay = Math.max(0, s.t - ac.sched);
  if (!ac.depCleared) {
    if (!ac.request && !ac.flags.pending) {
      setRequest(w, ac, 'clearance', `${ap.facility} Clearance, ${csay(ac)}, gate ${sayGate(ac.gate ?? '')}, IFR to ${cityOf(ac.dest)}, information ${s.atis}, ready to copy.`);
    }
  } else if (!ac.pushApproved) {
    if (!ac.request && !ac.flags.pending && s.t >= (ac.flags.pushReqAt ?? 0)) {
      setRequest(w, ac, 'pushback', `${ap.facility} Ground, ${csay(ac)}, gate ${sayGate(ac.gate ?? '')}, ready for pushback.`);
    }
  }
}

// ───────────────────────── runway rolls ─────────────────────────

function braking(w: World, ac: Aircraft): number {
  const sf = w.s.weather.surface;
  let d = sf === 'dry' ? 2.1 : sf === 'wet' ? 1.6 : sf === 'snow' ? 1.25 : 0.95;
  const em = ac.emergency && !ac.emergency.resolved ? ac.emergency.kind : undefined;
  if (em === 'brake_failure') d *= 0.4;
  if (em === 'hydraulic') d *= 0.6;
  return d;
}

/** emergencies after which the aircraft cannot vacate the runway under its own power */
const STOPS_ON_RUNWAY = new Set(['gear', 'hydraulic', 'brake_failure', 'tire_failure', 'dual_engine_failure']);

function updateLandingRoll(w: World, ac: Aircraft, dt: number, limits: Map<number, GroundLimit>) {
  const { ap, s } = w;
  const t = typeOf(ac.type);
  if (ac.route.length > 1) {
    // vacating via an exit
    const st = followRoute(w, ac, dt, limits);
    if (st === 'limit' || (st !== 'moving' && ac.gs < 0.1 && !runwayZoneAt(ap, ac.x, ac.y))) {
      if (st !== 'limit' && st !== 'held') return; // waiting for traffic while clear – keep trying to reach the stop point
      vacated(w, ac);
    }
    return;
  }
  const e = endRef(ap, ac.rwy)!;
  const [ux, uy] = vecOf(e.end.hdg);
  const dec = braking(w, ac);
  let v = ac.gs * KT;
  const along = ac.rwyDist ?? 0;
  const em = ac.emergency && !ac.emergency.resolved ? ac.emergency.kind : undefined;
  const stuck = (em && STOPS_ON_RUNWAY.has(em)) || ac.flags.stopOnRwy;

  // choose exit
  let target: { node: number; next: number; d: number; vExit: number } | undefined;
  if (!stuck) {
    const gate = gateByName(ap, ac.gate);
    let tx = 0, ty = 0;
    if (gate) { tx = ap.nodes[gate.node].x; ty = ap.nodes[gate.node].y; }
    else { for (const g of ap.gates) { tx += ap.nodes[g.node].x / ap.gates.length; ty += ap.nodes[g.node].y / ap.gates.length; } }
    const nodes = e.idx === 0 ? e.rwy.nodes : [...e.rwy.nodes].reverse();
    let prefFound = false;
    for (const nid of nodes) {
      const n = ap.nodes[nid];
      const d = alongCross(n.x, n.y, e.end.x, e.end.y, e.end.hdg)[0] - along;
      if (d < -0.5) continue;
      let best: { next: number; vExit: number; score: number; name: string } | undefined;
      for (const eid of ap.adj[nid]) {
        const ed = ap.edges[eid];
        if (ed.kind === 'runway' || s.closedEdges.includes(eid)) continue;
        const v2 = otherEnd(ed, nid);
        if (ap.nodes[v2].kind === 'rwy') continue;
        const ang = Math.abs(angDiff(e.end.hdg, segHdg(ap, nid, v2)));
        if (ang > 100) continue;
        const vExit = ang <= 50 ? 22 : 7;
        const score = dist(ap.nodes[v2].x, ap.nodes[v2].y, tx, ty) - (ac.exitPref && ed.name === ac.exitPref ? 1e6 : 0);
        if (!best || score < best.score) best = { next: v2, vExit, score, name: ed.name };
      }
      if (!best) continue;
      const need = v > best.vExit + 0.6 ? (v * v - best.vExit * best.vExit) / (2 * dec) : 0;
      if (need > d) continue;
      const isPref = !!ac.exitPref && best.name === ac.exitPref;
      if (!target || (isPref && !prefFound)) {
        target = { node: nid, next: best.next, d, vExit: best.vExit };
        if (isPref) prefFound = true;
        if (!ac.exitPref) break;
      }
      if (prefFound) break;
    }
  }
  let vAllowed: number;
  if (target) vAllowed = Math.sqrt(target.vExit * target.vExit + 2 * dec * 0.55 * Math.max(0, target.d - 4));
  else {
    const remain = e.rwy.length - along - 60;
    vAllowed = stuck ? 0 : Math.sqrt(2 * dec * 0.8 * Math.max(0, remain));
  }
  if (v > vAllowed) v = Math.max(vAllowed, v - dec * dt);
  else if (target && v < Math.min(vAllowed, 26)) v = Math.min(vAllowed, 26, v + 0.6 * dt);
  const step = v * dt;
  ac.rwyDist = along + step;
  ac.x += ux * step;
  ac.y += uy * step;
  ac.hdg = e.end.hdg;
  ac.track = ac.hdg;
  ac.gs = v / KT;
  ac.ias = ac.gs;
  ac.alt = 0;
  ac.vs = 0;

  if (target && target.d - step <= Math.max(2.5, step)) {
    const tn = ap.nodes[target.node];
    ac.x = tn.x; ac.y = tn.y;
    // turn off: follow the exit until the tail is clear of the holding position
    const route = [target.node, target.next];
    let holdIdx = ap.nodes[target.next].kind === 'hold' && ap.nodes[target.next].rwy === e.rwy.id ? 1 : -1;
    let guard = 0;
    while (guard++ < 12) {
      const prev = route[route.length - 2], cur = route[route.length - 1];
      if (holdIdx >= 0 && route.length - 1 > holdIdx) break;
      const h = segHdg(ap, prev, cur);
      let nxt = -1, bestTurn = 100;
      for (const eid of ap.adj[cur]) {
        const ed = ap.edges[eid];
        if (ed.kind === 'gate' || ed.kind === 'runway') continue;
        const v2 = otherEnd(ed, cur);
        if (v2 === prev || ap.nodes[v2].kind === 'rwy') continue;
        // keep moving away from the runway
        if (holdIdx < 0 && rwyLateral(e.rwy, ap.nodes[v2].x, ap.nodes[v2].y) < rwyLateral(e.rwy, ap.nodes[cur].x, ap.nodes[cur].y) - 1) continue;
        const turn = Math.abs(angDiff(h, segHdg(ap, cur, v2)));
        if (turn < bestTurn) { bestTurn = turn; nxt = v2; }
      }
      if (nxt < 0) break;
      route.push(nxt);
      if (holdIdx < 0 && ap.nodes[nxt].kind === 'hold' && ap.nodes[nxt].rwy === e.rwy.id) holdIdx = route.length - 1;
    }
    const cum = cumOf(ap, route);
    ac.route = route;
    ac.routeS = 0;
    ac.reverse = false;
    const endS = cum[cum.length - 1];
    ac.routeStop = holdIdx >= 0 ? Math.min(endS, cum[holdIdx] + t.length / 2 + 8) : endS;
    const ed = edgeBetween(ap, route[0], route[1]);
    ac.flags.exitName = 0;
    ac.taxiNames = ed?.name ? [ed.name] : [];
    return;
  }
  if (v < 0.1) {
    if (stuck) {
      ac.phase = 'disabled';
      ac.gs = 0;
      const blockFor = ac.emergency?.blockFor ?? 600;
      ac.flags.disabledUntil = s.t + blockFor;
      logEvent(w, 'emergency', 'critical', `${ac.callsign} is disabled on runway ${ac.rwy} – runway blocked until the aircraft is removed (~${Math.round(blockFor / 60)} min)`, [ac]);
      radioPilot(w, ac, `${csay(ac)} is stopped on the runway, unable to taxi, request tow and emergency equipment.`, true);
      clearRequest(ac);
    } else {
      // no usable exit: stopped on the runway awaiting instructions
      ac.route = [];
      vacated(w, ac, true);
    }
  }
}

function vacated(w: World, ac: Aircraft, onRunway = false) {
  const { ap, s } = w;
  const wasRto = !!ac.flags.rto;
  ac.phase = 'vacated';
  ac.gs = 0;
  ac.landCleared = ac.apprCleared = ac.established = false;
  ac.takeoffCleared = ac.lineUpCleared = false;
  ac.lastRwy = ac.rwy;
  ac.taxiStart = s.t;
  const where = ac.taxiNames[0] ? ` at ${sayTwy(ac.taxiNames[0])}` : '';
  if (wasRto) {
    delete ac.flags.rto;
    setRequest(w, ac, 'taxi', `${ap.facility} Ground, ${csay(ac)}, ${onRunway ? `stopped on runway ${sayRwy(ac.rwy ?? '')}` : `clear of runway ${sayRwy(ac.rwy ?? '')}${where}`} after rejected takeoff, request taxi instructions.`);
  } else {
    setRequest(w, ac, 'taxi_in', `${ap.facility} Ground, ${csay(ac)}, ${onRunway ? `stopped on runway ${sayRwy(ac.rwy ?? '')}, no exit available` : `clear of runway ${sayRwy(ac.rwy ?? '')}${where}`}, request taxi to the gate.`);
  }
}

function updateTakeoffRoll(w: World, ac: Aircraft, dt: number) {
  const { ap, s } = w;
  const t = typeOf(ac.type);
  const e = endRef(ap, ac.rwy)!;
  const [ux, uy] = vecOf(e.end.hdg);
  const { head } = windComponents(e.end.hdg, s.weather.windDir, s.weather.windKt);
  let v = ac.gs * KT;
  // pilot safety action: reject the takeoff for an obstruction ahead while below V1
  const v1 = (t.vr - 12) * KT;
  if (v < v1) {
    const visRange = s.weather.visSM * 1609;
    for (const o of s.aircraft) {
      if (o === ac || isAirborne(o) || o.phase === 'gone' || o.phase === 'parked') continue;
      const [al, cr] = alongCross(o.x, o.y, ac.x, ac.y, e.end.hdg);
      if (al > 30 && al < Math.min(2600, visRange) && Math.abs(cr) < 42) {
        rejectTakeoff(w, ac, `traffic on the runway`);
        s.stats.pilotGoArounds += 0;
        return;
      }
    }
  }
  let acc = t.accelGround;
  if (ac.emergency && !ac.emergency.resolved && ac.emergency.kind === 'engine_failure') acc *= t.engines > 2 ? 0.7 : 0.45;
  v += acc * dt;
  ac.x += ux * v * dt;
  ac.y += uy * v * dt;
  ac.rwyDist = (ac.rwyDist ?? 0) + v * dt;
  ac.hdg = e.end.hdg;
  ac.track = ac.hdg;
  ac.gs = v / KT;
  ac.ias = ac.gs + head;
  if (ac.ias >= t.vr) {
    ac.phase = 'departure';
    ac.alt = 5;
    ac.vs = 1200;
    ac.latMode = ac.fix && ac.flags.depDirect ? 'fix' : 'hdg';
    ac.tgtHdg = ac.flags.depHdg ? ac.flags.depHdg % 360 : e.end.hdg;
    ac.airborneAt = s.t;
    ac.actual = s.t;
    ac.route = [];
    ac.takeoffCleared = ac.lineUpCleared = false;
    ac.crossCleared = [];
    s.rwy[e.rwy.id].movements++;
    s.stats.departed++;
    s.stats.depDelaySum += Math.max(0, s.t - ac.sched);
    s.stats.depDelayN++;
    if (ac.taxiStart !== undefined && ac.taxiIdeal) {
      s.stats.taxiActualSum += s.t - ac.taxiStart;
      s.stats.taxiIdealSum += ac.taxiIdeal;
    }
    logEvent(w, 'takeoff', 'info', `${ac.callsign} airborne runway ${ac.rwy}`, [ac]);
  }
}

export function rejectTakeoff(w: World, ac: Aircraft, why: string) {
  ac.phase = 'landing_roll';
  ac.route = [];
  ac.takeoffCleared = false;
  ac.lineUpCleared = false;
  ac.flags.rto = 1;
  radioPilot(w, ac, `${csay(ac)} rejecting takeoff, ${why}.`, true);
  logEvent(w, 'pilot_action', 'warning', `${ac.callsign} rejected takeoff on runway ${ac.rwy}: ${why}`, [ac]);
}

/** start the line-up movement from the holding position */
export function startLineUp(w: World, ac: Aircraft): boolean {
  const { ap } = w;
  const seg = curSeg(ap, ac);
  if (!seg) return false;
  const hi = holdInfo(ap, seg.b);
  if (!hi) return false;
  ac.route = [seg.a, ...hi.path];
  ac.routeS = seg.d;
  ac.routeStop = cumOf(ap, ac.route)[ac.route.length - 1];
  ac.phase = 'lining_up';
  ac.holdPos = false;
  clearRequest(ac, 'takeoff');
  return true;
}

// ───────────────────────── per-step update ─────────────────────────

export function updateGround(w: World, ac: Aircraft, dt: number, limits: Map<number, GroundLimit>) {
  const { ap, s } = w;
  const t = typeOf(ac.type);
  switch (ac.phase) {
    case 'parked':
      updateParked(w, ac);
      break;
    case 'pushback': {
      const st = followRoute(w, ac, dt, limits);
      const g = gateByName(ap, ac.gate);
      if (st === 'limit') {
        if (ac.flags.tow) { finishReverse(ap, ac); break; }
        finishReverse(ap, ac);
        ac.phase = 'push_done';
        ac.gate = undefined;
        setRequest(w, ac, 'taxi', `${ap.facility} Ground, ${csay(ac)}, pushback complete, ready to taxi.`);
      } else if (g && dist(ac.x, ac.y, ap.nodes[g.node].x, ap.nodes[g.node].y) > 30) {
        // stand is free again once the aircraft is clear of it
        ac.flags.offGate = 1;
      }
      break;
    }
    case 'push_done':
    case 'vacated':
      if (ac.reverse && ac.route.length > 1) {
        if (followRoute(w, ac, dt, limits) === 'limit') finishReverse(ap, ac);
      } else ac.gs = 0;
      if (ac.phase === 'vacated' && ac.kind === 'arrival') ac.delay = Math.max(0, s.t - ac.sched);
      break;
    case 'taxi_out': {
      if (ac.reverse) { if (followRoute(w, ac, dt, limits) === 'limit') { finishReverse(ap, ac); ac.holdPos = true; } break; }
      const st = followRoute(w, ac, dt, limits);
      ac.delay = Math.max(0, s.t - ac.sched);
      if (st === 'limit') {
        const last = ap.nodes[ac.route[ac.route.length - 1]];
        const cum = cumOf(ap, ac.route);
        const atEnd = ac.routeS >= cum[cum.length - 1] - t.length / 2 - 4;
        if (atEnd && last.kind === 'hold' && last.rwy === depRunwayId(ap, ac)) {
          if (ac.lineUpCleared || ac.takeoffCleared) startLineUp(w, ac);
          else {
            ac.phase = 'holding_short';
            const full = holdInfo(ap, last.id);
            const e = endRef(ap, ac.rwy)!;
            const tora = full ? (e.idx === 0 ? e.rwy.length - full.along : full.along) : e.rwy.length;
            const inter = tora < e.rwy.length - 200 && ac.taxiNames.length ? ` at ${sayTwy(ac.taxiNames[ac.taxiNames.length - 1])}` : '';
            setRequest(w, ac, 'takeoff', `${ap.facility} Tower, ${csay(ac)}, holding short runway ${sayRwy(ac.rwy ?? '')}${inter}, ready for departure.`);
          }
        } else if (!ac.request) {
          setRequest(w, ac, 'taxi', `${ap.facility} Ground, ${csay(ac)}, holding at clearance limit, request further taxi.`);
        }
      } else if (st === 'hold') {
        const h = nextHoldAhead(w, ac, cumOf(ap, ac.route));
        if (h) {
          const r = runwayById(ap, h.rwy)!;
          setRequest(w, ac, 'crossing', `${ap.facility} Ground, ${csay(ac)}, holding short runway ${sayRwy(r.ends[0].name)}, request crossing.`, h.rwy);
        }
      }
      break;
    }
    case 'taxi_in': {
      if (ac.reverse) { if (followRoute(w, ac, dt, limits) === 'limit') { finishReverse(ap, ac); ac.holdPos = true; } break; }
      const st = followRoute(w, ac, dt, limits);
      ac.delay = Math.max(0, s.t - ac.sched);
      if (st === 'limit') {
        const g = gateByName(ap, ac.gate);
        const last = ac.route[ac.route.length - 1];
        const cum = cumOf(ap, ac.route);
        if (g && last === g.node && ac.routeS >= cum[cum.length - 1] - 1) {
          ac.phase = 'parked';
          ac.hdg = g.hdg;
          ac.route = [];
          ac.gs = 0;
          ac.actual = s.t;
          ac.crossCleared = [];
          clearRequest(ac);
          s.stats.parked++;
          s.stats.arrDelaySum += Math.max(0, s.t - ac.sched);
          s.stats.arrDelayN++;
          if (ac.taxiStart !== undefined && ac.taxiIdeal) {
            s.stats.taxiActualSum += s.t - ac.taxiStart;
            s.stats.taxiIdealSum += ac.taxiIdeal;
          }
          beginTurnaround(w, ac, turnaroundDuration(w, ac));
          if (ac.emergency && !ac.emergency.resolved && (ac.emergency.kind === 'medical' || ac.emergency.kind === 'crew_medical' || ac.emergency.kind === 'engine_failure' || ac.emergency.kind === 'min_fuel' || ac.emergency.kind === 'fuel_emergency' || ac.emergency.kind === 'electrical' || ac.emergency.kind === 'flight_control' || ac.emergency.kind === 'turbulence')) {
            ac.emergency.resolved = s.t;
            s.stats.emergenciesHandled++;
            s.stats.emergencyRespSum += s.t - ac.emergency.since;
            logEvent(w, 'emergency', 'advisory', `${ac.callsign} emergency resolved – aircraft on stand ${ac.gate} after ${Math.round((s.t - ac.emergency.since) / 60)} min`, [ac]);
            if (ac.emergency.kind === 'engine_failure' || ac.emergency.kind === 'flight_control' || ac.emergency.kind === 'electrical') ac.flags.turnTotal = (ac.flags.turnTotal ?? 400) + 900;
          }
          logEvent(w, 'gate', 'info', `${ac.callsign} on stand ${ac.gate}`, [ac]);
        } else if (!ac.request) {
          setRequest(w, ac, 'taxi_in', `${ap.facility} Ground, ${csay(ac)}, holding at clearance limit, request further taxi.`);
        }
      } else if (st === 'hold') {
        const h = nextHoldAhead(w, ac, cumOf(ap, ac.route));
        if (h) {
          const r = runwayById(ap, h.rwy)!;
          setRequest(w, ac, 'crossing', `${ap.facility} Ground, ${csay(ac)}, holding short runway ${sayRwy(r.ends[0].name)}, request crossing.`, h.rwy);
        }
      }
      break;
    }
    case 'holding_short':
      ac.gs = 0;
      ac.delay = Math.max(0, s.t - ac.sched);
      if (ac.lineUpCleared || ac.takeoffCleared) startLineUp(w, ac);
      break;
    case 'lining_up': {
      const st = followRoute(w, ac, dt, limits);
      if (st === 'limit') {
        const e = endRef(ap, ac.rwy)!;
        ac.phase = 'lined_up';
        ac.rwyDist = alongCross(ac.x, ac.y, e.end.x, e.end.y, e.end.hdg)[0];
        ac.route = [];
        ac.flags.rollAt = 0;
      }
      break;
    }
    case 'lined_up': {
      const e = endRef(ap, ac.rwy)!;
      const d = angDiff(ac.hdg, e.end.hdg);
      ac.hdg = norm360(ac.hdg + clamp(d, -14 * dt, 14 * dt));
      ac.gs = 0;
      ac.delay = Math.max(0, s.t - ac.sched);
      if (ac.takeoffCleared && Math.abs(d) < 1.5) {
        if (!ac.flags.rollAt) ac.flags.rollAt = s.t + 3;
        else if (s.t >= ac.flags.rollAt) {
          ac.phase = 'takeoff_roll';
          const st = s.rwy[e.rwy.id];
          ac.flags.rollStart = s.t;
          st.lastDep[e.end.name] = { t: s.t, wake: t.wake, ac: ac.id };
          clearRequest(ac);
        }
      } else if (!ac.takeoffCleared) ac.flags.rollAt = 0;
      break;
    }
    case 'takeoff_roll':
      updateTakeoffRoll(w, ac, dt);
      break;
    case 'landing_roll':
      updateLandingRoll(w, ac, dt, limits);
      break;
    case 'disabled':
      ac.gs = 0;
      if (ac.flags.disabledUntil && s.t >= ac.flags.disabledUntil && !ac.flags.wreck) {
        // recovery crews have removed the aircraft: it is towed off the movement area
        const zone = runwayZoneAt(ap, ac.x, ac.y);
        logEvent(w, 'runway', 'advisory', `${ac.callsign} has been towed clear${zone ? ` of runway ${zone.id} – inspect and reopen the runway when ready` : ''}`, [ac]);
        if (ac.emergency && !ac.emergency.resolved) {
          ac.emergency.resolved = s.t;
          s.stats.emergenciesHandled++;
          s.stats.emergencyRespSum += s.t - ac.emergency.since;
        }
        ac.phase = 'gone';
        ac.flags.goneAt = s.t;
        ac.flags.towed = 1;
      }
      break;
  }
}
