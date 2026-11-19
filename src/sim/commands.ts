/**
 * Clearance processing. A transmission goes through three distinct stages:
 *   1. validation  – is the instruction meaningful for this aircraft / airport? (error → not sent)
 *   2. pilot check – will the crew accept it? (refusal → "unable" on the radio)
 *   3. execution   – takes effect when the pilot reads it back a few seconds later.
 * The player, the voice front-end and the optional AI controllers all use issue().
 */
import type { Aircraft, Command, CommandResult, PendingTx } from './types';
import { KT, NM, alongCross, angDiff, dist, norm360, rand, randRange } from './util';
import { typeOf, sizeFits } from './data/aircraft';
import { endRef, gateByName, holdsOf, normRwyName, runwayById, rwyLateral, toraFrom, nearestNode } from './airport/query';
import { findRoute, type Route } from './pathfind';
import { World, clearRequest, csay, isAirborne, logEvent, radioAtc, radioPilot, radioSystem } from './world';
import { atcPhrase, readbackPhrase, sayRwy } from './phraseology';
import { cumOf, curSeg, nextHoldAhead, pushbackRoute, rejectTakeoff, runwayHot, runwayOccupants, setRoute, startLineUp, startPushback, startTow, depRunwayId } from './ground';
import { fixByName, goAround, minSpeed } from './air';
import { gateUser } from './traffic';
import { runwayWeatherIssue, sayWind } from './weather';
import { wakeDepartureInterval } from './separation';

const GROUND_TAXI = new Set(['push_done', 'taxi_out', 'taxi_in', 'vacated', 'holding_short']);

interface TaxiPlan { route: Route; rwy?: string; gate?: string; stopS?: number }

/** resolve a TAXI instruction into a concrete surface route */
export function planTaxi(w: World, ac: Aircraft, c: Extract<Command, { t: 'TAXI' }>): TaxiPlan | string {
  const { ap, s } = w;
  const t = typeOf(ac.type);
  const seg = curSeg(ap, ac);
  let start: number, prev: number | undefined;
  if (seg) { start = seg.b; prev = seg.a; }
  else {
    if (ac.phase === 'parked') return `${ac.callsign} is still on stand – approve pushback first`;
    const n = nearestNode(ap, ac.x, ac.y, (x) => x.kind !== 'gate');
    if (!n) return 'no taxi route available';
    start = n.id;
  }
  const closed = new Set(s.closedEdges);
  const via = c.via?.map((v) => v.toUpperCase());
  if (via) for (const v of via) if (!ap.edges.some((e) => e.name === v)) return `taxiway ${v} does not exist at ${ap.icao}`;
  const wantsGate = c.gate || (ac.kind === 'arrival' && !c.rwy);
  if (wantsGate) {
    const gname = (c.gate ?? ac.gate)?.toUpperCase();
    if (!gname) return `assign a gate first (e.g. "${ac.callsign} TAXI GATE ${ap.gates[0].name}")`;
    const g = gateByName(ap, gname);
    if (!g) return `gate ${gname} does not exist at ${ap.icao}`;
    if (!sizeFits(t.size, g.size)) return `gate ${g.name} is too small for the ${t.name}`;
    const user = gateUser(w, g.name, ac);
    if (user) return `gate ${g.name} is ${user.phase === 'parked' || user.phase === 'pushback' ? 'occupied by' : 'assigned to'} ${user.callsign}`;
    const route = findRoute(ap, start, g.node, { prev, via, closed });
    if (!route) return via ? `no route to gate ${g.name} via ${via.join(' ')}` : `no taxi route to gate ${g.name}`;
    return { route, gate: g.name, ...stopAt(w, ac, route, c.holdShort) };
  }
  const rname = c.rwy ?? ac.rwy;
  if (!rname) return 'specify the departure runway (e.g. "TAXI 27R VIA B M")';
  const e = endRef(ap, rname);
  if (!e) return `runway ${rname} does not exist at ${ap.icao}`;
  const perf = s.cfg.difficulty.perfRealism;
  const holds = holdsOf(ap, e.rwy.id).filter((h) => toraFrom(h, e.idx) >= (perf ? t.takeoffDist : Math.min(1200, e.rwy.length * 0.5)));
  if (!holds.length) return `runway ${rname} is too short for the ${t.name} (needs ${Math.round(t.takeoffDist)} m)`;
  const info = new Map(holds.map((h) => [h.hold, h]));
  const route = findRoute(ap, start, holds.map((h) => h.hold), {
    prev, via, closed,
    goalCost: (n) => (e.rwy.length - toraFrom(info.get(n)!, e.idx)) * 4,
    goalOk: (n, p) => rwyLateral(e.rwy, ap.nodes[p].x, ap.nodes[p].y) > rwyLateral(e.rwy, ap.nodes[n].x, ap.nodes[n].y) - 1,
  });
  if (!route) return via ? `no route to runway ${rname} via ${via.join(' ')}` : `no taxi route to runway ${rname}`;
  return { route, rwy: e.end.name, ...stopAt(w, ac, route, c.holdShort && c.holdShort !== e.end.name ? c.holdShort : undefined) };
}

