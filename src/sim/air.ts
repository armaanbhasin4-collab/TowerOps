/**
 * Airborne flight model: heading/fix/hold/localiser guidance, speed and vertical profiles,
 * wind drift, ILS capture, stabilised-approach checks, touchdown, go-around and departure climb.
 *
 * Simplifications (documented): headings are treated as true; IAS→TAS uses +1.7%/1000 ft;
 * wind aloft is scaled from the surface wind; glidepath is a 3° path to a point 300 m past the threshold.
 */
import type { Aircraft, Fix } from './types';
import { DEG, KT, NM, alongCross, angDiff, approach, clamp, dist, hdgOf, norm360, vecOf } from './util';
import { typeOf } from './data/aircraft';
import { endRef, windComponents } from './airport/query';
import { World, clearRequest, csay, logEvent, radioPilot, setRequest, isAirborne } from './world';
import { sayAlt, sayRwy } from './phraseology';
import { runwayOccupants } from './ground';

export const GS_FT_PER_M = Math.tan(3 * DEG) / 0.3048; // ft of height per metre of distance on a 3° path
const TDZ = 300; // m touchdown point past threshold

export function fixByName(w: World, name: string | undefined): Fix | undefined {
  if (!name) return undefined;
  const u = name.toUpperCase();
  return w.ap.fixes.find((f) => f.name === u);
}

export function windAt(w: World, alt: number): { dir: number; kt: number } {
  const wx = w.s.weather;
  return { dir: wx.windDir, kt: wx.windKt * (1 + Math.min(alt, 10000) / 8000) };
}

function emKind(ac: Aircraft) {
  return ac.emergency && !ac.emergency.resolved ? ac.emergency.kind : undefined;
}

/** minimum speed the crew will accept in the current configuration */
export function minSpeed(w: World, ac: Aircraft): number {
  const t = typeOf(ac.type);
  const d = dist(ac.x, ac.y, 0, 0);
  if (ac.phase === 'final') return t.vref;
  if (ac.kind === 'arrival' && (d < 22 * NM || ac.alt < 6000)) return t.vref + 15;
  return t.vClean - 30;
}

export function goAround(w: World, ac: Aircraft, why: string, byPilot: boolean) {
  const { s, ap } = w;
  const e = endRef(ap, ac.rwy);
  ac.phase = 'go_around';
  ac.apprCleared = ac.landCleared = ac.established = false;
  ac.latMode = 'hdg';
  ac.tgtHdg = e ? e.end.hdg : ac.hdg;
  ac.turnDir = 0;
  ac.tgtAlt = 3000;
  ac.tgtSpd = 0;
  ac.goArounds++;
  ac.flags.gaAt = s.t;
  s.stats.goArounds++;
  if (byPilot) {
    s.stats.pilotGoArounds++;
    radioPilot(w, ac, `${csay(ac)} going around, ${why}.`);
  }
  clearRequest(ac);
  logEvent(w, 'go_around', byPilot ? 'warning' : 'info', `${ac.callsign} going around${why ? ` – ${why}` : ''}`, [ac]);
}

function touchdown(w: World, ac: Aircraft) {
  const { s, ap } = w;
  const e = endRef(ap, ac.rwy)!;
  const t = typeOf(ac.type);
  const [al] = alongCross(ac.x, ac.y, e.end.x, e.end.y, e.end.hdg);
  const [ux, uy] = vecOf(e.end.hdg);
  ac.x = e.end.x + ux * al;
  ac.y = e.end.y + uy * al;
  ac.rwyDist = al;
  ac.alt = 0;
  ac.vs = 0;
  ac.hdg = e.end.hdg;
  ac.phase = 'landing_roll';
  ac.route = [];
  ac.gs = Math.max(60, ac.gs - 6);
  ac.landedAt = s.t;
  ac.lastRwy = ac.rwy;
  clearRequest(ac);
  const st = s.rwy[e.rwy.id];
  st.movements++;
  st.lastArr[e.end.name] = { t: s.t, wake: t.wake, ac: ac.id };
  s.stats.landed++;
  if (!ac.landCleared) {
    // can only happen for NORDO/emergency logic; record as an incursion
    logEvent(w, 'incursion', 'critical', `${ac.callsign} landed runway ${ac.rwy} without a landing clearance`, [ac]);
    s.stats.incursions++;
    s.stats.safetyPenalty += 12;
  }
  logEvent(w, 'landing', 'info', `${ac.callsign} landed runway ${ac.rwy}`, [ac]);
}

