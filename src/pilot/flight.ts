/**
 * Flight and ground dynamics.
 *
 * A point-mass model with attitude: the stick and trim set the angle of attack the aircraft seeks
 * (so it is speed-stable and must be trimmed, like a real aeroplane), ailerons command roll rate,
 * rudder commands sideslip. Lift, drag and thrust then move the flight path. It is a training
 * approximation, not a certified flight model: there is no terrain, icing, or structural modelling.
 */
import { DEG, FT, KT, angDiff, approach, clamp, hdgOf, norm360, rand, vecOf, alongCross } from '../sim/util';
import { ACDEF, flapAt, isa, stallKt } from './aircraft';
import { FLAP_CL0, isJet, stallAlpha } from './systems';
import { groundElev, surfaceAt, windAt } from './world';
import type { Inputs, PilotState } from './types';

const G = 9.80665;

function actuators(p: PilotState, ctl: Inputs, dt: number) {
  const { ac, sys } = p;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  const hydOk = !jet || sys.hyd[0] > 1500 || sys.hyd[1] > 1500;
  const auth = hydOk ? 1 : 0.35;
  ac.elev = approach(ac.elev, clamp(ctl.pitch, -1, 1) * auth, dt * 5);
  ac.ail = approach(ac.ail, clamp(ctl.roll, -1, 1) * auth, dt * 6);
  ac.rud = approach(ac.rud, clamp(ctl.yaw, -1, 1) * auth, dt * 5);
  // flaps: hydraulic (jet) or electric (trainer)
  const flapPower = jet ? hydOk : sys.bus;
  if (flapPower) ac.flaps = approach(ac.flaps, ac.flapIdx, dt * (jet ? 0.22 : 0.45));
  // landing gear
  if (def.retract) {
    const tgt = ac.gearLever ? 1 : 0;
    if (hydOk || tgt === 1) ac.gear = approach(ac.gear, tgt, dt / (hydOk ? 8 : 16));
  } else ac.gear = 1;
  // speedbrakes / ground spoilers
  if (jet) {
    const idle = ac.throttle.every((t) => t < 0.12) || ac.reverse;
    if (ac.onGround && ac.gs > 25 && idle && (ac.spoilerArmed || ac.reverse) && hydOk) { ac.spoilerLever = 1; ac.spoilerArmed = false; }
    if (ac.onGround && !idle && ac.spoilerLever > 0 && p.phase !== 'takeoff') ac.spoilerLever = 0;
    if (hydOk) ac.spoiler = approach(ac.spoiler, ac.spoilerLever, dt * 2.5);
  } else ac.spoiler = 0;
  ac.mass = def.oew + def.payload + ac.fuel;
}

/** lift and drag coefficients for an angle of attack */
function aero(p: PilotState, alpha: number): { CL: number; CD: number; stalled: boolean } {
  const { ac } = p;
  const def = ACDEF[p.cfg.aircraft];
  const f = flapAt(def, ac.flaps);
  const aS = stallAlpha(p);
  const clMax = def.CLmax + f.dCL;
  let CL = def.CL0 + FLAP_CL0 * f.dCL + def.CLa * alpha;
  const stalled = alpha > aS;
  if (stalled) CL = Math.max(clMax * 0.55, clMax * (1 - 0.045 * (alpha - aS)));
  CL *= 1 - 0.3 * ac.spoiler * (ac.onGround ? 2 : 1);
  // ground effect reduces induced drag close to the surface
  const ge = clamp(0.45 + 0.55 * (ac.agl / def.span), 0.45, 1);
  const wave = ac.mach > 0.77 ? 0.03 * ((ac.mach - 0.77) / 0.06) ** 2 : 0;
  const CD = def.CD0 + def.k * CL * CL * ge + f.dCD + ac.gear * def.CDgear + ac.spoiler * 0.05 + 0.0004 * ac.beta * ac.beta + (stalled ? 0.02 * (alpha - aS) + 0.03 : 0) + wave;
  return { CL, CD, stalled };
}

/** angle of attack the aircraft seeks for the present stick + trim */
function alphaTarget(p: PilotState): number {
  const { ac } = p;
  const aS = stallAlpha(p);
  const u = clamp(ac.elev * 0.8 + ac.trim, -1.2, 1.25);
  let aT = u >= 0 ? 2 + u * (aS + 5 - 2) : 2 + u * 7;
  if (p.cfg.assists.protection) aT = Math.min(aT, aS - 1.2);
  return aT;
}

