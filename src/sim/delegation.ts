/**
 * Suggestion engine + optional AI controllers.
 *
 * suggest() returns the next sensible instruction for an aircraft. It powers the Beginner
 * "ATC guidance" hints and – when a position is delegated – the AI controllers, which issue
 * the suggestion through the normal issue() pipeline. AI controllers therefore obey exactly
 * the same validation, pilot checks and clearance boundaries as the player.
 */
import type { Aircraft, Command, Position } from './types';
import { NM, alongCross, angDiff, dist, hdgOf, norm360, segIntersect } from './util';
import { typeOf } from './data/aircraft';
import { EndRef, allEnds, endRef, holdsOf, runwayById, toraFrom } from './airport/query';
import { World, isAirborne } from './world';
import { issue, planTaxi } from './commands';
import { cumOf, nextHoldAhead, rollingToward, runwayHot, runwayOccupants } from './ground';
import { gateOptions, gateUser } from './traffic';
import { fixByName, minSpeed } from './air';
import { runwayWeatherIssue } from './weather';
import { wakeDepartureInterval } from './separation';

export interface Suggestion {
  cmds: Command[];
  label: string;
  pos: Position;
  /** when set, the suggestion is to wait and why */
  wait?: string;
}

interface Meter { lastEta: Record<string, number>; lastWake: Record<string, string>; lastTx: Record<number, number> }
const meters = new WeakMap<object, Meter>();
function meter(w: World): Meter {
  let m = meters.get(w.s);
  if (!m) { m = { lastEta: {}, lastWake: {}, lastTx: {} }; meters.set(w.s, m); }
  return m;
}

function intersecting(w: World, rid: string): string[] {
  const r = runwayById(w.ap, rid)!;
  return w.ap.runways.filter((o) => o.id !== rid && segIntersect(r.ends[0].x, r.ends[0].y, r.ends[1].x, r.ends[1].y, o.ends[0].x, o.ends[0].y, o.ends[1].x, o.ends[1].y)).map((o) => o.id);
}

export function runwayUsable(w: World, ac: Aircraft, e: EndRef, landing: boolean): boolean {
  const t = typeOf(ac.type);
  const s = w.s;
  if (s.rwy[e.rwy.id].closed) return false;
  if (s.cfg.difficulty.perfRealism) {
    const need = landing ? t.landingDist * (s.weather.surface === 'dry' ? 1 : s.weather.surface === 'wet' ? 1.25 : 1.6) : t.takeoffDist;
    if (need > e.rwy.length) return false;
    if (runwayWeatherIssue(w, e.end.name, t.maxXwind, landing)) return false;
  }
  return true;
}

/** best departure runway for a surface aircraft: shortest taxi + queue penalty */
export function pickDepartureRunway(w: World, ac: Aircraft): string | undefined {
  const { ap, s } = w;
  let cands = s.activeConfig.dep.map((n) => endRef(ap, n)).filter((e): e is EndRef => !!e && runwayUsable(w, ac, e, false));
  if (!cands.length) cands = allEnds(ap).filter((e) => runwayUsable(w, ac, e, false));
  let best: string | undefined, bestCost = Infinity;
  for (const e of cands) {
    const plan = planTaxi(w, ac, { t: 'TAXI', rwy: e.end.name });
    if (typeof plan === 'string') continue;
    const queue = s.aircraft.filter((a) => a.rwy === e.end.name && ['taxi_out', 'holding_short', 'lining_up', 'lined_up'].includes(a.phase)).length;
    let cost = plan.route.len + queue * 450;
    const f = fixByName(w, ac.depFix);
    if (f) {
      // avoid crossing the departure path of a parallel departure runway on the way to the exit fix
      const mySide = Math.sign(alongCross(f.x, f.y, e.end.x, e.end.y, e.end.hdg)[1]);
      for (const o of cands) {
        if (o.rwy.id === e.rwy.id || Math.abs(angDiff(o.end.hdg, e.end.hdg)) > 20) continue;
        if (Math.sign(alongCross(o.end.x, o.end.y, e.end.x, e.end.y, e.end.hdg)[1]) === mySide) cost += 2600;
      }
    }
    if (cost < bestCost) { bestCost = cost; best = e.end.name; }
  }
  return best;
}

