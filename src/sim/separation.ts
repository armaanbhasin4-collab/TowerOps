/**
 * Continuous safety monitoring: airborne separation (radar, wake, parallel-runway and departure
 * divergence rules), predicted conflicts, TCAS-style resolution, runway incursions,
 * surface collisions and taxi deadlocks. Runs once per simulated second.
 */
import type { Aircraft, Alert, WakeCat } from './types';
import { NM, alongCross, angDiff, dist, vecOf } from './util';
import { typeOf } from './data/aircraft';
import { endRef, runwayZoneAt } from './airport/query';
import { World, isAirborne, logEvent, radioPilot, csay, onSurface } from './world';
import { predict } from './air';
import { crash } from './emergencies';
import { runwayOccupants } from './ground';

/** required in-trail distance (NM) for follower behind leader on the same final */
export function wakeMinimum(leader: WakeCat, follower: WakeCat): number {
  if (leader === 'J') return follower === 'J' ? 4 : follower === 'H' ? 6 : follower === 'M' ? 7 : 8;
  if (leader === 'H') return follower === 'H' || follower === 'J' ? 4 : follower === 'M' ? 5 : 6;
  if (leader === 'M') return follower === 'L' ? 4 : 3;
  return 3;
}
/** required time (s) before a departure may roll behind a preceding departure on the same runway */
export function wakeDepartureInterval(leader: WakeCat, follower: WakeCat): number {
  if (leader === 'J') return follower === 'J' ? 60 : 180;
  if (leader === 'H') return follower === 'H' || follower === 'J' ? 60 : 120;
  if (leader === 'M' && follower === 'L') return 120;
  return 50;
}

const seen = new WeakMap<object, Map<string, number>>();
function once(w: World, key: string, active: boolean): boolean {
  let m = seen.get(w.s);
  if (!m) { m = new Map(); seen.set(w.s, m); }
  if (active) {
    const first = !m.has(key);
    m.set(key, w.s.t);
    return first;
  }
  // forget after it has been inactive for 20 s (hysteresis)
  const last = m.get(key);
  if (last !== undefined && w.s.t - last > 20) m.delete(key);
  return false;
}