function referenceQ(p: PilotState): number {
  const def = ACDEF[p.cfg.aircraft];
  const v = stallKt(def, p.ac.mass, p.ac.flaps) * 1.15 * KT;
  return 0.5 * 1.225 * v * v;
}

function airStep(p: PilotState, ctl: Inputs, dt: number) {
  const { ac } = p;
  const def = ACDEF[p.cfg.aircraft];
  const A = p.cfg.assists;
  const atm = isa(ac.z);
  const V = Math.max(ac.tas, 3);
  const qbar = 0.5 * atm.rho * V * V;
  const eff = clamp(qbar / referenceQ(p), 0.05, 1.3);
  const low = ac.agl < 900 && p.airports[0].wind.kt > 9 ? (p.airports[0].wind.kt - 8) / 12 : 0;

  // pitch: second-order response of angle of attack toward its target
  const aT = alphaTarget(p) + (low ? (rand(p) - 0.5) * 1.2 * low : 0);
  const aDD = def.wn * def.wn * eff * (aT - ac.alpha) - 2 * def.zeta * def.wn * Math.sqrt(Math.max(eff, 0.25)) * ac.q;
  ac.q += aDD * dt;
  ac.alpha = clamp(ac.alpha + ac.q * dt, -12, 30);

  const { CL, CD, stalled } = aero(p, ac.alpha);
  ac.stalled = stalled;
  const L = qbar * def.S * CL, D = qbar * def.S * CD;
  const T = p.eng.reduce((s, e) => s + e.thrust, 0);
  const W = ac.mass * G;
  const ca = Math.cos(ac.alpha * DEG), sa = Math.sin(ac.alpha * DEG);
  const cb = Math.cos(ac.bank * DEG), sb = Math.sin(ac.bank * DEG);
  const cg = Math.cos(ac.gamma * DEG), sg = Math.sin(ac.gamma * DEG);

  // roll
  let pT = def.rollRate * ac.ail * clamp(eff, 0.25, 1.15) - def.dihedral * ac.bank * 10 - (isJet(p) ? 0.25 : 0.5) * ac.beta;
  if (A.preset === 'casual') pT = clamp((ctl.roll * 30 - ac.bank) * 2.2, -def.rollRate, def.rollRate);
  if (A.protection) {
    const lim = 38;
    if (Math.abs(ac.bank) > lim && Math.sign(pT) === Math.sign(ac.bank)) pT = -Math.sign(ac.bank) * 4;
  }
  if (stalled && !A.protection) pT += 14 * (ac.bank >= 0 ? 1 : -1);
  if (low) pT += (rand(p) - 0.5) * 30 * low;
  ac.p += (pT - ac.p) * Math.min(1, dt / 0.22);
  ac.bank = clamp(ac.bank + ac.p * dt, -120, 120);

  // sideslip (rudder, adverse yaw, propeller effects); lightly damped without the yaw damper
  const pf = isJet(p) ? 0 : (p.eng[0].n1 / 100) * clamp(1 - ac.ias / 105, 0, 1) * clamp(ac.alpha / 8, 0, 1.3);
  let bT = -11 * ac.rud + (isJet(p) ? 0.04 : 0.09) * ac.p + 4 * pf;
  if (A.autoRudder) bT = -11 * ac.rud * (Math.abs(ctl.yaw) > 0.05 ? 1 : 0);
  const zB = isJet(p) ? (p.sw.yawDamper ? 0.7 : 0.1) : 0.6;
  const wB = isJet(p) ? 1.3 : 2.2;
  const br = p.flags.betaRate ?? 0;
  const bDD = wB * wB * (bT - ac.beta) - 2 * zB * wB * br;
  p.flags.betaRate = br + bDD * dt;
  ac.beta = clamp(ac.beta + p.flags.betaRate * dt, -25, 25);

  const Y = -qbar * def.S * 0.012 * ac.beta;
  const vDot = (T * ca - D) / ac.mass - G * sg;
  const gDot = (L * cb + T * sa - W * cg) / (ac.mass * V);
  const tDot = (L * sb + Y) / (ac.mass * V * Math.max(cg, 0.2));
  ac.tas = Math.max(0, V + vDot * dt);
  p.flags.drag = D;
  p.flags.accel = ((vDot * Math.sqrt(atm.sigma)) / KT) * 0.2 + (p.flags.accel ?? 0) * 0.8;
  ac.gamma = clamp(ac.gamma + (gDot / DEG) * dt, -89, 89);
  ac.r = tDot / DEG;
  ac.trk = norm360(ac.trk + ac.r * dt);
  ac.hdg = norm360(ac.trk - ac.beta);
  ac.pitch = ac.gamma + ac.alpha * cb;
  ac.g = L / W;

  const w = windAt(p, ac.x, ac.y, ac.z);
  const [ux, uy] = vecOf(ac.trk);
  const hv = ac.tas * Math.cos(ac.gamma * DEG);
  const gx = hv * ux + w.vx, gy = hv * uy + w.vy;
  ac.x += gx * dt;
  ac.y += gy * dt;
  ac.vs = ac.tas * Math.sin(ac.gamma * DEG);
  ac.z += ac.vs * dt;
  ac.gs = Math.hypot(gx, gy);
  ac.gtrk = hdgOf(gx, gy);
  p.distFlown += ac.gs * dt;
  p.flags.airTime = (p.flags.airTime ?? 0) + dt;

  const ground = groundElev(p, ac.x, ac.y);
  ac.agl = ac.z - ground;
  if (ac.agl <= 0) touchdown(p, ground);
}