export function updateAirborne(w: World, ac: Aircraft, dt: number) {
  const { s, ap } = w;
  const t = typeOf(ac.type);
  const wx = s.weather;
  const em = emKind(ac);
  const wind = windAt(w, ac.alt);
  const tasKt = ac.ias * (1 + (ac.alt / 1000) * 0.017);
  const e = endRef(ap, ac.rwy);

  // ── approach geometry ──
  let dThr = Infinity, cross = 0, along = 0;
  if (e && (ac.phase === 'approach' || ac.phase === 'final')) {
    [along, cross] = alongCross(ac.x, ac.y, e.end.x, e.end.y, e.end.hdg);
    dThr = -along;
  }

  // ── lateral guidance ──
  let desiredTrack: number | undefined;
  let desiredHdg = ac.tgtHdg;
  if (ac.latMode === 'fix' || ac.latMode === 'hold') {
    const f = fixByName(w, ac.fix);
    if (!f) {
      ac.latMode = 'hdg';
      ac.tgtHdg = ac.hdg;
    } else {
      const d = dist(ac.x, ac.y, f.x, f.y);
      if (ac.latMode === 'fix') {
        desiredTrack = hdgOf(f.x - ac.x, f.y - ac.y);
        if (d < 900) {
          if (ac.kind === 'departure') {
            ac.latMode = 'hdg';
            ac.tgtHdg = hdgOf(f.x, f.y); // continue outbound on the radial
          } else if (ac.phase === 'approach' && f.kind === 'final' && f.rwy === ac.rwy) {
            ac.latMode = 'hdg';
            ac.tgtHdg = e!.end.hdg;
          } else {
            // clearance limit reached without further instructions: hold
            ac.latMode = 'hold';
            ac.holdOut = true;
            ac.holdLeg = 0;
            ac.flags.holdCrs = Math.round(ac.track);
            if (!ac.flags.holdTold) {
              ac.flags.holdTold = 1;
              ac.flags.holdStart = s.t;
              setRequest(w, ac, 'approach', `${ap.facility} Approach, ${csay(ac)}, entering the hold at ${f.name}, ${sayAlt(Math.round(ac.alt / 100) * 100)}, request vectors for the approach.`);
            }
          }
        }
      }
      if (ac.latMode === 'hold') {
        const crs = ac.flags.holdCrs ?? 0;
        if (ac.holdOut) {
          desiredHdg = norm360(crs + 180);
          ac.turnDir = Math.abs(angDiff(ac.hdg, desiredHdg)) > 20 ? 1 : 0;
          if (Math.abs(angDiff(ac.hdg, desiredHdg)) < 12) ac.holdLeg = (ac.holdLeg ?? 0) + dt;
          if ((ac.holdLeg ?? 0) > 55) { ac.holdOut = false; ac.holdLeg = 0; }
        } else {
          desiredTrack = hdgOf(f.x - ac.x, f.y - ac.y);
          ac.turnDir = Math.abs(angDiff(ac.hdg, desiredTrack)) > 100 ? 1 : 0;
          if (d < 900) { ac.holdOut = true; ac.holdLeg = 0; }
        }
      }
    }
  }

  // ILS capture
  if (ac.phase === 'approach' && e && ac.latMode !== 'loc') {
    const v = tasKt * KT;
    const rate = Math.min(3, (9.81 * Math.tan(25 * DEG) / Math.max(v, 40)) / DEG);
    const radius = v / (rate * DEG);
    const ang = Math.abs(angDiff(ac.track, e.end.hdg));
    const anticip = radius * (1 - Math.cos(Math.min(ang, 90) * DEG)) + 120;
    const closing = cross * angDiff(e.end.hdg, ac.track) < 0 || Math.abs(cross) < 250;
    if (dThr > 1.5 * NM && dThr < 26 * NM && Math.abs(cross) < anticip && ang <= 95 && closing) {
      ac.latMode = 'loc';
      ac.phase = 'final';
      ac.established = true;
      ac.turnDir = 0;
      ac.fix = undefined;
      if (!ac.landCleared) {
        setRequest(w, ac, 'landing', `${ap.facility} Tower, ${csay(ac)}, established ILS runway ${sayRwy(ac.rwy!)}, ${(dThr / NM).toFixed(0)} mile final.`);
      } else clearRequest(ac, 'approach');
    } else if (dThr < 1.5 * NM && dThr > -NM && !ac.flags.locMiss) {
      ac.flags.locMiss = 1;
      radioPilot(w, ac, `${csay(ac)} unable to intercept the localizer from this position, request vectors.`);
      ac.phase = 'inbound';
      ac.apprCleared = false;
      ac.request = { type: 'approach', since: s.t, text: 'Missed the localizer – needs new vectors' };
    } else if (ang > 95 && Math.abs(cross) < anticip && dThr > 0 && dThr < 26 * NM && !ac.flags.locAngle) {
      ac.flags.locAngle = s.t;
      radioPilot(w, ac, `${csay(ac)} unable to capture the localizer, intercept angle too large, request vectors.`);
    }
  }
  if (ac.latMode === 'loc' && e) {
    const corr = clamp(cross / 28, -32, 32);
    desiredTrack = norm360(e.end.hdg - corr);
  }

  // wind correction when tracking a ground track
  if (desiredTrack !== undefined) {
    const wc = wind.kt * Math.sin(angDiff(desiredTrack, wind.dir) * DEG);
    const crab = Math.asin(clamp(wc / Math.max(tasKt, 60), -0.5, 0.5)) / DEG;
    desiredHdg = norm360(desiredTrack + crab);
  }

  // ── turn ──
  const v = Math.max(tasKt * KT, 40);
  let rate = Math.min(3, (9.81 * Math.tan(25 * DEG) / v) / DEG);
  if (em === 'flight_control') rate *= 0.45;
  if (em === 'hydraulic') rate *= 0.7;
  let dh = angDiff(ac.hdg, desiredHdg);
  if (ac.turnDir !== 0 && Math.abs(dh) > 8) {
    if (ac.turnDir === 1 && dh < 0) dh += 360;
    if (ac.turnDir === -1 && dh > 0) dh -= 360;
  } else if (Math.abs(dh) <= 8 && ac.latMode === 'hdg') ac.turnDir = 0;
  ac.hdg = norm360(ac.hdg + clamp(dh, -rate * dt, rate * dt));

  // ── speed ──
  let tgt: number;
  const dField = dist(ac.x, ac.y, 0, 0);
  const vapp = t.vref + 5 + Math.min(10, wx.gustKt > wx.windKt ? (wx.gustKt - wx.windKt) / 2 : 0) + (em === 'flight_control' || em === 'hydraulic' ? 15 : 0);
  if (ac.phase === 'departure' || ac.phase === 'go_around') {
    tgt = ac.alt < 1000 ? t.vr + 15 : ac.tgtSpd || (ac.phase === 'go_around' ? Math.min(t.cruiseKt, t.vClean) : t.cruiseKt);
    if (em === 'engine_failure') tgt = Math.min(tgt, t.vClean);
  } else if (ac.phase === 'final') {
    if (dThr < 5.2 * NM) tgt = vapp;
    else tgt = ac.tgtSpd || Math.min(ac.ias, dThr < 9 * NM ? 170 : 190);
  } else {
    tgt = ac.tgtSpd || Math.min(t.cruiseKt, dField < 12 * NM ? 210 : t.cruiseKt);
  }
  if (em === 'dual_engine_failure') tgt = t.vClean - 10;
  tgt = clamp(tgt, ac.phase === 'final' && dThr < 5.2 * NM ? t.vref - 5 : minSpeed(w, ac) - 1, 290);
  const descending = ac.vs < -300;
  ac.ias = approach(ac.ias, tgt, (ac.ias < tgt ? 1.6 : descending ? 0.7 : 1.2) * dt);

  // ── vertical ──
  let tgtAlt = ac.tgtAlt;
  let climb = t.climbFpm * (ac.alt > 10000 ? 0.7 : 1);
  let descent = t.descentFpm;
  if (em === 'engine_failure') climb *= t.engines > 2 ? 0.7 : 0.4;
  if (em === 'dual_engine_failure') { tgtAlt = 0; descent = (tasKt * KT * 196.85) / 15; climb = 0; } // ~15:1 glide
  let onGlide = false;
  if (ac.phase === 'final' && e) {
    const gsAlt = Math.max(0, (dThr + TDZ) * GS_FT_PER_M);
    if (ac.alt >= gsAlt - 60 || em === 'dual_engine_failure') {
      onGlide = true;
      const desc = Math.max(descent, 1500);
      const want = Math.max(gsAlt, 0);
      const stepFt = (desc / 60) * dt;
      const newAlt = ac.alt > want ? Math.max(want, ac.alt - stepFt) : want;
      ac.vs = ((newAlt - ac.alt) / dt) * 60;
      ac.alt = newAlt;
    } else tgtAlt = Math.min(ac.tgtAlt, ac.alt); // below the glidepath: fly level until intercept
  }
  if (ac.flags.raUntil && s.t < ac.flags.raUntil) {
    // TCAS resolution advisory overrides the cleared altitude
    const dir = ac.flags.raDir;
    ac.vs = approach(ac.vs, dir * 1800, 600 * dt);
    ac.alt = Math.max(300, ac.alt + (ac.vs / 60) * dt);
  } else if (!onGlide) {
    const diff = tgtAlt - ac.alt;
    const wantVs = Math.abs(diff) < 30 ? 0 : diff > 0 ? Math.min(climb, Math.abs(diff) * 6 + 200) : -Math.min(descent, Math.abs(diff) * 6 + 200);
    ac.vs = approach(ac.vs, em === 'dual_engine_failure' ? -descent : wantVs, 900 * dt);
    ac.alt += (ac.vs / 60) * dt;
    if (Math.abs(diff) < 30 && Math.abs(ac.vs) < 100) { ac.alt = tgtAlt; ac.vs = 0; }
  }

  // ── position (air vector + wind) ──
  const [hx, hy] = vecOf(ac.hdg);
  const [wxu, wyu] = vecOf(norm360(wind.dir + 180));
  const vx = hx * tasKt + wxu * wind.kt;
  const vy = hy * tasKt + wyu * wind.kt;
  ac.gs = Math.hypot(vx, vy);
  ac.track = hdgOf(vx, vy);
  ac.x += vx * KT * dt;
  ac.y += vy * KT * dt;

  // ── fuel ──
  const burn = t.fuelBurnKgMin * (ac.vs > 500 ? 1.7 : ac.vs < -500 ? 0.55 : 1) * (em === 'engine_failure' ? 0.75 : 1);
  ac.fuel = Math.max(0, ac.fuel - (burn / 60) * dt);
  ac.fuelMin = ac.fuel / t.fuelBurnKgMin;

  // ── phase logic ──
  if (ac.phase === 'final' && e) {
    // stabilised approach gate
    const gsAlt = (dThr + TDZ) * GS_FT_PER_M;
    if (dThr < 3 * NM && dThr > 0.3 * NM && ac.alt > gsAlt + 350 && em !== 'dual_engine_failure') {
      goAround(w, ac, 'unstable approach, too high', true);
      return;
    }
    if (dThr < 2 * NM && ac.ias > vapp + 35 && em !== 'dual_engine_failure') {
      goAround(w, ac, 'unstable approach, too fast', true);
      return;
    }
    const critical = em === 'dual_engine_failure' || em === 'fuel_emergency';
    // low visibility: runway must be clear earlier (ILS critical area protected), minima check
    const lowVis = wx.visSM < 1 || wx.ceilingFt < 400;
    if (!critical) {
      if (dThr < 1.0 * NM && !ac.landCleared) {
        goAround(w, ac, 'no landing clearance', true);
        return;
      }
      const gate = lowVis ? 2 * NM : 0.45 * NM;
      if (dThr < gate && dThr > 0 && !ac.flags.rwyChecked) {
        const visOk = lowVis ? s.cfg.difficulty.pilotAssist : true;
        const occ = runwayOccupants(w, e.rwy).filter((o) => {
          const [al] = alongCross(o.x, o.y, e.end.x, e.end.y, e.end.hdg);
          if (o.phase === 'takeoff_roll' && al > 1500 && o.gs > 90) return false; // departing traffic will be airborne
          return al > -150;
        });
        if (occ.length && (visOk || dThr < 0.45 * NM)) {
          if (dThr < 0.45 * NM && lowVis && !s.cfg.difficulty.pilotAssist) {
            // crew cannot see the obstruction in low visibility – no automatic protection in realistic settings
          } else {
            goAround(w, ac, `traffic on the runway`, true);
            return;
          }
        }
        if (s.rwy[e.rwy.id].closed) {
          goAround(w, ac, 'runway closed', true);
          return;
        }
        if (dThr < 0.45 * NM) ac.flags.rwyChecked = 1;
      }
      if (dThr < 0.7 * NM && !ac.flags.minimaChecked) {
        ac.flags.minimaChecked = 1;
        if (wx.visSM < 0.12 || (!e.end.ils && (wx.visSM < 2 || wx.ceilingFt < 800))) {
          goAround(w, ac, 'missed approach, runway not in sight at minimums', true);
          return;
        }
        if (wx.windshear && ((ac.id * 7 + Math.floor(s.t / 60)) % 5 === 0)) {
          goAround(w, ac, 'wind shear on final', true);
          logEvent(w, 'weather', 'warning', `Wind shear reported on final runway ${ac.rwy} by ${ac.callsign}`, [ac]);
          return;
        }
      }
    }
    if (ac.alt <= 8 && along > -200) {
      if (!ac.landCleared && critical) radioPilot(w, ac, `${csay(ac)} landing runway ${sayRwy(ac.rwy!)}, emergency.`, true);
      touchdown(w, ac);
      return;
    }
    if (along > e.rwy.length * 0.6 && ac.alt > 50) {
      goAround(w, ac, 'long landing', true);
      return;
    }
  }

  if (ac.phase === 'go_around') {
    if (ac.alt > 1400 && s.t - (ac.flags.gaAt ?? 0) > 20) {
      ac.phase = 'inbound';
      ac.flags.rwyChecked = 0;
      ac.flags.minimaChecked = 0;
      ac.flags.locMiss = 0;
      setRequest(w, ac, 'approach', `${ap.facility} Approach, ${csay(ac)}, on the go, runway heading, climbing ${sayAlt(ac.tgtAlt)}, request vectors.`);
    }
  }

  if (ac.phase === 'departure') {
    if (!ac.checkedIn && ac.alt > 900) {
      ac.checkedIn = true;
      const txt = `${ap.facility} Departure, ${csay(ac)}, passing ${sayAlt(Math.round(ac.alt / 100) * 100)} for ${sayAlt(ac.tgtAlt)}${ac.depFix ? `, ${ac.depFix} departure` : ''}.`;
      setRequest(w, ac, 'departure', txt);
    }
    if (ac.request?.type === 'departure' && ac.tgtAlt >= 10000 && (ac.latMode === 'fix' || ac.flags.vectored)) clearRequest(ac, 'departure');
  }

  // leaving the airspace
  if (dField > ap.airspaceRadius || ac.alt >= ap.ceiling + 500) {
    if (ac.kind === 'departure' || ac.flags.diverting) {
      leaveAirspace(w, ac);
    } else if (dField > ap.airspaceRadius + 3 * NM) {
      // an arrival vectored out of the airspace
      ac.phase = 'gone';
      ac.flags.goneAt = s.t;
      s.stats.diversions++;
      s.stats.safetyPenalty += 2;
      logEvent(w, 'diversion', 'warning', `${ac.callsign} left controlled airspace without landing – handed to the adjacent sector and diverted`, [ac]);
    }
  }
}