export function pickArrivalRunway(w: World, ac: Aircraft): string | undefined {
  const { ap, s } = w;
  let cands = s.activeConfig.arr.map((n) => endRef(ap, n)).filter((e): e is EndRef => !!e && runwayUsable(w, ac, e, true));
  if (!cands.length) cands = allEnds(ap).filter((e) => runwayUsable(w, ac, e, true));
  const em = ac.emergency && !ac.emergency.resolved;
  let best: string | undefined, bestCost = Infinity;
  for (const e of cands) {
    const f = fixByName(w, `F${e.end.name}`)!;
    const load = s.aircraft.filter((a) => a !== ac && a.rwy === e.end.name && isAirborne(a) && a.kind === 'arrival').length;
    const out = outerSide(w, e.end.name);
    const mySide = Math.sign(alongCross(ac.x, ac.y, e.end.x, e.end.y, e.end.hdg)[1]);
    const cost = dist(ac.x, ac.y, f.x, f.y) / NM + load * 4 + (out !== 0 && mySide !== out ? 14 : 0) - (em ? e.rwy.length / 400 : 0);
    if (cost < bestCost) { bestCost = cost; best = e.end.name; }
  }
  return best;
}

/** is it safe to put a departure on / across this runway right now? */
function runwayClearFor(w: World, ac: Aircraft, rid: string, kind: 'cross' | 'lineup' | 'takeoff'): string | undefined {
  const { ap, s } = w;
  const r = runwayById(ap, rid)!;
  if (kind !== 'cross' && s.rwy[rid].closed) return 'runway closed';
  // clearances already transmitted but not yet read back / executed
  for (const p of s.pending) {
    const o = s.aircraft.find((x) => x.id === p.ac);
    if (!o || o === ac) continue;
    for (const c of p.cmds) {
      if (c.t === 'CROSS' && endRef(ap, c.rwy)?.rwy.id === rid) return `${o.callsign} cleared to cross`;
      if ((c.t === 'TAKEOFF' || c.t === 'LINE_UP') && endRef(ap, o.rwy)?.rwy.id === rid && kind !== 'cross') return `${o.callsign} cleared onto the runway`;
      if (c.t === 'TAKEOFF' && endRef(ap, o.rwy)?.rwy.id === rid) return `${o.callsign} cleared for takeoff`;
    }
  }
  for (const o of s.aircraft) {
    if (o === ac || isAirborne(o)) continue;
    if (kind !== 'cross' && o.crossCleared.includes(rid)) return `${o.callsign} crossing`;
    if (kind === 'cross' && o.takeoffCleared && endRef(ap, o.rwy)?.rwy.id === rid && o.phase !== 'departure') return `${o.callsign} cleared for takeoff`;
    if (kind !== 'cross' && (o.lineUpCleared || o.takeoffCleared) && o.phase === 'holding_short' && endRef(ap, o.rwy)?.rwy.id === rid) return `${o.callsign} entering the runway`;
  }
  const lowVis = s.weather.visSM < 1;
  const finalGate = (kind === 'cross' ? 2.6 : kind === 'lineup' ? 2.8 : ac.phase === 'lined_up' ? 2.2 : 3.4) * (lowVis ? 1.6 : 1);
  for (const o of s.aircraft) {
    if (o === ac) continue;
    const oe = endRef(ap, o.rwy);
    if (!oe || oe.rwy.id !== rid) continue;
    if ((o.phase === 'final' || o.phase === 'approach') && dist(o.x, o.y, oe.end.x, oe.end.y) < finalGate * NM && o.alt < 2500) return `${o.callsign} on final`;
    if (o.phase === 'takeoff_roll' && kind !== 'lineup') return `${o.callsign} departing`;
    if (o.phase === 'landing_roll' && o.route.length < 2) return `${o.callsign} landing`;
    if (o.phase === 'lined_up' && (o.takeoffCleared || kind === 'takeoff')) return `${o.callsign} lined up`;
    if (o.phase === 'lining_up' && kind === 'takeoff') return `${o.callsign} lining up`;
  }
  if (kind !== 'cross' && ac.phase !== 'lined_up') {
    const roller = rollingToward(w, ac);
    if (roller) return `${roller.callsign} rolling`;
  }
  if (kind === 'takeoff') {
    const e = endRef(ap, ac.rwy)!;
    const [myAl] = alongCross(ac.x, ac.y, e.end.x, e.end.y, e.end.hdg);
    for (const o of runwayOccupants(w, r, ac)) {
      const [al] = alongCross(o.x, o.y, e.end.x, e.end.y, e.end.hdg);
      if (al > myAl - 50 && !(o.phase === 'takeoff_roll')) return `${o.callsign} on the runway`;
    }
    const last = s.rwy[rid].lastDep[e.end.name];
    if (last && last.ac !== ac.id) {
      const need = Math.max(s.cfg.difficulty.strictSeparation ? 95 : 70, wakeDepartureInterval(last.wake, typeOf(ac.type).wake) + 5);
      if (s.t - last.t < need) return 'departure spacing';
    }
    // previous departure must be airborne
    if (s.aircraft.some((o) => o !== ac && o.phase === 'departure' && o.rwy === ac.rwy && o.alt < 400)) return 'departure spacing';
    for (const xid of intersecting(w, rid)) {
      const x = runwayById(ap, xid)!;
      if (runwayHot(w, x, ac)) return `traffic on intersecting runway ${xid}`;
    }
    if (kind === 'takeoff' && s.cfg.difficulty.perfRealism && runwayWeatherIssue(w, e.end.name, typeOf(ac.type).maxXwind, false)) return 'wind out of limits';
    for (const cell of s.weather.cells) {
      const [al, cr] = alongCross(cell.x, cell.y, e.end.x, e.end.y, e.end.hdg);
      if (al > 0 && al < 8 * NM + cell.r && Math.abs(cr) < cell.r) return 'weather off the departure end';
    }
  }
  if (kind === 'cross') {
    if (runwayOccupants(w, r, ac).some((o) => o.phase === 'takeoff_roll' || (o.phase === 'landing_roll' && o.route.length < 2))) return 'runway in use';
  }
  return undefined;
}