function touchdown(p: PilotState, ground: number) {
  const { ac } = p;
  const def = ACDEF[p.cfg.aircraft];
  const fpm = (-ac.vs / FT) * 60;
  ac.z = ground;
  ac.agl = 0;
  const sf = surfaceAt(p, ac.x, ac.y);
  const r = p.arrRwy;
  const [along, cross] = alongCross(ac.x, ac.y, r.thrX, r.thrY, r.hdg);
  const onArr = sf.kind === 'runway' && sf.rwy === r.rwyId;
  const refHdg = onArr ? r.hdg : sf.kind === 'runway' ? ac.gtrk : ac.hdg;
  const data = {
    fpm, ias: ac.ias, vref: p.vspeeds.vref, offset: onArr ? cross : 0, dist: onArr ? along : 0, pitch: ac.pitch, bank: ac.bank,
    crab: angDiff(refHdg, ac.hdg), g: 1 + Math.max(0, fpm) / 420, rwy: onArr ? r.name : sf.kind === 'runway' ? 'another runway' : 'off runway', offRunway: sf.kind !== 'runway',
  };
  // bounce: firm arrival with flying speed and no lift dump
  const vs = stallKt(def, ac.mass, ac.flaps);
  if (fpm > def.hardFpm * 0.55 && fpm < def.crashFpm && ac.ias > vs * 1.08 && ac.spoiler < 0.3 && (p.flags.bounces ?? 0) < 2 && !(def.retract && ac.gear < 0.9)) {
    p.flags.bounces = (p.flags.bounces ?? 0) + 1;
    p.flags.bounceT = p.t;
    ac.gamma = clamp(-ac.gamma * 0.3, 0.3, 2);
    ac.z = ground + 0.05;
    return;
  }
  p.landings.push(data);
  p.flags.touchdown = p.t;
  let crash = '';
  if (def.retract && ac.gear < 0.9) crash = 'Landed with the gear up';
  else if (fpm > def.crashFpm) crash = `Impact at ${Math.round(fpm)} ft/min – far beyond the landing gear's limit`;
  else if (Math.abs(ac.bank) > def.wingStrike + 8) crash = 'Wing struck the ground on touchdown';
  else if (ac.pitch < -7) crash = 'Nose gear collapsed – touched down nose first';
  else if (sf.kind === 'grass' && isJet(p) && ac.gs > 35) crash = 'Touched down off the runway';
  ac.onGround = true;
  ac.gs = Math.max(0, ac.gs * Math.cos(angDiff(ac.gtrk, ac.hdg) * DEG));
  ac.gamma = 0;
  ac.vs = 0;
  ac.alpha = clamp(ac.pitch, 0, def.tailStrike);
  ac.pitch = ac.alpha;
  ac.q = 0;
  ac.beta = 0;
  p.flags.betaRate = 0;
  ac.surface = sf.kind;
  if (crash) setCrash(p, crash);
}