export function updateSeparation(w: World) {
  const { s, ap } = w;
  const d = s.cfg.difficulty;
  const alerts: Alert[] = [];
  const air = s.aircraft.filter((a) => isAirborne(a) && a.alt > 80);
  const latMin = d.strictSeparation ? 3 : 2;

  for (let i = 0; i < air.length; i++) {
    const a = air[i];
    for (let j = i + 1; j < air.length; j++) {
      const b = air[j];
      const lat = dist(a.x, a.y, b.x, b.y) / NM;
      if (lat > 12) continue;
      const dv = Math.abs(a.alt - b.alt);
      const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
      const ea = endRef(ap, a.rwy), eb = endRef(ap, b.rwy);
      let req = latMin;
      let kind: Alert['kind'] = 'airborne';
      let exempt = false;
      const parallel = ea && eb && ea.rwy.id !== eb.rwy.id && (Math.abs(angDiff(ea.end.hdg, eb.end.hdg)) < 12);
      const estA = a.phase === 'final', estB = b.phase === 'final';
      const lowDepA = (a.phase === 'departure' || a.phase === 'go_around') && a.alt < 3500;
      const lowDepB = (b.phase === 'departure' || b.phase === 'go_around') && b.alt < 3500;
      if (parallel && estA && estB) exempt = true; // simultaneous parallel approaches
      else if (parallel && ((estA && lowDepB) || (estB && lowDepA))) exempt = true; // arrival vs departure on parallel runways
      else if (ea && eb && ea.rwy.id !== eb.rwy.id && !parallel && ((estA && lowDepB) || (estB && lowDepA)) && Math.min(a.alt, b.alt) < 1000) req = 1; // tower-applied visual separation, intersecting runways
      else if (estA && estB && ea && eb && ea.end.name === eb.end.name) {
        // in trail on the same final
        const da = dist(a.x, a.y, ea.end.x, ea.end.y), db = dist(b.x, b.y, ea.end.x, ea.end.y);
        const [lead, foll] = da < db ? [a, b] : [b, a];
        req = d.wakeSeparation ? wakeMinimum(typeOf(lead.type).wake, typeOf(foll.type).wake) : latMin;
        if (req <= 3 && !d.strictSeparation) req = 2;
        else if (req <= 3) req = Math.min(da, db) < 10 * NM ? 2.5 : 3;
        kind = req > 3 ? 'wake' : 'approach';
      } else if (lowDepA && lowDepB) {
        // successive departures: 1 NM if courses diverge by 15° or more
        req = Math.abs(angDiff(a.track, b.track)) >= 15 ? 1 : latMin;
      } else if ((lowDepA && a.alt < 600) || (lowDepB && b.alt < 600)) {
        if (ea && eb && ea.rwy.id !== eb.rwy.id) req = Math.min(req, 1);
      }
      const viol = !exempt && lat < req && dv < 950;
      if (viol) {
        const crit = lat < 0.6 && dv < 450;
        alerts.push({ key: 'sep:' + key, level: crit ? 'critical' : 'violation', kind, ac: [a.id, b.id], since: s.t, text: `${a.callsign} / ${b.callsign} ${lat.toFixed(1)} NM, ${Math.round(dv / 100) * 100} ft${kind === 'wake' ? ` (wake: ${req} NM required)` : ''}` });
        if (once(w, 'sep:' + key, true)) {
          if (kind === 'wake') s.stats.wakeViolations++; else s.stats.separationViolations++;
          s.stats.safetyPenalty += kind === 'wake' ? 4 : 7;
          logEvent(w, kind === 'wake' ? 'wake' : 'separation', 'warning', `Loss of separation: ${a.callsign} and ${b.callsign} – ${lat.toFixed(1)} NM / ${Math.round(dv)} ft (required ${req} NM or 1000 ft)`, [a, b]);
        }
        if (crit && once(w, 'nm:' + key, true)) {
          s.stats.nearMisses++;
          s.stats.safetyPenalty += 18;
          logEvent(w, 'near_miss', 'critical', `NEAR MID-AIR COLLISION: ${a.callsign} and ${b.callsign} – ${(lat * NM).toFixed(0)} m / ${Math.round(dv)} ft`, [a, b]);
        }
        if (lat * NM < 75 && dv < 90) {
          crash(w, a, `collided in mid-air with ${b.callsign}`);
          crash(w, b, `collided in mid-air with ${a.callsign}`);
          s.stats.collisions--; // one accident, two aircraft
        }
      } else {
        once(w, 'sep:' + key, false);
        once(w, 'nm:' + key, false);
        if (!exempt) {
          // conflict prediction (45 s look-ahead)
          for (const tLook of [20, 45]) {
            const [ax, ay, az] = predict(a, tLook), [bx, by, bz] = predict(b, tLook);
            // altitude prediction is capped at the cleared level
            const aAlt = a.vs > 0 ? Math.min(az, Math.max(a.alt, a.tgtAlt)) : Math.max(az, Math.min(a.alt, a.tgtAlt));
            const bAlt = b.vs > 0 ? Math.min(bz, Math.max(b.alt, b.tgtAlt)) : Math.max(bz, Math.min(b.alt, b.tgtAlt));
            const pl = dist(ax, ay, bx, by) / NM;
            if (pl < req * 0.92 && Math.abs(aAlt - bAlt) < 900) {
              alerts.push({ key: 'pre:' + key, level: 'predict', kind, ac: [a.id, b.id], since: s.t, text: `Conflict alert: ${a.callsign} / ${b.callsign} in ${tLook} s` });
              // TCAS-style resolution when collision is imminent and the safety net is enabled
              if (d.safetyIntervention && tLook === 20 && pl < 0.8 && Math.abs(aAlt - bAlt) < 500 && !(estA || estB)) {
                const [hi, lo] = a.alt >= b.alt ? [a, b] : [b, a];
                if (!(hi.flags.raUntil > s.t)) {
                  hi.flags.raUntil = s.t + 18; hi.flags.raDir = 1;
                  lo.flags.raUntil = s.t + 18; lo.flags.raDir = -1;
                  radioPilot(w, hi, `${csay(hi)}, TCAS RA, climbing.`);
                  radioPilot(w, lo, `${csay(lo)}, TCAS RA, descending.`);
                  logEvent(w, 'pilot_action', 'warning', `TCAS resolution advisory: ${hi.callsign} climbing, ${lo.callsign} descending (pilot safety action)`, [hi, lo]);
                }
              }
              break;
            }
          }
        }
      }
    }
  }

  // ── runway safety ──
  for (const r of ap.runways) {
    const occ = runwayOccupants(w, r);
    const st = s.rwy[r.id];
    if (occ.length || air.some((a) => a.phase === 'final' && endRef(ap, a.rwy)?.rwy.id === r.id && dist(a.x, a.y, 0, 0) < 3 * NM)) st.busySeconds++;
    for (const roller of occ) {
      const fast = (roller.phase === 'takeoff_roll' && roller.gs > 25) || (roller.phase === 'landing_roll' && roller.route.length < 2 && roller.gs > 45);
      if (!fast) continue;
      const e = endRef(ap, roller.rwy);
      if (!e) continue;
      for (const o of occ) {
        if (o === roller) continue;
        const [al, cr] = alongCross(o.x, o.y, roller.x, roller.y, e.end.hdg);
        if (al < 20 || al > 2400) continue;
        if (o.phase === 'takeoff_roll' && o.gs > roller.gs) continue;
        const key = `inc:${roller.id}-${o.id}`;
        alerts.push({ key, level: 'critical', kind: 'runway', ac: [roller.id, o.id], since: s.t, text: `RUNWAY CONFLICT ${r.id}: ${roller.callsign} rolling, ${o.callsign} on runway ${Math.round(al)} m ahead` });
        if (once(w, key, true)) {
          s.stats.incursions++;
          s.stats.safetyPenalty += 14;
          logEvent(w, 'incursion', 'critical', `RUNWAY INCURSION ${r.id}: ${roller.callsign} ${roller.phase === 'takeoff_roll' ? 'departing' : 'landing'} with ${o.callsign} on the runway`, [roller, o]);
        }
        void cr;
      }
    }
    // short-final traffic with an occupied runway
    for (const a of air) {
      if (a.phase !== 'final') continue;
      const e = endRef(ap, a.rwy);
      if (!e || e.rwy.id !== r.id) continue;
      const dThr = dist(a.x, a.y, e.end.x, e.end.y);
      if (dThr < 1.6 * NM && occ.some((o) => !(o.phase === 'takeoff_roll' && o.gs > 80))) {
        alerts.push({ key: `fin:${a.id}`, level: dThr < 0.8 * NM ? 'critical' : 'violation', kind: 'runway', ac: [a.id, ...occ.map((o) => o.id)], since: s.t, text: `${a.callsign} ${(dThr / NM).toFixed(1)} NM final, runway ${a.rwy} occupied by ${occ.map((o) => o.callsign).join(', ')}` });
      }
    }
    // entering a runway without any clearance (pilot deviation)
    for (const o of occ) {
      const moving = o.phase === 'taxi_out' || o.phase === 'taxi_in';
      if (!moving || o.gs < 1) continue;
      if (o.crossCleared.includes(r.id) || o.flags['in:' + r.id] === 2) continue;
      const dep = endRef(ap, o.rwy);
      if (dep?.rwy.id === r.id && (o.lineUpCleared || o.takeoffCleared)) continue;
      if (o.lastRwy && endRef(ap, o.lastRwy)?.rwy.id === r.id) continue;
      if (once(w, `dev:${o.id}:${r.id}`, true)) {
        o.flags['in:' + r.id] = 2;
        s.stats.incursions++;
        s.stats.safetyPenalty += 8;
        logEvent(w, 'incursion', 'critical', `RUNWAY INCURSION ${r.id}: ${o.callsign} entered the runway without clearance`, [o]);
      }
    }
  }

  // ── surface collisions & deadlocks ──
  const ground = s.aircraft.filter((a) => onSurface(a));
  for (let i = 0; i < ground.length; i++) {
    const a = ground[i];
    for (let j = i + 1; j < ground.length; j++) {
      const b = ground[j];
      if (a.gs < 0.5 && b.gs < 0.5) {
        if (a.blockedBy === b.id && b.blockedBy === a.id && s.t - (a.blockedSince ?? s.t) > 20) {
          alerts.push({ key: `dl:${a.id}-${b.id}`, level: 'violation', kind: 'ground', ac: [a.id, b.id], since: s.t, text: `Taxi conflict: ${a.callsign} and ${b.callsign} are blocking each other` });
          if (once(w, `dl:${a.id}-${b.id}`, true)) {
            s.stats.groundConflicts++;
            s.stats.safetyPenalty += 2;
            logEvent(w, 'conflict', 'warning', `Taxi conflict: ${a.callsign} and ${b.callsign} are nose-to-nose and cannot proceed – re-route or tow one of them`, [a, b]);
            radioPilot(w, a, `${ap.facility} Ground, ${csay(a)}, we are nose to nose with traffic, unable to continue.`);
            if (!a.request) a.request = { type: 'tow', since: s.t, text: 'Blocked head-on – needs re-route or tow' };
            if (!b.request) b.request = { type: 'tow', since: s.t, text: 'Blocked head-on – needs re-route or tow' };
          }
        }
        continue;
      }
      const gap = dist(a.x, a.y, b.x, b.y);
      const ta = typeOf(a.type), tb = typeOf(b.type);
      if (gap > (ta.length + tb.length) / 2 + 10) continue;
      if (a.phase === 'disabled' && b.phase === 'disabled') continue;
      // fuselage/wing overlap test with body points
      const pts = (ac: Aircraft, t: typeof ta): [number, number, number][] => {
        const [ux, uy] = vecOf(ac.hdg);
        return [[ac.x, ac.y, t.span * 0.36], [ac.x + ux * t.length * 0.4, ac.y + uy * t.length * 0.4, 2.5], [ac.x - ux * t.length * 0.4, ac.y - uy * t.length * 0.4, 3.5]];
      };
      let hit = false;
      for (const [x1, y1, r1] of pts(a, ta)) for (const [x2, y2, r2] of pts(b, tb)) if (dist(x1, y1, x2, y2) < (r1 + r2) * 0.8) hit = true;
      if (hit && once(w, `col:${a.id}-${b.id}`, true)) {
        for (const ac of [a, b]) {
          ac.phase = 'disabled'; ac.gs = 0; ac.flags.wreck = 1; ac.request = undefined; ac.route = [];
          if (ac.emergency && !ac.emergency.resolved) s.stats.emergenciesFailed++;
        }
        s.stats.collisions++;
        s.stats.safetyPenalty += 55;
        const zone = runwayZoneAt(ap, a.x, a.y);
        logEvent(w, 'collision', 'critical', `GROUND COLLISION: ${a.callsign} and ${b.callsign}${zone ? ` on runway ${zone.id}` : ''}`, [a, b]);
        if (d.collisionEnds) { s.over = true; s.overReason = `Ground collision between ${a.callsign} and ${b.callsign}`; }
      }
    }
  }
  // long traffic blocks (not mutual) – advisory only
  for (const a of ground) {
    if (a.blockedBy !== undefined && s.t - (a.blockedSince ?? s.t) > 90) {
      const b = s.aircraft.find((x) => x.id === a.blockedBy);
      if (b && b.blockedBy !== a.id) alerts.push({ key: `blk:${a.id}`, level: 'predict', kind: 'ground', ac: [a.id, b.id], since: s.t, text: `${a.callsign} held up behind ${b.callsign} for ${Math.round((s.t - (a.blockedSince ?? s.t)) / 60)} min` });
    }
  }
  s.alerts = alerts;
}
