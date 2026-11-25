/**
 * The other pilot: first-officer flows, automatic configuration, and an "instructor has control"
 * mode that can fly the whole flight (taxi, takeoff, climb, cruise, approach, landing, taxi in).
 * The instructor uses the same controls and the same physics as the player.
 */
import { DEG, FT, KT, NM, alongCross, angDiff, clamp, dist, hdgOf } from '../sim/util';
import { ACDEF } from './aircraft';
import { apButton, attitudeCmd, bankLimit, lnavTrack } from './autopilot';
import { foFlow } from './checklists';
import { indicatedAlt, isJet, setControl, stallAlpha } from './systems';
import { distToGo, glidepathAlt, onFinal, planTaxiIn } from './world';
import { atcRequest } from './atc';
import type { Inputs, PilotState } from './types';

const G = 9.80665;
const dArrNm = (p: PilotState) => distToGo(p);
const straightNm = (p: PilotState) => dist(p.ac.x, p.ac.y, p.arrRwy.thrX, p.arrRwy.thrY) / NM;
const onApproach = (p: PilotState) => p.phase === 'approach' || p.phase === 'landing';

/** execute queued first-officer actions and (when enabled) keep the flows running */
export function stepFo(p: PilotState, dt: number, flows: boolean) {
  p.foTimer -= dt;
  if (p.foTimer > 0) return;
  if (p.foQueue.length) {
    const a = p.foQueue.shift()!;
    setControl(p, a.id, a.v);
    if (a.say) p.atc.log.push({ t: p.t, from: 'fo', text: a.say });
    p.foTimer = 0.9;
    return;
  }
  if (flows) { foFlow(p); p.foTimer = 0.4; }
}

/** gear, flaps, speedbrake and autobrake on a normal schedule (assist) */
export function autoConfig(p: PilotState) {
  const { ac } = p;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  const d = dArrNm(p);
  const set = (id: string, v: number) => { if (Math.abs((id === 'flaps' ? ac.flapIdx : -1) - v) > 0 || id !== 'flaps') setControl(p, id, v); };
  const flapOk = (i: number) => ac.ias < def.flaps[i].vfe - 12;
  if (!ac.onGround) {
    if (!onApproach(p)) {
      if (def.retract && ac.gearLever && ac.vs > 1 && ac.agl > 12 && p.phase !== 'descent') set('gear', 0);
      if (jet) {
        if (ac.agl > 300 && ac.flapIdx > 1 && ac.ias > p.vspeeds.v2 + 12) set('flaps', 1);
        if (ac.agl > 400 && ac.flapIdx === 1 && ac.ias > p.vspeeds.v2 + 32) set('flaps', 0);
      } else if (ac.flapIdx > 0 && ac.agl > 60 && ac.ias > 62 && ac.vs > 0) set('flaps', 0);
      return;
    }
    if (p.flags.goAround && p.t - p.flags.goAround < 40) {
      if (jet && ac.flapIdx > 3) set('flaps', 3);
      if (!jet && ac.flapIdx > 1) set('flaps', 1);
      if (def.retract && ac.vs > 1.5) set('gear', 0);
      return;
    }
    if (jet) {
      let want = 0;
      if (d < 15 || ac.ias < 215) want = 1;
      if (d < 11.5) want = 2;
      if (d < 7.6) { want = 3; p.flags.gearDue = 1; }
      if (d < 6) want = 4;
      while (want > ac.flapIdx && !flapOk(ac.flapIdx + 1)) want--;
      if (want > ac.flapIdx) set('flaps', ac.flapIdx + 1);
      if (p.flags.gearDue && !ac.gearLever && ac.ias < def.vle) set('gear', 1);
      if (ac.gear > 0.5 && !ac.spoilerArmed && (ac.spoilerLever < 0.02 || ac.agl < 450)) set('spoilerArm', 1);
      if ((p.sw.autobrake ?? 1) < 2) set('autobrake', 3);
    } else {
      let want = 0;
      if (d < 3.6) want = 1;
      if (d < 2.3) want = 2;
      if (d < 1.2) want = 3;
      while (want > ac.flapIdx && !flapOk(ac.flapIdx + 1)) want--;
      if (want > ac.flapIdx) set('flaps', ac.flapIdx + 1);
    }
  } else if (p.phase === 'taxi_in' || (p.phase === 'rollout' && ac.gs < 15)) {
    if (p.cfg.kind !== 'pattern' && ac.surface !== 'runway') { if (ac.flapIdx) set('flaps', 0); if (ac.spoilerLever > 0) set('spoiler', 0); }
  }
}