export function setCrash(p: PilotState, why: string) {
  if (p.ac.crashed) return;
  if (p.cfg.assists.forgiving) {
    // scored, but the session continues
    p.flags.forgiven = (p.flags.forgiven ?? 0) + 1;
    p.findings.push({ t: p.t, cat: 'safety', pts: -30, text: `${why}. In a real aircraft this would have been an accident (continuing because "forgiving" is on).` });
    p.ac.gs = Math.min(p.ac.gs, 20);
    p.ac.bank = 0;
    if (ACDEF[p.cfg.aircraft].retract) { p.ac.gear = 1; p.ac.gearLever = true; }
    return;
  }
  p.ac.crashed = why;
}

function groundStep(p: PilotState, ctl: Inputs, dt: number) {
  const { ac, sys } = p;
  const def = ACDEF[p.cfg.aircraft];
  const A = p.cfg.assists;
  const jet = isJet(p);
  const ground = groundElev(p, ac.x, ac.y);
  ac.z = ground;
  ac.agl = 0;
  const atm = isa(ac.z);
  const w = windAt(p, ac.x, ac.y, ac.z);
  const [ux, uy] = vecOf(ac.hdg);
  const head = -(w.vx * ux + w.vy * uy);
  const xw = -(w.vx * uy - w.vy * ux); // + = wind from the right
  ac.tas = Math.max(0, ac.gs + head);
  const qbar = 0.5 * atm.rho * ac.tas * ac.tas;
  const eff = clamp(qbar / referenceQ(p), 0, 1.3);

  // rotation: elevator authority builds with dynamic pressure
  const aT = clamp(alphaTarget(p) * clamp((eff - 0.42) / 0.33, 0, 1), 0, 30);
  const aDD = def.wn * def.wn * Math.max(eff, 0.3) * (aT - ac.alpha) - 2 * def.zeta * def.wn * ac.q;
  ac.q += aDD * dt;
  ac.alpha += ac.q * dt;
  if (ac.alpha < 0) { ac.alpha = 0; ac.q = Math.max(0, ac.q); }
  if (ac.alpha > def.tailStrike) {
    ac.alpha = def.tailStrike;
    ac.q = Math.min(0, ac.q);
    if (ac.gs > 20 && !p.flags.tailStrike) { p.flags.tailStrike = p.t; }
  }
  ac.pitch = ac.alpha;
  ac.gamma = 0;
  ac.bank = approach(ac.bank, 0, dt * 30);
  ac.p = 0;
  ac.beta = 0;
  ac.stalled = false;

  const { CL, CD } = aero(p, ac.alpha);
  const L = qbar * def.S * CL, D = qbar * def.S * CD;
  const W = ac.mass * G;
  const T = p.eng.reduce((s, e) => s + e.thrust, 0);
  const N = Math.max(0, W - L);
  ac.g = 1;

  // brakes
  const hydOk = !jet || sys.hyd[0] > 1500 || sys.hyd[1] > 1500;
  let brake = Math.max(clamp(ctl.brake, 0, 1), ac.parkBrake ? 1 : 0);
  if (jet) {
    const ab = p.sw.autobrake ?? 1;
    const idle = ac.throttle.every((t) => t < 0.12) || ac.reverse;
    if (ab === 0 && p.phase === 'takeoff' && idle && ac.gs > 40) p.flags.rto = 1; // rejected takeoff
    if (p.flags.rto && ac.gs > 1) brake = 1;
    else if (ab >= 2 && (p.phase === 'rollout' || p.phase === 'landing') && idle && ac.gs > 8 && ctl.brake < 0.05) brake = Math.max(brake, [0, 0, 0.3, 0.45, 0.62, 1][ab]);
    if (ac.gs < 1) p.flags.rto = 0;
  }
  ac.brake = approach(ac.brake, brake * (hydOk || ac.parkBrake ? 1 : 0.4), dt * 4);
  const grass = ac.surface === 'grass';
  const muR = grass ? 0.085 : 0.018;
  const fBrake = def.brakeMu * (grass ? 0.6 : 1) * ac.brake * N;
  const drive = T - D;
  const resist = muR * N + fBrake;
  if (ac.gs < 0.05 && Math.abs(drive) <= resist) ac.gs = 0;
  else ac.gs = Math.max(0, ac.gs + ((drive - resist) / ac.mass) * dt);

  // steering: nose wheel at low speed, rudder at high speed
  const nws = !jet || hydOk;
  const maxAng = nws ? def.steer + (2.2 - def.steer) * clamp(ac.gs / 22, 0, 1) : 2.2;
  let rate = ((ac.gs * Math.tan(clamp(ctl.yaw, -1, 1) * maxAng * DEG)) / def.wheelbase) / DEG;
  const cap = ((0.3 * G) / Math.max(ac.gs, 1)) / DEG;
  rate = clamp(rate, -cap, cap);
  if (!A.autoRudder && ac.gs > 2) {
    rate += 0.25 * (xw / KT / 10) * clamp(ac.gs / 30, 0, 1.5);
    if (!jet) rate -= 2.4 * (p.eng[0].n1 / 100) * clamp(1 - ac.gs / 32, 0.15, 1) * clamp(ac.gs / 5, 0, 1);
  }
  ac.r = rate;
  ac.hdg = norm360(ac.hdg + rate * dt);
  ac.trk = ac.hdg;
  ac.gtrk = ac.hdg;
  const [vx, vy] = vecOf(ac.hdg);
  ac.x += vx * ac.gs * dt;
  ac.y += vy * ac.gs * dt;
  ac.vs = 0;
  p.flags.airTime = 0;

  // lift-off
  if (L > W && ac.alpha > 1.5 && ac.gs > 10) {
    ac.onGround = false;
    const ax = vx * ac.gs - w.vx, ay = vy * ac.gs - w.vy;
    ac.tas = Math.hypot(ax, ay);
    ac.trk = hdgOf(ax, ay);
    ac.beta = angDiff(ac.hdg, ac.trk);
    ac.gamma = 0.15;
    ac.z += 0.05;
    ac.surface = 'air';
    p.flags.liftoff = p.t;
    p.flags.bounces = 0;
  }
}