function stopAt(w: World, ac: Aircraft, route: Route, holdShort?: string): { stopS?: number } {
  if (!holdShort || /^\d/.test(holdShort)) return {};
  const { ap } = w;
  const cum = cumOf(ap, route.nodes);
  for (let i = 1; i < route.nodes.length; i++) {
    if (ap.adj[route.nodes[i]].some((eid) => ap.edges[eid].name === holdShort.toUpperCase()) && route.names.indexOf(holdShort.toUpperCase()) !== 0) {
      return { stopS: Math.max(0, cum[i] - typeOf(ac.type).length / 2 - 14) };
    }
  }
  return {};
}

function rwyIdOf(w: World, name: string): string | undefined {
  const n = normRwyName(w.ap, name);
  return n ? endRef(w.ap, n)?.rwy.id : undefined;
}

/** Stage 1: static validation. Returns an error message or undefined. */
function validate(w: World, ac: Aircraft, c: Command, prior: Command[]): string | undefined {
  const { ap, s } = w;
  const air = isAirborne(ac);
  const cs = ac.callsign;
  const had = (t: Command['t']) => prior.some((p) => p.t === t);
  if (ac.phase === 'gone' || ac.phase === 'crashed') return `${cs} is no longer under your control`;
  if (ac.handedOff) return `${cs} has been handed off to center`;
  if (ac.phase === 'disabled') return `${cs} is disabled and cannot comply`;
  switch (c.t) {
    case 'DEP_CLEARANCE':
      if (ac.phase !== 'parked' || ac.kind !== 'departure' || ac.turn?.stage !== 'ready') return `${cs} is not ready for a departure clearance (${ac.phase === 'parked' ? `turnaround: ${ac.turn?.stage ?? 'n/a'}` : ac.phase.replace('_', ' ')})`;
      if (ac.depCleared) return `${cs} already has its departure clearance`;
      return;
    case 'PUSHBACK':
      if (ac.phase !== 'parked') return `${cs} is not parked at a gate`;
      if (ac.kind !== 'departure' || ac.turn?.stage !== 'ready') return `${cs} has not finished its turnaround (${ac.turn?.stage ?? 'n/a'})`;
      if (!ac.depCleared && !had('DEP_CLEARANCE')) return `${cs} needs its departure clearance before pushback`;
      if (ac.pushApproved) return `${cs} is already cleared to push`;
      if (!pushbackRoute(w, ac, c.face)) return `no pushback path from gate ${ac.gate}`;
      return;
    case 'TAXI': {
      if (!GROUND_TAXI.has(ac.phase)) {
        if (ac.phase === 'parked') return `${cs} is still on stand – approve pushback first`;
        if (ac.phase === 'pushback') return `${cs} is still pushing back`;
        return `${cs} cannot taxi now (${ac.phase.replace('_', ' ')})`;
      }
      if (ac.reverse) return `${cs} is being repositioned by a tug`;
      if (ac.kind === 'arrival' && c.rwy && !c.gate) return `${cs} is an arrival – taxi it to a gate`;
      if (ac.kind === 'departure' && c.gate) return `${cs} is a departure – returning to the gate is not supported; taxi it to a runway`;
      const plan = planTaxi(w, ac, c);
      return typeof plan === 'string' ? plan : undefined;
    }
    case 'HOLD_POSITION':
      if (air) return `${cs} is airborne – use HOLD for a holding pattern`;
      if (!['pushback', 'taxi_out', 'taxi_in', 'lining_up', 'push_done', 'vacated', 'holding_short', 'lined_up'].includes(ac.phase)) return `${cs} is not moving on the surface`;
      return;
    case 'CONTINUE_TAXI':
      if (!ac.holdPos) return `${cs} was not told to hold position`;
      return;
    case 'CROSS': {
      const id = rwyIdOf(w, c.rwy);
      if (!id) return `runway ${c.rwy} does not exist`;
      if (!['taxi_out', 'taxi_in'].includes(ac.phase) && !had('TAXI')) return `${cs} is not taxiing`;
      if (had('TAXI')) return;
      const cum = cumOf(ap, ac.route);
      let crosses = false;
      for (let i = 1; i < ac.route.length; i++) {
        const n = ap.nodes[ac.route[i]];
        if (n.kind === 'hold' && n.rwy === id && cum[i] > ac.routeS - 5 && i < ac.route.length - 1) crosses = true;
      }
      if (!crosses) return `${cs}'s taxi route does not cross runway ${c.rwy}`;
      return;
    }
    case 'LINE_UP':
    case 'TAKEOFF': {
      if (ac.kind !== 'departure') return `${cs} is not a departure`;
      if (c.t === 'TAKEOFF' && ac.phase === 'takeoff_roll') return `${cs} is already rolling`;
      if (!['holding_short', 'lining_up', 'lined_up', 'taxi_out'].includes(ac.phase)) return `${cs} is not at the runway (${ac.phase.replace('_', ' ')})`;
      if (c.t === 'LINE_UP' && (ac.phase === 'lined_up' || ac.phase === 'lining_up')) return `${cs} is already lining up`;
      if (c.rwy && normRwyName(ap, c.rwy) !== ac.rwy) return `${cs} is taxiing to runway ${ac.rwy}, not ${c.rwy}`;
      if (ac.phase === 'taxi_out') {
        const cum = cumOf(ap, ac.route);
        const last = ap.nodes[ac.route[ac.route.length - 1]];
        if (last.kind !== 'hold' || last.rwy !== depRunwayId(ap, ac) || cum[cum.length - 1] - ac.routeS > 450 || nextHoldAhead(w, ac, cum)?.final === false)
          return `${cs} has not reached the runway ${ac.rwy} holding point yet`;
      }
      return;
    }
    case 'CANCEL_TAKEOFF':
      if (!ac.takeoffCleared && ac.phase !== 'takeoff_roll') return `${cs} has no takeoff clearance to cancel`;
      return;
    case 'HEADING':
    case 'ALTITUDE':
    case 'SPEED':
    case 'DIRECT': {
      const preDep = ac.kind === 'departure' && !air && ac.phase !== 'parked';
      if (!air && !(preDep && c.t !== 'SPEED')) return `${cs} is on the ground`;
      if (c.t === 'ALTITUDE') {
        if (c.alt % 100 !== 0) return 'altitudes are assigned in hundreds of feet';
        if (c.alt > ap.ceiling) return `your airspace tops out at ${ap.ceiling} ft`;
        if (c.alt < 1500) return 'minimum vectoring altitude is 1,500 ft';
      }
      if (c.t === 'SPEED' && c.spd !== 0 && (c.spd < 100 || c.spd > 290)) return 'speed must be between 100 and 290 knots';
      if (c.t === 'DIRECT' && !fixByName(w, c.fix)) return `unknown fix ${c.fix}. Fixes: ${ap.fixes.map((f) => f.name).join(' ')}`;
      return;
    }
    case 'HOLD':
      if (!air || ac.kind !== 'arrival') return `${cs} cannot enter a holding pattern now`;
      if (c.fix && !fixByName(w, c.fix)) return `unknown fix ${c.fix}`;
      return;
    case 'APPROACH': {
      if (ac.kind !== 'arrival' || !air) return `${cs} is not an airborne arrival`;
      const e = endRef(ap, normRwyName(ap, c.rwy));
      if (!e) return `runway ${c.rwy} does not exist at ${ap.icao}`;
      return;
    }
    case 'LAND':
      if (ac.kind !== 'arrival' || !air) return `${cs} is not an airborne arrival`;
      if (!ac.apprCleared && !had('APPROACH')) return `${cs} has not been cleared for an approach yet`;
      if (c.rwy && !had('APPROACH') && normRwyName(ap, c.rwy) !== ac.rwy) return `${cs} is on the approach to runway ${ac.rwy}, not ${c.rwy}`;
      if (ac.landCleared) return `${cs} is already cleared to land`;
      return;
    case 'GO_AROUND':
      if (!(ac.phase === 'approach' || ac.phase === 'final')) return `${cs} is not on approach`;
      return;
    case 'ASSIGN_RUNWAY': {
      if (!endRef(ap, normRwyName(ap, c.rwy))) return `runway ${c.rwy} does not exist`;
      if (ac.phase === 'approach' || ac.phase === 'final') return `${cs} is already on approach – issue a new approach clearance to change runway`;
      if (['taxi_out', 'holding_short', 'lining_up', 'lined_up', 'takeoff_roll', 'landing_roll'].includes(ac.phase)) return `${cs} is already committed to runway ${ac.rwy} – issue a new taxi route to change`;
      return;
    }
    case 'ASSIGN_GATE': {
      if (ac.kind !== 'arrival' || ac.phase === 'parked') return `${cs} does not need a gate assignment`;
      const g = gateByName(ap, c.gate);
      if (!g) return `gate ${c.gate} does not exist`;
      if (!sizeFits(typeOf(ac.type).size, g.size)) return `gate ${g.name} is too small for the ${typeOf(ac.type).name}`;
      const user = gateUser(w, g.name, ac);
      if (user) return `gate ${g.name} is ${user.phase === 'parked' || user.phase === 'pushback' ? 'occupied by' : 'assigned to'} ${user.callsign}`;
      return;
    }
    case 'EXIT':
      if (ac.kind !== 'arrival' || !(air || ac.phase === 'landing_roll')) return `${cs} is not landing`;
      if (!ap.edges.some((e) => e.name === c.twy.toUpperCase())) return `taxiway ${c.twy} does not exist`;
      return;
    case 'HANDOFF':
      if (ac.phase !== 'departure') return `${cs} is not an airborne departure`;
      if (ac.tgtAlt < 10000) return `climb ${cs} to at least 10,000 ft before handing off`;
      {
        const f = fixByName(w, ac.depFix);
        const onCourse = ac.latMode === 'fix' || !f || Math.abs(angDiff(ac.track, Math.atan2(f.x - ac.x, f.y - ac.y) * 57.2958)) < 40;
        if (!onCourse) return `${cs} is not on course to ${ac.depFix}`;
      }
      return;
    case 'TOW':
      if (air || ac.phase === 'parked' || ac.gs > 1) return `${cs} must be stationary on a taxiway to be repositioned`;
      if (!['taxi_out', 'taxi_in', 'push_done', 'vacated'].includes(ac.phase)) return `${cs} cannot be repositioned now`;
      return;
  }
}