// ───────────────────────────── instructor (auto-fly) ─────────────────────────────

/** stick that holds a pitch attitude on the ground (rotation) */
function stickForAlpha(p: PilotState, a: number): number {
  const aS = stallAlpha(p);
  const u = a >= 2 ? (a - 2) / (aS + 3) : (a - 2) / 7;
  return clamp((u - p.ac.trim) / 0.8, -1, 1);
}

/** flight-path angle that holds a speed with the present thrust */
function speedGamma(p: PilotState, spd: number): number {
  const T = p.eng.reduce((s, e) => s + e.thrust, 0);
  const acc = clamp((spd - p.ac.ias) * 0.12, -1.2, 1.2) * KT;
  return Math.asin(clamp((T - (p.flags.drag ?? 0)) / (p.ac.mass * G) - acc / G, -0.2, 0.3)) / DEG;
}

function centreline(p: PilotState, hdg: number, x0: number, y0: number, gain = 0.5): number {
  const [, cross] = alongCross(p.ac.x, p.ac.y, x0, y0, hdg);
  const want = hdg - clamp(cross * gain, -14, 14);
  return clamp(angDiff(p.ac.hdg, want) * (p.ac.gs > 20 ? 0.22 : 0.08), -1, 1);
}

function followTaxi(p: PilotState, out: Inputs, stopAt: [number, number] | null) {
  const { ac } = p;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  const pts = p.taxi!.pts;
  let i = clamp(p.flags.taxiI ?? 0, 0, pts.length - 2);
  const look = jet ? 32 : 10;
  // advance along the polyline
  for (;;) {
    const [bx, by] = pts[i + 1];
    const seg = hdgOf(bx - pts[i][0], by - pts[i][1]);
    const [along] = alongCross(ac.x, ac.y, bx, by, seg);
    if ((along > -look * 0.6 || dist(ac.x, ac.y, bx, by) < look * 0.7) && i < pts.length - 2) i++;
    else break;
  }
  p.flags.taxiI = i;
  const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
  const seg = hdgOf(bx - ax, by - ay);
  const [along, cross] = alongCross(ac.x, ac.y, ax, ay, seg);
  const segLen = Math.hypot(bx - ax, by - ay);
  const t = clamp(along + look, 0, segLen);
  const [ux, uy] = [Math.sin(seg * DEG), Math.cos(seg * DEG)];
  const tx = ax + ux * t, ty = ay + uy * t;
  const err = angDiff(ac.hdg, hdgOf(tx - ac.x, ty - ac.y));
  void cross;
  out.yaw = clamp(err / (jet ? 28 : 22), -1, 1);
  const last = i === pts.length - 2;
  const remain = last ? segLen - along : 1e9;
  const stopD = stopAt ? dist(ac.x, ac.y, stopAt[0], stopAt[1]) : 1e9;
  let target = (jet ? 16 : 9) * KT;
  // slow for the next corner
  const nextTurn = i + 2 < pts.length ? Math.abs(angDiff(seg, hdgOf(pts[i + 2][0] - bx, pts[i + 2][1] - by))) : 0;
  const toCorner = segLen - along;
  if (Math.abs(err) > 18 || (nextTurn > 35 && toCorner < (jet ? 70 : 25))) target = (jet ? 8 : 5) * KT;
  const lim = Math.min(remain, stopD - (jet ? 9 : 4));
  if (lim < 60) target = Math.min(target, Math.max(0, lim) * 0.12);
  if (lim < (jet ? 3 : 2)) target = 0;
  const thrMove = jet ? 0.32 : 0.3, thrKeep = jet ? 0.06 : 0.12;
  let thr = 0;
  if (target > 0.3) thr = ac.gs < 0.8 ? thrMove : ac.gs < target - 0.6 ? thrKeep + 0.12 : ac.gs < target ? thrKeep : 0;
  setControl(p, 'throttle', thr);
  out.brake = target <= 0.01 ? 0.7 : ac.gs > target + 1.2 ? 0.35 : 0;
  void def;
  return { remain: lim, stopped: ac.gs < 0.2 && target <= 0.01 };
}