const LEVELS = [7000, 8000, 9000, 10000, 11000, 12000, 13000];

function pathToGo(w: World, ac: Aircraft, endName: string): number {
  const e = endRef(w.ap, endName)!;
  if (ac.phase === 'final') return dist(ac.x, ac.y, e.end.x, e.end.y) / NM;
  const base = bestBase(w, ac, endName);
  if (ac.flags.aiStage >= 3 || !base) return dist(ac.x, ac.y, e.end.x, e.end.y) / NM + 1.5;
  return dist(ac.x, ac.y, base.x, base.y) / NM + 8.5 + 9.5;
}
/** which side (+1 right / -1 left of the landing direction) is clear of the other active arrival runways; 0 = either */
function outerSide(w: World, endName: string): number {
  const e = endRef(w.ap, endName)!;
  let sum = 0, n = 0;
  for (const o of w.s.activeConfig.arr) {
    const oe = endRef(w.ap, o);
    if (!oe || oe.rwy.id === e.rwy.id || Math.abs(angDiff(oe.end.hdg, e.end.hdg)) > 20) continue;
    sum += Math.sign(alongCross(oe.end.x, oe.end.y, e.end.x, e.end.y, e.end.hdg)[1]);
    n++;
  }
  if (!n || Math.abs(sum) < n) return 0; // no parallels, or runways on both sides
  return -Math.sign(sum);
}
function depOuterSide(w: World, e: EndRef): number {
  let sum = 0, n = 0;
  for (const r of w.ap.runways) {
    if (r.id === e.rwy.id || Math.abs(angDiff(r.ends[0].hdg, e.end.hdg) % 180) > 20 && Math.abs(Math.abs(angDiff(r.ends[0].hdg, e.end.hdg)) - 180) > 20) continue;
    sum += Math.sign(alongCross((r.ends[0].x + r.ends[1].x) / 2, (r.ends[0].y + r.ends[1].y) / 2, e.end.x, e.end.y, e.end.hdg)[1]);
    n++;
  }
  if (!n || Math.abs(sum) < n) return 0;
  return -Math.sign(sum);
}
/** platform altitude: runways sandwiched between other arrival runways intercept 1000 ft higher */
function platformAlt(w: World, endName: string): number {
  const e = endRef(w.ap, endName)!;
  const group = w.s.activeConfig.arr.filter((o) => { const oe = endRef(w.ap, o); return oe && Math.abs(angDiff(oe.end.hdg, e.end.hdg)) < 20; });
  // each parallel stream gets its own level so traffic is 1000 ft apart until established
  return 3000 + Math.max(0, Math.min(2, group.indexOf(endName))) * 1000;
}
function bestBase(w: World, ac: Aircraft, endName: string) {
  const bases = w.ap.fixes.filter((f) => f.kind === 'nav' && f.rwy === endName);
  if (ac.flags.aiBase) return bases.find((b) => b.name.charCodeAt(b.name.length - 1) === ac.flags.aiBase) ?? bases[0];
  const out = outerSide(w, endName);
  const e = endRef(w.ap, endName)!;
  return bases.sort((a, b) => {
    const pen = (f: typeof a) => (out !== 0 && Math.sign(alongCross(f.x, f.y, e.end.x, e.end.y, e.end.hdg)[1]) !== out ? 40 * NM : 0);
    return dist(ac.x, ac.y, a.x, a.y) + pen(a) - dist(ac.x, ac.y, b.x, b.y) - pen(b);
  })[0];
}