function pushStep(p: PilotState, dt: number) {
  const push = p.push!;
  const { ac } = p;
  if (ac.parkBrake || push.done) return;
  const v = 1.6;
  push.s = Math.min(push.len, push.s + v * dt);
  const at = (s: number): [number, number] => {
    let rem = clamp(s, 0, push.len);
    for (let i = 0; i + 1 < push.pts.length; i++) {
      const [ax, ay] = push.pts[i], [bx, by] = push.pts[i + 1];
      const l = Math.hypot(bx - ax, by - ay);
      if (rem <= l || i + 2 === push.pts.length) return [ax + ((bx - ax) * Math.min(rem, l)) / l, ay + ((by - ay) * Math.min(rem, l)) / l];
      rem -= l;
    }
    return push.pts[push.pts.length - 1];
  };
  const [x, y] = at(push.s);
  const [nx, ny] = at(push.s - 16);
  ac.x = x;
  ac.y = y;
  if (push.s > 2) {
    const want = hdgOf(nx - x, ny - y);
    ac.hdg = norm360(ac.hdg + clamp(angDiff(ac.hdg, want), -9 * dt, 9 * dt));
  }
  ac.trk = ac.gtrk = ac.hdg;
  ac.gs = 0;
  ac.z = groundElev(p, x, y);
  if (push.s >= push.len) { push.done = true; p.flags.pushed = 1; }
}

export function stepFlight(p: PilotState, ctl: Inputs, dt: number) {
  const { ac } = p;
  if (ac.crashed) return;
  actuators(p, ctl, dt);
  if (p.push && !p.push.done && p.atc.clearedPush && ac.onGround) {
    pushStep(p, dt);
    ac.tas = 0;
  } else if (ac.onGround) groundStep(p, ctl, dt);
  else airStep(p, ctl, dt);
  const atm = isa(ac.z);
  ac.ias = (ac.tas * Math.sqrt(atm.sigma)) / KT;
  ac.mach = ac.tas / atm.a;
  // automatic pitch trim relieves a held stick force
  if ((p.cfg.assists.autoTrim || p.ap.cmd) && !ac.onGround && Math.abs(ac.elev) > 0.02) {
    const d = ac.elev * dt * 0.35;
    ac.trim = clamp(ac.trim + d, -1, 1);
    ac.elev -= d / 0.8;
  }
  // surface under the wheels (sampled a few times a second)
  if (ac.onGround && p.t - (p.flags.surfT ?? -1) > 0.2) {
    p.flags.surfT = p.t;
    ac.surface = surfaceAt(p, ac.x, ac.y).kind;
    if (ac.surface === 'grass' && isJet(p) && ac.gs > 30) setCrash(p, 'Left the paved surface at high speed');
  } else if (!ac.onGround) ac.surface = 'air';
}