/** approach guidance flown by hand: bank and flight-path angle onto the runway */
function handApproach(p: PilotState): { gamma: number; bank: number } {
  const { ac } = p;
  const r = p.arrRwy;
  const [, cross] = alongCross(ac.x, ac.y, r.thrX, r.thrY, r.hdg);
  const trk = r.hdg - clamp(cross * (isJet(p) ? 0.04 : 0.1), -30, 30);
  const lim = bankLimit(p);
  const bank = clamp(angDiff(ac.gtrk, trk) * 1.5, -lim, lim);
  const err = glidepathAlt(p) - ac.z;
  const vsT = -ac.gs * Math.tan(3 * DEG) + clamp(err * 0.16, isJet(p) ? -3.5 : -1.6, 3.5);
  return { gamma: Math.asin(clamp(vsT / Math.max(ac.tas, 15), -0.3, 0.2)) / DEG, bank };
}

/** the instructor flies: returns control inputs and operates levers / automation as needed */
export function instructor(p: PilotState, dt: number): Inputs {
  const out: Inputs = { pitch: 0, roll: 0, yaw: 0, brake: 0 };
  const { ac, ap } = p;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  const alt = indicatedAlt(p);
  const running = p.eng.every((e) => e.running);
  const d = dArrNm(p);
  const ds = straightNm(p);
  autoConfig(p);

  if (ac.onGround) {
    const landed = p.phase === 'rollout' || p.phase === 'taxi_in' || p.phase === 'shutdown' || p.phase === 'complete';
    if (!landed) {
      // ── departure ──
      if (!running || (p.push && !p.push.done)) { setControl(p, 'throttle', jet ? 0 : ac.throttle[0]); return out; }
      const onRwy = ac.surface === 'runway' && Math.abs(angDiff(ac.hdg, p.depRwy.hdg)) < 6;
      const rolling = p.phase === 'takeoff' || (onRwy && p.atc.clearedTakeoff && (!p.taxi || (p.flags.taxiI ?? 0) >= p.taxi.pts.length - 2));
      if (rolling) {
        if (ac.parkBrake) setControl(p, 'parkBrake', 0);
        setControl(p, 'throttle', jet ? 0.95 : 1);
        out.yaw = centreline(p, p.depRwy.hdg, p.depRwy.thrX, p.depRwy.thrY, 0.4);
        if (ac.ias >= p.vspeeds.vr) out.pitch = stickForAlpha(p, jet ? 8.5 : 7.5);
        return out;
      }
      if (!p.atc.clearedTaxi || !p.taxi) return { ...out, brake: 0.6 };
      if (ac.parkBrake) {
        // the run-up / before-takeoff checks are done stationary
        if (p.phase === 'before_takeoff' && !(p.atc.clearedLineup || p.atc.clearedTakeoff)) return out;
        setControl(p, 'parkBrake', 0);
      }
      const cleared = p.atc.clearedLineup || p.atc.clearedTakeoff;
      const res = followTaxi(p, out, cleared ? null : p.taxi.hold ?? null);
      if (res.stopped && !cleared && !ac.parkBrake) setControl(p, 'parkBrake', 1);
      if (cleared && res.remain < 6 && !p.atc.clearedTakeoff) out.brake = 0.8;
      return out;
    }
    // ── after landing ──
    if (p.phase === 'rollout') {
      const r = p.arrRwy;
      if (p.cfg.kind === 'pattern' && p.landings.length < 3 && ac.surface === 'runway') {
        // touch-and-go: clean up, full power, keep straight, rotate
        if (ac.flapIdx > (jet ? 2 : 1)) setControl(p, 'flaps', jet ? 2 : 1);
        if (jet) { setControl(p, 'spoiler', 0); ac.trim = 0.3; }
        setControl(p, 'throttle', jet ? 0.95 : 1);
        out.yaw = centreline(p, r.hdg, r.thrX, r.thrY, 0.4);
        return out;
      }
      setControl(p, 'throttle', ac.reverse ? ac.throttle[0] : 0);
      if (jet) {
        if (ac.gs > 32 && !ac.reverse) setControl(p, 'reverse', 1);
        if (ac.gs < 30 && ac.reverse) setControl(p, 'reverse', 0);
      }
      const exitSpeed = jet ? 9 : 6;
      if (ac.gs > exitSpeed + 2) {
        out.yaw = centreline(p, r.hdg, r.thrX, r.thrY, 0.35);
        out.brake = ac.gs > 45 ? (jet ? 0 : 0.3) : 0.4;
        out.pitch = -0.2;
        return out;
      }
      if (!p.taxi || !p.flags.inPlanned) { p.taxi = planTaxiIn(p); p.flags.inPlanned = 1; p.flags.taxiI = 0; }
    }
    if (p.phase === 'shutdown' || p.phase === 'complete') { setControl(p, 'throttle', jet ? 0 : Math.min(ac.throttle[0], 0.05)); return { ...out, brake: 0.5 }; }
    if (!p.taxi) return { ...out, brake: 0.5 };
    if (p.atc.clearedTaxiIn && !p.flags.inReplanned) { p.flags.inReplanned = 1; p.flags.taxiI = 0; }
    if (ac.parkBrake) setControl(p, 'parkBrake', 0);
    const res = followTaxi(p, out, null);
    if (res.stopped) setControl(p, 'parkBrake', 1);
    return out;
  }

  // ── airborne ──
  const aglFt = ac.agl / FT;
  const goAround = !!p.flags.goAround && p.t - p.flags.goAround < 60;
  const depEnd = p.phase === 'takeoff' || ((p.flags.airTime ?? 0) < 25 && !onApproach(p)) || goAround;
  if (depEnd && (aglFt < (jet ? 600 : 400) || (goAround && p.t - p.flags.goAround < 25))) {
    // initial climb by hand
    setControl(p, 'throttle', jet ? 0.95 : 1);
    const spd = jet ? p.vspeeds.v2 + 15 : def.vy;
    const gamma = clamp(speedGamma(p, spd), 1.5, jet ? 12 : 9);
    const trk = goAround ? p.arrRwy.hdg : p.depRwy.hdg;
    const bank = clamp(angDiff(ac.gtrk, trk) * 1.2, -15, 15);
    const c = attitudeCmd(p, gamma, aglFt > 50 ? bank : 0);
    out.pitch = c.pitch;
    out.roll = c.roll;
    return out;
  }
  const finalIdx = p.route.findIndex((w) => w.kind === 'final');
  void finalIdx;
  const [alongR, crossR] = alongCross(ac.x, ac.y, p.arrRwy.thrX, p.arrRwy.thrY, p.arrRwy.hdg);
  const overRwy = alongR > 600 && Math.abs(crossR) < 1200 && Math.abs(angDiff(ac.gtrk, p.arrRwy.hdg)) < 50 && aglFt < 2500;
  // missed the runway or badly unstable close in: go around
  if (onApproach(p) && p.t - (p.flags.botGa ?? -1e9) > 150) {
    const high = ac.z - glidepathAlt(p);
    const unstable = onFinal(p) && aglFt < 320 && aglFt > 60 && (ac.ias > p.vspeeds.vapp + (jet ? 16 : 14) || high > (jet ? 45 : 30) || (def.retract && ac.gear < 0.99));
    if ((overRwy && aglFt > 80) || unstable) { p.flags.botGa = p.t; atcRequest(p, 'goaround', 'fo'); p.flags.goAround = p.t; }
  }
  const handFly = onApproach(p) && onFinal(p) && !goAround && (jet ? aglFt < 230 && ds < 6 : ds < 3.6);
  if (handFly) {
    if (ap.cmd) ap.cmd = false;
    ap.at = false;
    ap.atMode = 'off';
    const g = handApproach(p);
    const flareH = jet ? 9 : 3.5;
    let gamma = g.gamma;
    const vapp = p.vspeeds.vapp;
    let thr = ac.throttle[0];
    if (ac.agl < flareH * 2) out.yaw = clamp(angDiff(ac.hdg, p.arrRwy.hdg) * (jet ? 0.12 : 0.22), -1, 1); // de-crab
    if (ac.agl < flareH) {
      gamma = jet ? -0.75 : -0.9;
      thr = Math.max(0, thr - dt * (jet ? 0.5 : 0.9));
    } else {
      thr = clamp(thr + clamp(0.02 * (vapp - ac.ias) - 0.08 * (p.flags.accel ?? 0), -0.4, 0.4) * dt, 0, 1);
    }
    setControl(p, 'throttle', thr);
    const c = attitudeCmd(p, gamma, ac.agl < flareH ? clamp(g.bank, -4, 4) : g.bank, ac.agl < flareH ? 1.4 : 0.9);
    out.pitch = c.pitch;
    out.roll = c.roll;
    return out;
  }

  // ── automation management ──
  if (!ap.cmd && aglFt > (jet ? 420 : 320) && p.sys.avionics && (!jet || p.sys.align >= 1)) {
    ap.lat = 'lnav';
    ap.vert = 'flch';
    ap.fd = true;
    apButton(p, 'cmd');
    if (jet) ap.at = true;
  }
  if (!ap.cmd) {
    // no autopilot available: fly the same guidance by hand
    const trk = lnavTrack(p);
    const lim = bankLimit(p);
    const c = attitudeCmd(p, speedGamma(p, jet ? 220 : def.vy), clamp(angDiff(ac.gtrk, trk) * 1.4, -lim, lim));
    return { ...out, pitch: c.pitch, roll: c.roll };
  }
  if (ap.lat !== 'loc' && ap.lat !== 'lnav') ap.lat = 'lnav';

  // target altitude
  let tgtAlt = jet ? p.atc.alt || p.cruiseAlt : p.cruiseAlt;
  const baseW = p.route.find((w) => w.kind === 'base') ?? p.route.find((w) => w.kind === 'final');
  const finW = p.route.find((w) => w.kind === 'final');
  if (p.cfg.kind === 'pattern') tgtAlt = p.route[Math.min(p.leg, p.route.length - 2)].alt ?? tgtAlt;
  else if (!jet) {
    const tod = ((alt - (baseW?.alt ?? 0)) / 1000) * 4.5 + 4;
    if (d < tod || p.flags.vfrDesc) { p.flags.vfrDesc = 1; tgtAlt = baseW?.alt ?? tgtAlt; }
    if (p.leg >= p.route.findIndex((w) => w.kind === 'final')) tgtAlt = finW?.alt ?? tgtAlt;
  }
  if (p.flags.goAround && p.atc.flags.gaAlt && p.t - p.flags.goAround < 240 && !p.atc.clearedApproach) tgtAlt = p.atc.flags.gaAlt;
  if (ap.vert !== 'gs' && !p.flags.gsChase) {
    if (ap.selAlt !== tgtAlt) setControl(p, 'selAlt', tgtAlt);
    if (Math.abs(alt - ap.selAlt) > 250 && ap.vert === 'alt') {
      if (jet || ap.selAlt > alt) apButton(p, 'flch');
      else { ap.vert = 'vs'; setControl(p, 'selVs', -600); }
    }
  }

  // speed
  if (jet) {
    let spd = alt < 10000 ? 250 : ap.selAlt >= alt - 200 ? 290 : 280;
    if (p.phase === 'takeoff' || (aglFt < 3000 && p.phase === 'climb' && ac.flapIdx > 0)) spd = ac.flapIdx > 1 ? p.vspeeds.v2 + 20 : 210;
    if (ap.selAlt < alt - 300 && alt < 13500) spd = 250;
    if (onApproach(p) || d < 26) {
      spd = d < 6.3 ? p.vspeeds.vapp : d < 8.5 ? 160 : d < 13 ? 180 : d < 19 ? 200 : 220;
      if (ap.selAlt > alt + 800 && ap.vert !== 'gs' && !p.atc.clearedApproach) spd = Math.max(spd, 200);
    }
    if (ac.flapIdx > 0) spd = Math.min(spd, def.flaps[ac.flapIdx].vfe - 12);
    if (p.cfg.kind === 'pattern') spd = ds < 6.3 && onFinal(p) ? p.vspeeds.vapp : Math.max(p.vspeeds.vapp, Math.min(p.route[Math.min(p.leg, p.route.length - 2)].spd ?? 190, ac.flapIdx > 1 && p.leg < 2 ? p.vspeeds.v2 + 20 : 999));
    if (ap.selSpd !== Math.round(spd)) setControl(p, 'selSpd', spd);
  } else {
    // no autothrottle: power by hand, speed on pitch in the climb
    const climbing = ap.selAlt > alt + 150;
    const descending = ap.selAlt < alt - 150;
    let thr = 0.72;
    if (climbing) { thr = 1; setControl(p, 'selSpd', def.vy + 2); if (ap.vert === 'alt' || ap.vert === 'vs') apButton(p, 'flch'); }
    else if (descending) thr = 0.42;
    if (onApproach(p) || d < 6) {
      const tgt = d < 2.2 ? p.vspeeds.vapp : d < 4 ? 75 : 88;
      thr = clamp(ac.throttle[0] + clamp(0.02 * (tgt - ac.ias) - 0.08 * (p.flags.accel ?? 0), -0.4, 0.4) * dt, 0.05, 1);
    }
    setControl(p, 'throttle', thr);
  }

  // descent profile: speedbrake when high, capture the glideslope from above if needed
  if (jet) {
    const prof = (finW?.alt ?? 3000) + Math.max(0, d - 10) * 318;
    const descending = ap.selAlt < alt - 300 || ap.vert === 'gs';
    if (descending && alt > prof + 500 && ac.flapIdx < 4 && ac.spoilerLever < 0.5 && !ac.spoilerArmed) setControl(p, 'spoiler', 1);
    if ((!descending || alt < prof + 150) && ac.spoilerLever > 0 && !ac.spoilerArmed) setControl(p, 'spoiler', 0);
    if (ap.lat === 'loc' && ap.gsArmed && p.ils.gsValid && p.ils.gs < -0.5 && ap.vert !== 'gs') { p.flags.gsChase = 1; ap.vert = 'vs'; setControl(p, 'selVs', -1400); setControl(p, 'selAlt', Math.round(p.arrRwy.elev / FT / 100) * 100 + 1200); }
    if (ap.vert === 'gs' || ap.lat !== 'loc') p.flags.gsChase = 0;
  }
  // approach mode
  if (jet && p.atc.clearedApproach && onApproach(p) && p.leg >= p.route.findIndex((w) => w.kind === 'base') && !ap.locArmed && !ap.gsArmed && ap.lat !== 'loc' && Math.abs(p.radios.nav.act - p.arrRwy.ilsFreq) < 0.011 && d < 22) apButton(p, 'app');
  return out;
}