function leaveAirspace(w: World, ac: Aircraft) {
  const { s, ap } = w;
  ac.phase = 'gone';
  ac.flags.goneAt = s.t;
  clearRequest(ac);
  if (ac.flags.diverting) {
    logEvent(w, 'diversion', 'warning', `${ac.callsign} diverted to alternate`, [ac]);
    return;
  }
  const f = fixByName(w, ac.depFix);
  const brgOk = f ? Math.abs(angDiff(hdgOf(ac.x, ac.y), hdgOf(f.x, f.y))) < 25 : true;
  if (brgOk && ac.alt >= 9000) {
    logEvent(w, 'handoff', 'info', `${ac.callsign} handed off to center at ${f?.name ?? 'boundary'}, ${Math.round(ac.alt / 100) * 100} ft`, [ac]);
  } else {
    s.stats.improperExits++;
    logEvent(w, 'handoff', 'advisory', `${ac.callsign} left the airspace ${brgOk ? `low (${Math.round(ac.alt / 100) * 100} ft)` : `off course (filed ${f?.name})`} – improper handoff`, [ac]);
  }
}

/** extrapolated position after `sec` seconds on current track */
export function predict(ac: Aircraft, sec: number): [number, number, number] {
  const [ux, uy] = vecOf(ac.track);
  const d = ac.gs * KT * sec;
  return [ac.x + ux * d, ac.y + uy * d, ac.alt + (ac.vs / 60) * sec];
}

export { isAirborne };