/** Stage 2: would the crew accept? Returns the "unable" reason or undefined. */
function pilotCheck(w: World, ac: Aircraft, c: Command): string | undefined {
  const { ap, s } = w;
  const d = s.cfg.difficulty;
  const t = typeOf(ac.type);
  const wx = s.weather;
  switch (c.t) {
    case 'PUSHBACK': {
      if (!d.pilotAssist) return;
      const route = pushbackRoute(w, ac, c.face);
      if (!route) return;
      const cum = cumOf(ap, route);
      for (const o of s.aircraft) {
        if (o === ac || isAirborne(o) || o.phase === 'parked' || o.phase === 'gone') continue;
        for (let sd = cum[1] - 10; sd <= Math.min(cum[cum.length - 1], cum[1] + t.length / 2 + 30); sd += 10) {
          const a = ap.nodes[route[1]];
          if (dist(o.x, o.y, a.x, a.y) < 55) return `traffic directly behind us (${o.callsign})`;
        }
      }
      return;
    }
    case 'TAXI': {
      if (c.gate || ac.kind === 'arrival') return;
      const e = endRef(ap, c.rwy ?? ac.rwy);
      if (e && s.rwy[e.rwy.id].closed) return `runway ${sayRwy(e.end.name)} is closed`;
      return;
    }
    case 'CROSS': {
      const id = rwyIdOf(w, c.rwy)!;
      const r = runwayById(ap, id)!;
      const canSee = d.pilotAssist || wx.visSM >= 1;
      const hot = runwayHot(w, r, ac);
      if (hot && canSee) return `traffic ${hot.phase === 'final' || hot.phase === 'approach' ? 'on short final' : 'rolling'} on runway ${sayRwy(c.rwy)} (${hot.callsign})`;
      return;
    }
    case 'LINE_UP':
    case 'TAKEOFF': {
      const e = endRef(ap, ac.rwy)!;
      const st = s.rwy[e.rwy.id];
      if (st.closed) return `runway ${sayRwy(e.end.name)} is closed`;
      const canSee = d.pilotAssist || wx.visSM >= 1;
      // arrival on short final
      for (const o of s.aircraft) {
        if ((o.phase === 'final' || o.phase === 'approach') && endRef(ap, o.rwy)?.rwy.id === e.rwy.id) {
          const dd = dist(o.x, o.y, endRef(ap, o.rwy)!.end.x, endRef(ap, o.rwy)!.end.y);
          if (dd < (c.t === 'TAKEOFF' && ac.phase === 'lined_up' ? 1.2 : 2) * NM && o.alt < 1200 && canSee) return `traffic on ${(dd / NM).toFixed(1)} mile final (${o.callsign})`;
        }
      }
      if (c.t === 'LINE_UP') return;
      if (d.perfRealism) {
        const issue = runwayWeatherIssue(w, e.end.name, t.maxXwind, false);
        if (issue) return `runway ${sayRwy(e.end.name)}, ${issue}`;
      }
      // storm cell off the departure end
      for (const cell of wx.cells) {
        const [al, cr] = alongCross(cell.x, cell.y, e.end.x, e.end.y, e.end.hdg);
        if (al > 0 && al < 8 * NM + cell.r && Math.abs(cr) < cell.r) return 'weather off the departure end, we need to wait or a different runway';
      }
      // obstruction ahead on the runway
      if (canSee) {
        const ref = ac.phase === 'lined_up' ? { x: ac.x, y: ac.y } : (() => { const h = ac.route.length ? ap.nodes[ac.route[ac.route.length - 1]] : ac; return { x: h.x, y: h.y }; })();
        const [myAl] = alongCross(ref.x, ref.y, e.end.x, e.end.y, e.end.hdg);
        for (const o of runwayOccupants(w, e.rwy, ac)) {
          const [al] = alongCross(o.x, o.y, e.end.x, e.end.y, e.end.hdg);
          if (al > myAl + 30 && !(o.phase === 'takeoff_roll' && o.gs > 60)) return `traffic on the runway (${o.callsign})`;
        }
      }
      // wake turbulence behind the previous departure
      if (d.wakeSeparation && d.pilotAssist) {
        const last = st.lastDep[e.end.name];
        if (last && last.ac !== ac.id) {
          const need = wakeDepartureInterval(last.wake, t.wake);
          const left = need - (s.t - last.t);
          if (need > 60 && left > 8) return `wake turbulence, we need another ${Math.ceil(left / 10) * 10} seconds behind the ${last.wake === 'J' ? 'super' : 'heavy'}`;
        }
      }
      return;
    }
    case 'CANCEL_TAKEOFF':
      if (ac.phase === 'takeoff_roll' && ac.ias > t.vr - 15) return 'past V1, continuing the takeoff';
      return;
    case 'SPEED':
      if (c.spd && isAirborne(ac)) {
        const mn = minSpeed(w, ac);
        if (c.spd < mn) return `minimum speed is ${Math.ceil(mn / 5) * 5} knots in this configuration`;
        if (c.spd > 250 && ac.alt < 10000) return 'speed limit is 250 knots below ten thousand';
        if (c.spd > t.cruiseKt + 20) return `maximum speed is ${t.cruiseKt} knots`;
      }
      return;
    case 'ALTITUDE':
      if (ac.emergency && !ac.emergency.resolved && ac.emergency.kind === 'dual_engine_failure') return 'we are gliding, unable to maintain altitude';
      if (ac.emergency && !ac.emergency.resolved && ac.emergency.kind === 'engine_failure' && c.alt > ac.alt + 3000) return 'unable to climb that high on one engine';
      return;
    case 'HOLD':
      if (ac.emergency && !ac.emergency.resolved) return 'unable to hold, we have an emergency';
      if (s.cfg.difficulty.fuelRealism && ac.fuelMin < 20) return 'insufficient fuel to hold';
      return;
    case 'APPROACH': {
      const name = normRwyName(ap, c.rwy)!;
      const e = endRef(ap, name)!;
      if (s.rwy[e.rwy.id].closed) return `runway ${sayRwy(name)} is closed`;
      if (d.perfRealism) {
        const need = t.landingDist * (wx.surface === 'dry' ? 1 : wx.surface === 'wet' ? 1.25 : 1.6);
        if (need > e.rwy.length) return `runway ${sayRwy(name)} is too short for us, we need ${Math.round(need)} metres`;
        const crit = ac.emergency && !ac.emergency.resolved && ac.emergency.mayday;
        const issue = crit ? undefined : runwayWeatherIssue(w, name, t.maxXwind, true);
        if (issue) return `runway ${sayRwy(name)}, ${issue}`;
      }
      return;
    }
    case 'LAND': {
      const e = endRef(ap, ac.rwy);
      if (e && s.rwy[e.rwy.id].closed) return `runway ${sayRwy(e.end.name)} is closed`;
      return;
    }
  }
}