function suggestArrival(w: World, ac: Aircraft): Suggestion | undefined {
  const { ap, s } = w;
  const m = meter(w);
  const pos: Position = 'approach';
  const em = ac.emergency && !ac.emergency.resolved;
  if (ac.flags.diverting) return undefined;
  if (ac.phase === 'final') {
    const e = endRef(ap, ac.rwy)!;
    const d = dist(ac.x, ac.y, e.end.x, e.end.y) / NM;
    const occ = runwayOccupants(w, e.rwy).filter((o) => !(o.phase === 'takeoff_roll' && o.gs > 50));
    const ahead = s.aircraft.find((o) => o !== ac && o.phase === 'final' && o.rwy === ac.rwy && dist(o.x, o.y, e.end.x, e.end.y) < d * NM);
    if (!ac.landCleared) {
      if (!occ.length && !ahead && !s.rwy[e.rwy.id].closed) return { cmds: [{ t: 'LAND', rwy: ac.rwy }], label: `Cleared to land ${ac.rwy}`, pos: 'tower' };
      if (d < 1.25 && !em) return { cmds: [{ t: 'GO_AROUND' }], label: 'Go around – runway not clear', pos: 'tower' };
      return { cmds: [], label: '', pos: 'tower', wait: ahead ? `number 2 behind ${ahead.callsign}` : `runway occupied by ${occ[0]?.callsign ?? 'traffic'}` };
    }
    if (occ.length && d < 0.9 && !em && occ.some((o) => o.gs < 30)) return { cmds: [{ t: 'GO_AROUND' }], label: 'Go around – runway occupied', pos: 'tower' };
    // in-trail spacing
    if (ahead && !em) {
      const gap = d - dist(ahead.x, ahead.y, e.end.x, e.end.y) / NM;
      if (gap < 2.3 && d > 1.5) return { cmds: [{ t: 'GO_AROUND' }], label: `Go around – ${gap.toFixed(1)} NM behind ${ahead.callsign}`, pos: 'tower' };
    }
    return undefined;
  }
  // choose / keep runway
  let rwy = ac.rwy && endRef(ap, ac.rwy) && runwayUsable(w, ac, endRef(ap, ac.rwy)!, true) ? ac.rwy : pickArrivalRunway(w, ac);
  if (!rwy) return { cmds: [], label: '', pos, wait: 'no usable runway' };
  const e = endRef(ap, rwy)!;
  const stage = ac.flags.aiStage ?? 0;
  if (ac.phase === 'approach') {
    // cleared and intercepting – speed control only
    return undefined;
  }
  if (stage >= 2 && ac.flags.aiRwy && ac.rwy !== rwy) { ac.flags.aiStage = 0; }
  if ((ac.flags.aiStage ?? 0) === 0 || ac.phase === 'inbound' && ac.flags.aiStage === 3 && !ac.apprCleared) {
    if (ac.flags.aiStage === 3) ac.flags.aiStage = 0;
    // metering: only release toward the runway when a landing slot is available
    const base = bestBase(w, ac, rwy);
    const toGo = pathToGo(w, ac, rwy);
    const eta = s.t + (toGo / 3.4) * 60;
    const lastEta = m.lastEta[rwy] ?? -1e9;
    const lowVis = s.weather.visSM < 1 ? 1.5 : 1;
    const interval = ((m.lastWake[rwy] === 'H' || m.lastWake[rwy] === 'J') && typeOf(ac.type).wake !== 'H' ? 165 : 125) * lowVis * (ap.runways.length === 1 ? 1.35 : 1);
    if (em || eta >= lastEta + interval) {
      const cmds: Command[] = [];
      const nearField = dist(ac.x, ac.y, 0, 0) < 9 * NM;
      if (base && !nearField) cmds.push({ t: 'DIRECT', fix: base.name });
      else cmds.push({ t: 'DIRECT', fix: `F${rwy}` });
      cmds.push({ t: 'ALTITUDE', alt: platformAlt(w, rwy) + 2000 }, { t: 'SPEED', spd: 210 }, { t: 'ASSIGN_RUNWAY', rwy });
      if (ac.ias < 205 || typeOf(ac.type).cruiseKt < 215 || minSpeed(w, ac) > 210) cmds.splice(2, 1);
      return { cmds, label: `Vector for ILS ${rwy} via ${base?.name ?? 'final'}`, pos, wait: undefined };
    }
    // stack management at the holding fix
    const post = ac.fix;
    const others = s.aircraft.filter((o) => o !== ac && o.phase === 'inbound' && (o.flags.aiStage ?? 0) === 0 && o.fix === post);
    const taken = others.map((o) => o.tgtAlt);
    if (taken.includes(ac.tgtAlt) || (ac.tgtAlt > 13000)) {
      const free = LEVELS.filter((l) => !taken.includes(l)).sort((a, b) => Math.abs(a - ac.alt) - Math.abs(b - ac.alt));
      const lvl = free.find((l) => !taken.some((x) => (x - l) * (x - ac.alt) < 0));
      if (lvl && lvl !== ac.tgtAlt) return { cmds: [{ t: 'ALTITUDE', alt: lvl }], label: `Hold at ${lvl} ft (stack separation)`, pos };
    }
    return { cmds: [], label: '', pos, wait: `holding for a landing slot on ${rwy} (${Math.max(0, Math.round((lastEta + interval - eta) / 60))} min)` };
  }
  if (stage === 1) {
    // en route to the base fix
    const base = bestBase(w, ac, rwy);
    const d = base ? dist(ac.x, ac.y, base.x, base.y) / NM : 0;
    if (!base || d < 1.6 || ac.latMode === 'hold') {
      const side = base ? alongCross(base.x, base.y, e.end.x, e.end.y, e.end.hdg)[1] : 0;
      const hdg = norm360(Math.round((e.end.hdg + (side > 0 ? -40 : 40)) / 5) * 5) || 360;
      const cmds: Command[] = [{ t: 'HEADING', hdg }, { t: 'ALTITUDE', alt: platformAlt(w, rwy) }, { t: 'SPEED', spd: 180 }, { t: 'APPROACH', rwy }];
      if (minSpeed(w, ac) > 180 || typeOf(ac.type).cruiseKt < 190) cmds.splice(2, 1);
      return { cmds, label: `Turn base, cleared ILS ${rwy}`, pos };
    }
    return undefined;
  }
  if (stage === 2 && ac.latMode === 'fix' && ac.fix === `F${rwy}`) {
    const f = fixByName(w, `F${rwy}`)!;
    if (dist(ac.x, ac.y, f.x, f.y) < 6 * NM || dist(ac.x, ac.y, e.end.x, e.end.y) < 12 * NM) return { cmds: [{ t: 'ALTITUDE', alt: platformAlt(w, rwy) }, { t: 'APPROACH', rwy }], label: `Cleared ILS ${rwy}`, pos };
  }
  return undefined;
}

