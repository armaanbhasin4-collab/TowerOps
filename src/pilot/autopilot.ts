/**
 * Flight director / autopilot / autothrottle.
 *
 * Modes: lateral HDG, LNAV (flight-plan legs), LOC; vertical ALT hold, V/S, FLCH (speed on
 * pitch, climb thrust or idle), G/S. The same guidance drives the flight-director bars when the
 * autopilot is off. There is no autoland in the realistic presets: the autopilot disconnects at
 * 200 ft on approach and the landing is flown by hand.
 */
import { DEG, FT, KT, NM, alongCross, angDiff, clamp, dist, hdgOf } from '../sim/util';
import { ACDEF, flapAt, isa } from './aircraft';
import { FLAP_CL0, indicatedAlt, isJet, stallAlpha } from './systems';
import { glidepathAlt } from './world';
import type { Inputs, PilotState } from './types';

const G = 9.80665;

/** stick position (-1..1) that makes the aircraft seek a flight-path angle and bank */
export function attitudeCmd(p: PilotState, gammaT: number, bankT: number, kGamma = 0.7): { pitch: number; roll: number; pitchAtt: number } {
  const { ac } = p;
  const def = ACDEF[p.cfg.aircraft];
  const atm = isa(ac.z);
  const V = Math.max(ac.tas, 20);
  const qbar = 0.5 * atm.rho * V * V;
  const gDot = clamp((gammaT - ac.gamma) * kGamma, -2.5, 2.5) * DEG;
  const n = clamp(Math.cos(ac.gamma * DEG) / Math.max(0.5, Math.cos(ac.bank * DEG)) + (V * gDot) / G, 0.6, 1.5);
  const CL = (n * ac.mass * G) / (qbar * def.S);
  const aS = stallAlpha(p);
  const a = clamp((CL - def.CL0 - FLAP_CL0 * flapAt(def, ac.flaps).dCL) / def.CLa, -4, aS - 1.5);
  const u = a >= 2 ? (a - 2) / (aS + 3) : (a - 2) / 7;
  const pitch = clamp((u - ac.trim) / 0.8, -1, 1);
  const rate = clamp((bankT - ac.bank) * 0.7, -def.rollRate * 0.5, def.rollRate * 0.5) + (isJet(p) ? 0.25 : 0.5) * ac.beta + def.dihedral * ac.bank * 10;
  const roll = clamp(rate / def.rollRate, -0.7, 0.7);
  return { pitch, roll, pitchAtt: gammaT + a * Math.cos(ac.bank * DEG) };
}

export const bankLimit = (p: PilotState) => (isJet(p) ? (p.ac.z / FT > 28000 ? 18 : 25) : 20);

/** bank that turns the ground track onto a desired track */
function trackBank(p: PilotState, trk: number, cur = p.ac.gtrk): number {
  const lim = bankLimit(p);
  return clamp(angDiff(cur, trk) * 1.4, -lim, lim);
}

/** LNAV: desired ground track for the active leg; sequences waypoints with turn anticipation */
export function lnavTrack(p: PilotState, sequence = true): number {
  const { ac, route } = p;
  if (p.leg >= route.length) return ac.gtrk;
  const to = route[p.leg];
  const from = p.leg > 0 ? route[p.leg - 1] : null;
  const dTo = dist(ac.x, ac.y, to.x, to.y);
  const next = route[p.leg + 1];
  if (sequence && next && to.kind !== 'rwy') {
    const inb = from ? hdgOf(to.x - from.x, to.y - from.y) : hdgOf(to.x - ac.x, to.y - ac.y);
    const out = hdgOf(next.x - to.x, next.y - to.y);
    const turn = Math.abs(angDiff(inb, out));
    const R = (ac.gs * ac.gs) / (G * Math.tan(bankLimit(p) * DEG));
    const lead = Math.min(R * Math.tan((Math.min(turn, 150) / 2) * DEG) + ac.gs * 3, 6 * NM);
    const [along] = from ? alongCross(ac.x, ac.y, to.x, to.y, inb) : [-dTo];
    if (dTo < lead || along > 0) { p.leg++; return lnavTrack(p, false); }
  }
  if (!from) return hdgOf(to.x - ac.x, to.y - ac.y);
  const course = hdgOf(to.x - from.x, to.y - from.y);
  const [, xte] = alongCross(ac.x, ac.y, from.x, from.y, course);
  const k = isJet(p) ? 30 / NM : 70 / NM;
  return course - clamp(xte * k, -45, 45);
}

function locTrack(p: PilotState): number {
  const r = p.arrRwy;
  const [, cross] = alongCross(p.ac.x, p.ac.y, r.thrX, r.thrY, r.hdg);
  return r.hdg - clamp(cross * (isJet(p) ? 0.035 : 0.08), -32, 32);
}