/** Stage 3: apply the instruction. Returns a pilot "unable" reason if it can no longer be complied with. */
function apply(w: World, ac: Aircraft, c: Command): string | undefined {
  const { ap, s } = w;
  const t = typeOf(ac.type);
  switch (c.t) {
    case 'DEP_CLEARANCE': {
      ac.depCleared = true;
      const deps = ap.fixes.filter((f) => f.kind === 'departure');
      let h = 0;
      for (const ch of ac.dest) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      ac.depFix = deps[h % deps.length]?.name;
      ac.tgtAlt = 5000;
      ac.flags.pushReqAt = s.t + randRange(s, 12, 30);
      clearRequest(ac, 'clearance');
      return;
    }
    case 'PUSHBACK': {
      // face toward the likely departure runway when no direction is given
      let toward: number | undefined;
      const depEnd = endRef(ap, ac.rwy ?? s.activeConfig.dep[0]);
      if (depEnd) toward = depEnd.rwy.nodes[depEnd.idx === 0 ? 0 : depEnd.rwy.nodes.length - 1];
      const route = pushbackRoute(w, ac, c.face, toward);
      if (!route) return 'unable to push from this stand';
      ac.pushApproved = true;
      clearRequest(ac, 'pushback');
      startPushback(w, ac, route);
      return;
    }
    case 'TAXI': {
      const plan = planTaxi(w, ac, c);
      if (typeof plan === 'string') return plan;
      const wasStopped = ac.phase === 'push_done' || ac.phase === 'vacated';
      setRoute(ap, ac, plan.route.nodes, plan.route.names);
      if (plan.stopS !== undefined) ac.routeStop = Math.min(ac.routeStop, plan.stopS + ac.routeS);
      ac.holdPos = false;
      if (plan.gate) {
        ac.gate = plan.gate;
        ac.phase = 'taxi_in';
        ac.kind = 'arrival';
      } else {
        ac.rwy = plan.rwy;
        ac.phase = 'taxi_out';
        ac.lineUpCleared = ac.takeoffCleared = false;
      }
      if (wasStopped || !ac.taxiIdeal) ac.taxiIdeal = plan.route.len / (t.taxiKt * KT * 0.8) + (ac.kind === 'departure' ? 70 : 25);
      ac.crossCleared = [];
      clearRequest(ac, 'taxi', 'taxi_in', 'tow', 'crossing');
      return;
    }
    case 'HOLD_POSITION': ac.holdPos = true; if (ac.phase === 'lined_up') ac.takeoffCleared = false; return;
    case 'CONTINUE_TAXI': ac.holdPos = false; return;
    case 'CROSS': {
      const id = rwyIdOf(w, c.rwy)!;
      if (!ac.crossCleared.includes(id)) ac.crossCleared.push(id);
      delete ac.flags['in:' + id];
      clearRequest(ac, 'crossing');
      return;
    }
    case 'LINE_UP':
      ac.lineUpCleared = true;
      ac.holdPos = false;
      if (ac.phase === 'holding_short') startLineUp(w, ac);
      clearRequest(ac, 'takeoff');
      return;
    case 'TAKEOFF': {
      ac.takeoffCleared = true;
      ac.lineUpCleared = true;
      ac.holdPos = false;
      if (ac.phase === 'holding_short') startLineUp(w, ac);
      clearRequest(ac, 'takeoff');
      // record a wake violation if the crew accepted an early departure (no assistance)
      const e = endRef(ap, ac.rwy)!;
      const last = s.rwy[e.rwy.id].lastDep[e.end.name];
      if (last && last.ac !== ac.id && s.cfg.difficulty.wakeSeparation) {
        const need = wakeDepartureInterval(last.wake, t.wake);
        if (need > 60 && s.t - last.t < need - 8) {
          s.stats.wakeViolations++;
          s.stats.safetyPenalty += 4;
          logEvent(w, 'wake', 'warning', `Wake turbulence separation not provided: ${ac.callsign} cleared for takeoff ${Math.round(s.t - last.t)} s behind a ${last.wake === 'J' ? 'super' : 'heavy'} (required ${need} s)`, [ac]);
        }
      }
      return;
    }
    case 'CANCEL_TAKEOFF':
      if (ac.phase === 'takeoff_roll') rejectTakeoff(w, ac, 'takeoff clearance cancelled');
      else { ac.takeoffCleared = false; ac.flags.rollAt = 0; }
      return;
    case 'HEADING':
      if (!isAirborne(ac)) { ac.flags.depHdg = c.hdg || 360; ac.flags.depDirect = 0; return; }
      breakOff(w, ac);
      ac.latMode = 'hdg';
      ac.tgtHdg = c.hdg;
      ac.turnDir = c.dir === 'L' ? -1 : c.dir === 'R' ? 1 : 0;
      ac.flags.vectored = 1;
      ac.flags.holdTold = 0;
      clearRequest(ac, 'approach', 'departure', 'emergency');
      return;
    case 'ALTITUDE':
      ac.tgtAlt = c.alt;
      if (isAirborne(ac)) clearRequest(ac, 'emergency');
      if (ac.phase === 'departure' && c.alt >= 10000 && (ac.latMode === 'fix' || ac.flags.vectored)) clearRequest(ac, 'departure');
      return;
    case 'SPEED': ac.tgtSpd = c.spd; return;
    case 'DIRECT':
      if (!isAirborne(ac)) { ac.fix = c.fix.toUpperCase(); ac.flags.depDirect = 1; return; }
      breakOff(w, ac);
      ac.latMode = 'fix';
      ac.fix = c.fix.toUpperCase();
      ac.turnDir = 0;
      ac.flags.vectored = 1;
      ac.flags.holdTold = 0;
      clearRequest(ac, 'approach', 'emergency');
      if (ac.phase === 'departure' && ac.tgtAlt >= 10000) clearRequest(ac, 'departure');
      return;
    case 'HOLD':
      breakOff(w, ac);
      ac.flags.holdTold = 1;
      ac.flags.holdStart = s.t;
      if (c.fix) { ac.latMode = 'fix'; ac.fix = c.fix.toUpperCase(); ac.flags.holdTold = 1; }
      else {
        // hold at present position: synthesise by holding on the current fix or flying a racetrack here
        ac.latMode = 'hold';
        ac.flags.holdCrs = Math.round(ac.track);
        ac.holdOut = true;
        ac.holdLeg = 0;
        if (!fixByName(w, ac.fix)) {
          const posts = ap.fixes.filter((f) => f.kind === 'arrival').sort((a, b) => dist(ac.x, ac.y, a.x, a.y) - dist(ac.x, ac.y, b.x, b.y));
          ac.fix = posts[0]?.name;
          ac.latMode = 'fix';
        }
      }
      clearRequest(ac, 'approach');
      return;
    case 'APPROACH': {
      const name = normRwyName(ap, c.rwy)!;
      ac.rwy = name;
      ac.apprCleared = true;
      ac.landCleared = false;
      ac.established = false;
      ac.phase = 'approach';
      ac.flags.locMiss = 0; ac.flags.locAngle = 0; ac.flags.rwyChecked = 0; ac.flags.minimaChecked = 0;
      if (ac.latMode === 'loc') ac.latMode = 'hdg';
      if (ac.latMode === 'hold' || (ac.latMode === 'fix' && !ac.flags.vectored)) {
        // released from the hold / own navigation: proceed direct to the final approach fix
        ac.latMode = 'fix';
        ac.fix = `F${name}`;
      }
      ac.turnDir = 0;
      // crews descend to the platform altitude on their own once cleared for the approach
      if (ac.tgtAlt > 4000 && dist(ac.x, ac.y, 0, 0) < 16 * NM) ac.tgtAlt = 3000;
      clearRequest(ac, 'approach', 'emergency');
      return;
    }
    case 'LAND':
      ac.landCleared = true;
      clearRequest(ac, 'landing', 'emergency');
      return;
    case 'GO_AROUND':
      if (ac.emergency && !ac.emergency.resolved) { s.stats.safetyPenalty += 4; logEvent(w, 'emergency', 'warning', `Emergency aircraft ${ac.callsign} was sent around`, [ac]); }
      goAround(w, ac, 'instructed by ATC', false);
      return;
    case 'ASSIGN_RUNWAY': ac.rwy = normRwyName(ap, c.rwy); return;
    case 'ASSIGN_GATE': {
      const g = gateByName(ap, c.gate)!;
      if (gateUser(w, g.name, ac)) return `gate ${g.name} is no longer available`;
      ac.gate = g.name;
      if (ac.phase === 'taxi_in') return apply(w, ac, { t: 'TAXI', gate: g.name });
      return;
    }
    case 'EXIT': ac.exitPref = c.twy.toUpperCase(); return;
    case 'HANDOFF':
      ac.handedOff = true;
      clearRequest(ac);
      return;
    case 'TOW':
      if (!startTow(w, ac)) return 'unable to reposition from here';
      s.stats.safetyPenalty += 0.5;
      clearRequest(ac, 'tow');
      logEvent(w, 'system', 'info', `${ac.callsign} is being repositioned by a tug`, [ac]);
      return;
  }
}