/** bookkeeping after the AI (or a guided player) executes an arrival suggestion */
function noteArrival(w: World, ac: Aircraft, sg: Suggestion) {
  const m = meter(w);
  const direct = sg.cmds.find((c) => c.t === 'DIRECT') as Extract<Command, { t: 'DIRECT' }> | undefined;
  const asg = sg.cmds.find((c) => c.t === 'ASSIGN_RUNWAY') as Extract<Command, { t: 'ASSIGN_RUNWAY' }> | undefined;
  if (direct && asg) {
    const toGo = pathToGo(w, ac, asg.rwy);
    m.lastEta[asg.rwy] = Math.max(m.lastEta[asg.rwy] ?? -1e9, w.s.t + (toGo / 3.4) * 60);
    m.lastWake[asg.rwy] = typeOf(ac.type).wake;
    ac.flags.aiRwy = 1;
    if (direct.fix.startsWith('B')) { ac.flags.aiStage = 1; ac.flags.aiBase = direct.fix.charCodeAt(direct.fix.length - 1); }
    else ac.flags.aiStage = 2;
  } else if (sg.cmds.some((c) => c.t === 'APPROACH')) ac.flags.aiStage = 3;
  if (ac.phase === 'departure' && sg.cmds.some((c) => c.t === 'HEADING')) ac.flags.aiDep = 1;
}