/** IAS that corresponds to the cruise Mach number at the present altitude */
export function machLimitKt(p: PilotState): number {
  const def = ACDEF[p.cfg.aircraft];
  if (!def.cruiseMach) return 999;
  const atm = isa(p.ac.z);
  return (def.cruiseMach * atm.a * Math.sqrt(atm.sigma)) / KT;
}

export interface Guidance { gamma: number; bank: number; valid: boolean }

/** flight-director guidance for the armed/active modes */
export function guidance(p: PilotState): Guidance {
  const { ac, ap } = p;
  const alt = indicatedAlt(p);
  const fpm = (ac.vs / FT) * 60;
  const V = Math.max(ac.tas, 20);

  // mode transitions
  if (ap.locArmed && p.ils.valid && Math.abs(p.ils.loc) < 2.2 && Math.abs(angDiff(ac.gtrk, p.arrRwy.hdg)) < 100) { ap.lat = 'loc'; ap.locArmed = false; }
  if (ap.gsArmed && ap.lat === 'loc' && p.ils.gsValid && p.ils.gs < 0.35 && p.ils.gs > -0.7) { ap.vert = 'gs'; ap.gsArmed = false; }
  if ((ap.vert === 'vs' || ap.vert === 'flch') && Math.abs(ap.selAlt - alt) < Math.abs(fpm) * 0.13 + 60) {
    const toward = (ap.selAlt - alt) * fpm >= 0 || Math.abs(ap.selAlt - alt) < 80;
    if (toward) ap.vert = 'alt';
  }

  let bank = 0;
  if (ap.lat === 'hdg') bank = trackBank(p, ap.selHdg, ac.hdg);
  else if (ap.lat === 'lnav') bank = trackBank(p, lnavTrack(p));
  else if (ap.lat === 'loc' || ap.lat === 'rollout') bank = trackBank(p, locTrack(p));
  else bank = 0;

  let gamma = ac.gamma;
  const spdT = Math.min(ap.selSpd, machLimitKt(p));
  if (ap.vert === 'alt') {
    const vsT = clamp((ap.selAlt - alt) * 7, -1500, 1500);
    gamma = Math.asin(clamp((vsT * FT) / 60 / V, -0.3, 0.3)) / DEG;
  } else if (ap.vert === 'vs') {
    gamma = Math.asin(clamp((ap.selVs * FT) / 60 / V, -0.3, 0.3)) / DEG;
  } else if (ap.vert === 'flch') {
    const T = p.eng.reduce((s, e) => s + e.thrust, 0);
    const D = p.flags.drag ?? 0;
    const acc = clamp((spdT - ac.ias) * 0.12, -1.2, 1.2) * KT;
    gamma = Math.asin(clamp((T - D) / (ac.mass * G) - acc / G, -0.2, 0.25)) / DEG;
    if (ap.selAlt > alt) gamma = Math.max(gamma, 0);
    else gamma = Math.min(gamma, 0);
  } else if (ap.vert === 'gs') {
    const err = glidepathAlt(p) - ac.z;
    const vsT = -ac.gs * Math.tan(3 * DEG) + clamp(err * 0.14, -4, 4);
    gamma = Math.asin(clamp(vsT / V, -0.3, 0.2)) / DEG;
    // casual-mode autoland: flare and hold the centreline
    if (p.cfg.assists.preset === 'casual' && ac.agl < (isJet(p) ? 12 : 5)) gamma = -0.5;
  }
  return { gamma, bank, valid: ap.lat !== 'off' || ap.vert !== 'off' };
}