/** a vector / new routing cancels any approach clearance */
function breakOff(w: World, ac: Aircraft) {
  if (ac.phase === 'approach' || ac.phase === 'final') {
    ac.phase = 'inbound';
    ac.apprCleared = ac.landCleared = ac.established = false;
    if (ac.alt < ac.tgtAlt) ac.tgtAlt = Math.max(ac.tgtAlt, 2000);
    if (ac.tgtAlt < ac.alt - 200) ac.tgtAlt = Math.max(2000, Math.round(ac.alt / 100) * 100);
    logEvent(w, 'system', 'info', `${ac.callsign} approach clearance cancelled (vectored off the approach)`, [ac]);
  }
}

/** Issue a transmission to an aircraft. */
export function issue(w: World, ac: Aircraft, cmds: Command[], by: 'player' | 'ai' = 'player'): CommandResult {
  const { s, ap } = w;
  if (s.over) return { ok: false, message: 'The scenario has ended.' };
  if (!cmds.length) return { ok: false, message: 'No instruction.' };
  if (by === 'player') s.stats.commands++;
  for (let i = 0; i < cmds.length; i++) {
    const err = validate(w, ac, cmds[i], cmds.slice(0, i));
    if (err) {
      if (by === 'player') s.stats.rejectedCommands++;
      return { ok: false, message: err.charAt(0).toUpperCase() + err.slice(1) + '.' };
    }
  }
  // resolve taxi names for phraseology
  let taxiNames: string[] | undefined;
  for (const c of cmds) if (c.t === 'TAXI') { const p = planTaxi(w, ac, c); if (typeof p !== 'string') taxiNames = p.route.names; }
  const needsWind = cmds.some((c) => c.t === 'TAKEOFF' || c.t === 'LAND');
  radioAtc(w, ac, atcPhrase(ap, ac, cmds, { taxiNames, wind: needsWind ? sayWind(s.weather) : undefined }));
  for (const c of cmds) {
    const no = pilotCheck(w, ac, c);
    if (no) {
      radioPilot(w, ac, `Unable, ${no}, ${csay(ac)}.`);
      logEvent(w, 'pilot_action', 'advisory', `${ac.callsign} refused "${c.t.replace('_', ' ').toLowerCase()}": ${no}`, [ac]);
      return { ok: false, refused: true, message: `${ac.callsign} unable: ${no}.` };
    }
  }
  // radio realism: missed calls and incorrect readbacks
  const rc = s.cfg.difficulty.radioComplexity;
  let applied = cmds;
  let missed = false;
  if (rc > 0 && by === 'player') {
    const r = rand(s);
    if (r < 0.035 * rc) missed = true;
    else if (r < 0.085 * rc) {
      applied = cmds.map((c) => {
        if (c.t === 'HEADING') return { ...c, hdg: norm360(c.hdg + (rand(s) < 0.5 ? 10 : -10) * (1 + Math.floor(rand(s) * 2))) };
        if (c.t === 'ALTITUDE' && c.alt >= 3000) return { ...c, alt: c.alt + (rand(s) < 0.5 ? 1000 : -1000) };
        return c;
      });
    }
  }
  const slow = ac.emergency && !ac.emergency.resolved && ac.emergency.kind === 'electrical';
  const at = s.t + (slow ? randRange(s, 7, 14) : randRange(s, 1.6, 3.2));
  const readback = readbackPhrase(ap, ac, applied, { taxiNames });
  ac.flags.pending = 1;
  s.pending.push({ at, ac: ac.id, cmds: missed ? [] : applied, readback: missed ? '' : readback, by });
  return { ok: true };
}

/** deliver readbacks that are due and apply their instructions */
export function processPending(w: World) {
  const { s } = w;
  if (!s.pending.length) return;
  const due: PendingTx[] = [];
  s.pending = s.pending.filter((p) => (p.at <= s.t ? (due.push(p), false) : true));
  for (const p of due) {
    const ac = s.aircraft.find((a) => a.id === p.ac);
    if (!ac) continue;
    ac.flags.pending = 0;
    if (!p.cmds.length) {
      radioSystem(w, `(no reply from ${ac.callsign} – transmission blocked, say again)`);
      continue;
    }
    let fail: string | undefined;
    const done: Command[] = [];
    for (const c of p.cmds) {
      fail = apply(w, ac, c);
      if (fail) break;
      done.push(c);
    }
    if (fail) radioPilot(w, ac, `Unable, ${fail}, ${csay(ac)}.`);
    else radioPilot(w, ac, p.readback);
  }
}