export function suggest(w: World, ac: Aircraft): Suggestion | undefined {
  const { ap, s } = w;
  if (ac.flags.pending || ac.handedOff) return undefined;
  switch (ac.phase) {
    case 'parked':
      if (ac.kind !== 'departure' || ac.turn?.stage !== 'ready') return undefined;
      if (ac.emergency && !ac.emergency.resolved) return undefined;
      if (!ac.depCleared) return { cmds: [{ t: 'DEP_CLEARANCE' }], label: 'Issue departure clearance', pos: 'delivery' };
      if (!ac.pushApproved && ac.request?.type === 'pushback') {
        const near = s.aircraft.find((o) => o !== ac && !isAirborne(o) && o.phase !== 'parked' && o.phase !== 'gone' && dist(o.x, o.y, ac.x, ac.y) < 170 && (o.gs > 0.5 || o.phase === 'pushback' || o.phase === 'push_done'));
        if (near) return { cmds: [], label: '', pos: 'ground', wait: `${near.callsign} moving behind the stand` };
        const g = ap.gates.find((x) => x.name === ac.gate);
        const thru = g && s.aircraft.find((o) => o !== ac && (o.phase === 'taxi_in' || o.phase === 'taxi_out') && dist(o.x, o.y, ac.x, ac.y) < 450 && o.route.includes(g.lane) && cumOf(ap, o.route)[o.route.indexOf(g.lane)] > o.routeS);
        if (thru) return { cmds: [], label: '', pos: 'ground', wait: `${thru.callsign} taxiing past the stand` };
        return { cmds: [{ t: 'PUSHBACK' }], label: 'Approve pushback', pos: 'ground' };
      }
      return undefined;
    case 'push_done':
    case 'vacated': {
      if (ac.reverse) return undefined;
      if (ac.kind === 'arrival') {
        const gate = ac.gate && !gateUser(w, ac.gate, ac) ? ac.gate : gateOptions(w, ac)[0]?.name;
        if (!gate) return { cmds: [], label: '', pos: 'ground', wait: 'no compatible gate available' };
        return { cmds: [{ t: 'TAXI', gate }], label: `Taxi to gate ${gate}`, pos: 'ground' };
      }
      const rwy = pickDepartureRunway(w, ac);
      if (!rwy) return { cmds: [], label: '', pos: 'ground', wait: 'no usable departure runway' };
      return { cmds: [{ t: 'TAXI', rwy }], label: `Taxi to runway ${rwy}`, pos: 'ground' };
    }
    case 'taxi_out':
    case 'taxi_in': {
      if (ac.reverse) return undefined;
      if (ac.request?.type === 'tow' && ac.gs < 0.5 && s.t - ac.request.since > 600) ac.request = undefined;
      if (ac.request?.type === 'tow' && ac.gs < 0.5 && ac.blockedBy === undefined) {
        // conflict has cleared on its own
        ac.request = undefined;
        return ac.holdPos ? { cmds: [{ t: 'CONTINUE_TAXI' }], label: 'Continue taxi', pos: 'ground' } : undefined;
      }
      if (ac.request?.type === 'tow' && ac.gs < 0.5) {
        // head-on: tow the lower-priority aircraft
        const other = s.aircraft.find((o) => o.id === ac.blockedBy);
        if (other?.reverse && other.flags.tow) return undefined;
        if (!other || ac.id > other.id || other.phase === 'pushback' || other.phase === 'disabled') return { cmds: [{ t: 'TOW' }], label: 'Tow back to clear the conflict', pos: 'ground' };
        return undefined;
      }
      if (ac.holdPos && !(ac.emergency && !ac.emergency.resolved)) return { cmds: [{ t: 'CONTINUE_TAXI' }], label: 'Continue taxi', pos: 'ground' };
      if (ac.gs < 0.5) {
        const h = nextHoldAhead(w, ac, cumOf(ap, ac.route));
        if (h && !h.final && ac.request?.type === 'crossing') {
          const why = runwayClearFor(w, ac, h.rwy, 'cross');
          const name = runwayById(ap, h.rwy)!.ends[0].name;
          if (why) return { cmds: [], label: '', pos: 'ground', wait: why };
          return { cmds: [{ t: 'CROSS', rwy: name }], label: `Cross runway ${h.rwy}`, pos: 'ground' };
        }
        if (ac.request?.type === 'taxi' || ac.request?.type === 'taxi_in') {
          if (ac.kind === 'arrival' && ac.gate) return { cmds: [{ t: 'TAXI', gate: ac.gate }], label: `Continue to gate ${ac.gate}`, pos: 'ground' };
          if (ac.kind === 'departure' && ac.rwy) return { cmds: [{ t: 'TAXI', rwy: ac.rwy }], label: `Continue to runway ${ac.rwy}`, pos: 'ground' };
        }
      }
      return undefined;
    }
    case 'holding_short':
    case 'lined_up': {
      const e = endRef(ap, ac.rwy);
      if (!e) return undefined;
      if (ac.takeoffCleared) return undefined;
      const why = runwayClearFor(w, ac, e.rwy.id, 'takeoff');
      if (!why) return { cmds: [{ t: 'TAKEOFF', rwy: ac.rwy }], label: `Cleared for takeoff ${ac.rwy}`, pos: 'tower' };
      if (ac.phase === 'holding_short' && !ac.lineUpCleared) {
        const lu = runwayClearFor(w, ac, e.rwy.id, 'lineup');
        const busy = s.aircraft.some((o) => o !== ac && o.rwy === ac.rwy && (o.phase === 'lined_up' || o.phase === 'lining_up'));
        if (!lu && !busy && (why === 'departure spacing' || /departing/.test(why))) return { cmds: [{ t: 'LINE_UP', rwy: ac.rwy }], label: `Line up and wait ${ac.rwy}`, pos: 'tower', wait: why };
      }
      return { cmds: [], label: '', pos: 'tower', wait: why };
    }
    case 'departure': {
      const cmds: Command[] = [];
      if (ac.emergency && !ac.emergency.resolved) return undefined;
      if (ac.alt < 600) return undefined;
      const f = fixByName(w, ac.depFix);
      if (f && ac.latMode !== 'fix') {
        const brg = hdgOf(f.x - ac.x, f.y - ac.y);
        const turn = angDiff(ac.hdg, brg);
        const e = endRef(ap, ac.rwy);
        // large turns are made away from the parallel runways, then direct once pointing at the fix
        const out = e ? depOuterSide(w, e) : 0;
        if (Math.abs(turn) > 100 && out !== 0 && !ac.flags.aiDep) {
          cmds.push({ t: 'HEADING', hdg: Math.round(brg / 10) * 10 || 360, dir: out > 0 ? 'R' : 'L' });
        } else if (!ac.flags.aiDep || Math.abs(turn) < 30) cmds.push({ t: 'DIRECT', fix: f.name });
      }
      if (ac.tgtAlt < ap.ceiling) cmds.push({ t: 'ALTITUDE', alt: ap.ceiling });
      if (cmds.length) return { cmds, label: cmds.map((c) => (c.t === 'DIRECT' ? `direct ${c.fix}` : c.t === 'HEADING' ? `turn ${c.dir === 'R' ? 'right' : 'left'} heading ${c.hdg}` : c.t === 'ALTITUDE' ? `climb ${c.alt}` : '')).join(', '), pos: 'departure' };
      return undefined;
    }
    case 'inbound':
    case 'approach':
    case 'final':
      return ac.kind === 'arrival' ? suggestArrival(w, ac) : undefined;
  }
  return undefined;
}