/** run the automatics for one step; returns control commands when the autopilot is engaged */
export function stepAutopilot(p: PilotState, inp: Inputs, dt: number): Inputs {
  const { ac, ap } = p;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  if (!p.sys.avionics) { ap.cmd = false; ap.fd = false; ap.at = false; ap.atMode = 'off'; return inp; }
  const g = guidance(p);
  const cmd = attitudeCmd(p, g.gamma, g.bank);
  ap.fdPitch = cmd.pitchAtt;
  ap.fdBank = g.bank;
  const aglFt = ac.agl / FT;
  const autoland = p.cfg.assists.preset === 'casual';

  // autothrottle
  if (ap.at && jet && !ac.onGround && aglFt > 350 || (ap.at && ap.atMode !== 'off' && !ac.onGround)) {
    const alt = indicatedAlt(p);
    ap.atMode = ap.vert === 'flch' ? (ap.selAlt > alt ? 'n1' : 'idle') : 'spd';
    if (aglFt < 28 && (ap.vert === 'gs' || p.phase === 'landing')) ap.atMode = 'idle';
    let thr = ac.throttle[0];
    if (ap.atMode === 'n1') thr = Math.min(0.92, thr + dt * 0.25);
    else if (ap.atMode === 'idle') thr = Math.max(0, thr - dt * 0.3);
    else {
      const spdT = Math.min(ap.selSpd, machLimitKt(p));
      const rate = clamp(0.014 * (spdT - ac.ias) - 0.07 * (p.flags.accel ?? 0), -0.3, 0.3);
      thr = clamp(thr + rate * dt, 0, 0.95);
    }
    ac.throttle = ac.throttle.map(() => thr);
  } else if (!ap.at || ac.onGround) ap.atMode = 'off';

  if (!ap.cmd) return inp;
  // disconnects
  let off = '';
  if (ac.onGround && !(autoland && ap.lat === 'loc')) off = 'on the ground';
  else if (ac.stalled) off = 'stall';
  else if (Math.abs(ac.bank) > 50 || Math.abs(ac.pitch) > 30) off = 'unusual attitude';
  else if (Math.abs(inp.pitch) > 0.6 || Math.abs(inp.roll) > 0.6) off = 'control override';
  else if (!autoland && ap.vert === 'gs' && aglFt < 200) off = 'minimum use height – land manually';
  if (off) {
    ap.cmd = false;
    p.callouts.push('autopilot');
    p.atc.log.push({ t: p.t, from: 'sys', text: `AUTOPILOT DISCONNECT (${off})` });
    return inp;
  }
  if (autoland && ac.onGround) {
    // roll-out: stay on the centreline, idle, brakes
    const r = p.arrRwy;
    const [, cross] = alongCross(ac.x, ac.y, r.thrX, r.thrY, r.hdg);
    const want = r.hdg - clamp(cross * 0.5, -12, 12);
    ac.throttle = ac.throttle.map(() => 0);
    if (ac.gs < 3) { ap.cmd = false; ap.lat = 'off'; ap.vert = 'off'; }
    return { pitch: -0.1, roll: 0, yaw: clamp(angDiff(ac.hdg, want) * 0.12, -1, 1), brake: 0.5 };
  }
  void def;
  return { pitch: cmd.pitch, roll: cmd.roll, yaw: inp.yaw, brake: inp.brake };
}

/** mode control panel buttons */
export function apButton(p: PilotState, btn: string): string {
  const { ap, ac } = p;
  const jet = isJet(p);
  if (!p.sys.avionics) return 'no electrical power';
  const alt = indicatedAlt(p);
  switch (btn) {
    case 'fd': ap.fd = !ap.fd; return '';
    case 'at': if (!jet) return 'no autothrottle on this aircraft'; ap.at = !ap.at; if (!ap.at) ap.atMode = 'off'; return '';
    case 'cmd':
      if (ap.cmd) { ap.cmd = false; return ''; }
      if (ac.onGround) return 'autopilot cannot be engaged on the ground';
      if (ac.agl / FT < (jet ? 400 : 300)) return `autopilot minimum engagement height is ${jet ? 400 : 300} ft`;
      if (jet && p.sys.align < 1) return 'IRS not aligned';
      ap.cmd = true;
      if (ap.lat === 'off') { ap.lat = 'hdg'; ap.selHdg = Math.round(ac.hdg) % 360; }
      if (ap.vert === 'off' || ap.vert === 'toga') {
        if (Math.abs(ac.vs / FT * 60) < 300) { ap.vert = 'alt'; ap.selAlt = Math.round(alt / 100) * 100; }
        else { ap.vert = 'vs'; ap.selVs = Math.round(((ac.vs / FT) * 60) / 100) * 100; }
      }
      return '';
    case 'hdg': ap.lat = 'hdg'; ap.locArmed = false; return '';
    case 'hdgSync': ap.selHdg = Math.round(ac.hdg) % 360; return '';
    case 'lnav': if (p.leg >= p.route.length) return 'no active waypoint'; ap.lat = 'lnav'; return '';
    case 'loc':
    case 'app': {
      if (ap.locArmed || ap.lat === 'loc') { ap.locArmed = false; ap.gsArmed = false; if (ap.lat === 'loc') ap.lat = 'hdg'; if (ap.vert === 'gs') ap.vert = 'alt'; return ''; }
      if (Math.abs(p.radios.nav.act - p.arrRwy.ilsFreq) > 0.011) return `tune the ILS first (${p.arrRwy.ilsFreq.toFixed(2)})`;
      ap.locArmed = true;
      ap.gsArmed = btn === 'app';
      if (ap.lat === 'off') { ap.lat = 'hdg'; ap.selHdg = Math.round(ac.hdg) % 360; }
      return '';
    }
    case 'alt': ap.vert = 'alt'; ap.selAlt = Math.round(alt / 100) * 100; ap.gsArmed = false; return '';
    case 'vs': ap.vert = 'vs'; ap.selVs = Math.round(((ac.vs / FT) * 60) / 100) * 100; return '';
    case 'flch': ap.vert = 'flch'; if (ap.selSpd < 60) ap.selSpd = Math.round(ac.ias); return '';
  }
  return 'unknown button';
}