/** apply a suggestion (used by the "do suggested" button and by the AI) */
export function applySuggestion(w: World, ac: Aircraft, sg: Suggestion, by: 'player' | 'ai') {
  if (!sg.cmds.length) return { ok: false, message: sg.wait ? `Wait: ${sg.wait}` : 'Nothing to do.' };
  const res = issue(w, ac, sg.cmds, by);
  if (res.ok) noteArrival(w, ac, sg);
  else if (res.refused) meter(w).lastTx[ac.id] = w.s.t + 20;
  return res;
}

/** AI controllers: called every 2 simulated seconds */
export function runDelegation(w: World) {
  const { s } = w;
  const del = s.cfg.delegation;
  if (!del.delivery && !del.ground && !del.tower && !del.approach && !del.departure) return;
  const m = meter(w);
  // emergencies and aircraft closest to the runway first
  const order = [...s.aircraft].sort((a, b) => Number(!!b.emergency && !b.emergency.resolved) - Number(!!a.emergency && !a.emergency.resolved) || dist(a.x, a.y, 0, 0) - dist(b.x, b.y, 0, 0));
  for (const ac of order) {
    if (ac.phase === 'gone' || ac.phase === 'crashed' || ac.phase === 'disabled') continue;
    if (s.t < (m.lastTx[ac.id] ?? 0)) continue;
    const sg = suggest(w, ac);
    if (!sg || !sg.cmds.length || !del[sg.pos]) continue;
    const res = applySuggestion(w, ac, sg, 'ai');
    m.lastTx[ac.id] = Math.max(m.lastTx[ac.id] ?? 0, s.t + (res.ok ? 6 : 15));
  }
}

void hdgOf; void angDiff; void holdsOf; void toraFrom;
