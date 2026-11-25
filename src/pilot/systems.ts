/**
 * Aircraft systems and engines: electrics, APU, bleed air, hydraulics, pressurisation, inertial
 * alignment, engine start / run / shutdown, and the warning logic that depends on them.
 * Timings are deliberately shortened (APU start ~25 s, IRS alignment ~90 s) so a cold-and-dark
 * setup takes minutes, not a quarter of an hour.
 */
import { FT, KT, approach, clamp } from '../sim/util';
import { ACDEF, CONTROLS, flapAt, isa, stallKt } from './aircraft';
import { nearestAirport } from './world';
import type { PilotState } from './types';

export const isJet = (p: PilotState) => p.cfg.aircraft === 'jet';

/** indicated altitude in feet for the current altimeter setting */
export function indicatedAlt(p: PilotState): number {
  const set = p.radios.std ? 1013.25 : p.radios.baro;
  const qnh = p.airports[nearestAirport(p, p.ac.x, p.ac.y)].qnh;
  return p.ac.z / FT + (set - qnh) * 27;
}

/** set any cockpit control by id. Returns a short refusal reason, or '' when accepted. */
export function setControl(p: PilotState, id: string, v: number): string {
  const ac = p.ac, def = ACDEF[p.cfg.aircraft];
  switch (id) {
    case 'flaps': ac.flapIdx = clamp(Math.round(v), 0, def.flaps.length - 1); return '';
    case 'gear':
      if (!def.retract) return 'fixed landing gear';
      if (ac.onGround && !v) return 'gear lever is locked on the ground';
      ac.gearLever = !!v; return '';
    case 'parkBrake': ac.parkBrake = !!v; return '';
    case 'spoilerArm': if (!isJet(p)) return 'no speedbrakes'; ac.spoilerArmed = !!v; if (v) ac.spoilerLever = 0; return '';
    case 'spoiler': if (!isJet(p)) return 'no speedbrakes'; ac.spoilerLever = clamp(v, 0, 1); if (v > 0) ac.spoilerArmed = false; return '';
    case 'reverse':
      if (!isJet(p)) return 'no reverse thrust';
      if (v && !ac.onGround) return 'reverse thrust is locked out in flight';
      if (v && ac.throttle.some((t) => t > 0.1) && !ac.reverse) ac.throttle = ac.throttle.map(() => 0);
      ac.reverse = !!v;
      ac.throttle = ac.throttle.map(() => (v ? 0.75 : 0));
      return '';
    case 'throttle': ac.throttle = ac.throttle.map(() => clamp(v, 0, 1)); return '';
    case 'mixture': ac.mixture = clamp(v, 0, 1); return '';
    case 'trim': ac.trim = clamp(v, -1, 1); return '';
    case 'xpdr': p.radios.xpdr.mode = clamp(Math.round(v), 0, 2) as 0 | 1 | 2; return '';
    case 'squawk': p.radios.xpdr.code = Math.round(v); return '';
    case 'com': p.radios.com.act = v; return '';
    case 'nav': p.radios.nav.act = v; return '';
    case 'crs': p.radios.nav.crs = v; return '';
    case 'baro': p.radios.baro = clamp(Math.round(v), 940, 1050); return '';
    case 'baroStd': p.radios.std = !!v; return '';
    case 'baroQnh': p.radios.std = false; p.radios.baro = p.airports[nearestAirport(p, ac.x, ac.y)].qnh; return '';
    case 'fd': p.ap.fd = !!v; return '';
    case 'at': p.ap.at = !!v; if (!v) p.ap.atMode = 'off'; return '';
    case 'selAlt': p.ap.selAlt = clamp(Math.round(v / 100) * 100, 0, def.ceiling); return '';
    case 'selHdg': p.ap.selHdg = ((Math.round(v) % 360) + 360) % 360; return '';
    case 'selSpd': p.ap.selSpd = clamp(Math.round(v), isJet(p) ? 110 : 55, def.vmo); return '';
    case 'selVs': p.ap.selVs = clamp(Math.round(v / 100) * 100, -6000, 6000); return '';
  }
  const c = CONTROLS[p.cfg.aircraft].find((x) => x.id === id);
  if (!c) return 'unknown control';
  p.sw[id] = clamp(Math.round(v), 0, c.pos.length - 1);
  return '';
}

/** read any control position (same ids as setControl) */
export function getControl(p: PilotState, id: string): number {
  const ac = p.ac;
  switch (id) {
    case 'flaps': return ac.flapIdx;
    case 'gear': return ac.gearLever ? 1 : 0;
    case 'parkBrake': return ac.parkBrake ? 1 : 0;
    case 'spoilerArm': return ac.spoilerArmed ? 1 : 0;
    case 'spoiler': return ac.spoilerLever;
    case 'reverse': return ac.reverse ? 1 : 0;
    case 'throttle': return ac.throttle[0];
    case 'mixture': return ac.mixture;
    case 'xpdr': return p.radios.xpdr.mode;
    case 'fd': return p.ap.fd ? 1 : 0;
    case 'at': return p.ap.at ? 1 : 0;
    case 'baroStd': return p.radios.std ? 1 : 0;
  }
  return p.sw[id] ?? 0;
}

function jetSystems(p: PilotState, dt: number) {
  const { sw, sys, ac, eng } = p;
  // APU
  if (sw.apu === 2) {
    if (sw.batt) p.flags.apuStart = 1;
    sw.apu = 1;
  }
  if (sw.apu === 0) { p.flags.apuStart = 0; sys.apuRunning = false; }
  if (p.flags.apuStart && sw.batt && ac.fuel > 0) {
    sys.apuN = approach(sys.apuN, 100, dt * 4);
    if (sys.apuN >= 95) sys.apuRunning = true;
  } else {
    sys.apuN = approach(sys.apuN, 0, dt * 6);
    if (sys.apuN < 90) sys.apuRunning = false;
  }
  if (sys.apuRunning) ac.fuel = Math.max(0, ac.fuel - (105 / 3600) * dt);

  sys.extAvail = ac.onGround && ac.gs < 0.3 && ac.parkBrake && !p.flags.pushed && p.phase !== 'taxi_in' && p.phase !== 'rollout';
  if (!sys.extAvail && sw.gpu) sw.gpu = 0;
  const gen = (sw.gen1 && eng[0].running) || (sw.gen2 && eng[1].running);
  sys.source = gen ? 'gen' : sw.apuGen && sys.apuRunning ? 'apu' : sw.gpu && sys.extAvail ? 'ext' : sw.batt && sys.batt > 0.02 ? 'battery' : 'none';
  if (sys.source === 'battery') sys.batt = Math.max(0, sys.batt - dt / 1800);
  else if (sys.source !== 'none' && sw.batt) sys.batt = Math.min(1, sys.batt + dt / 900);
  sys.bus = sys.source !== 'none';
  const acPower = sys.bus && sys.source !== 'battery';
  sys.avionics = sys.bus;

  // bleed air
  const engBleed = (sw.bleed1 && eng[0].running) || (sw.bleed2 && eng[1].running);
  const want = engBleed ? 40 : sw.bleedApu && sys.apuRunning ? 34 : 0;
  sys.duct = approach(sys.duct, want, dt * 12);
  // a pack takes most of the APU's air: starting with packs on gives a slow, hot start
  const packs = acPower && sys.duct > 15 ? (sw.packL ? 1 : 0) + (sw.packR ? 1 : 0) : 0;
  sys.packs = packs;

  // hydraulics
  const a = (sw.hydEng1 && eng[0].running) || (sw.hydElec1 && acPower) ? 3000 : 0;
  const b = (sw.hydEng2 && eng[1].running) || (sw.hydElec2 && acPower) ? 3000 : 0;
  sys.hyd[0] = approach(sys.hyd[0], a, dt * 900);
  sys.hyd[1] = approach(sys.hyd[1], b, dt * 900);

  sys.fuelPress = [!!sw.pumpL && acPower, !!sw.pumpR && acPower];

  // inertial alignment: both IRS in NAV, powered, aircraft stationary
  if (sw.irsL && sw.irsR && sys.bus) {
    if (sys.align < 1 && ac.gs > 1 && ac.onGround) sys.align = 0;
    else sys.align = Math.min(1, sys.align + dt / (p.cfg.assists.preset === 'study' ? 90 : 20));
  } else sys.align = 0;

  // cabin pressure
  const altFt = ac.z / FT;
  const sched = Math.min(8000, Math.max(0, (altFt - 2000) * 0.21));
  const target = packs > 0 ? sched : altFt;
  sys.cabinAlt = approach(sys.cabinAlt, ac.onGround ? altFt : target, dt * (packs > 0 ? 12 : 9));
  if (ac.onGround) sys.cabinAlt = altFt;
}

function jetEngines(p: PilotState, dt: number) {
  const { sw, sys, ac } = p;
  const def = ACDEF.jet;
  const atm = isa(ac.z);
  for (let i = 0; i < 2; i++) {
    const e = p.eng[i];
    const lever = sw['fuelLever' + (i + 1)] === 1;
    const startSw = sw['start' + (i + 1)] === 1;
    const litKey = 'lit' + i;
    const motoring = startSw && sys.duct > 18 && sys.bus;
    const ambient = atm.tempK - 273.15;
    if (!e.running) {
      if (p.flags[litKey]) {
        // light-off to idle
        if (!lever || ac.fuel <= 0) { p.flags[litKey] = 0; continue; }
        const slow = sys.packs > 0 ? 0.6 : 1;
        if (e.n2 < 45 && !motoring) e.n2 = approach(e.n2, 0, dt * 1.5); // hung start: starter air lost too early
        else e.n2 = approach(e.n2, 60, dt * 2.6 * slow);
        e.n1 = approach(e.n1, 21, dt * 1.2 * slow);
        const peak = (p.flags['hot' + i] ? 880 : 520) + (sys.packs > 0 ? 90 : 0);
        e.egt = approach(e.egt, e.n2 < 50 ? peak : 430, dt * 55);
        e.ff = 300;
        e.starting += dt;
        if (e.n2 >= 56 && startSw) sw['start' + (i + 1)] = 0;
        if (e.n2 >= 59) { e.running = true; e.starting = 0; p.flags[litKey] = 0; }
      } else {
        e.starting = motoring ? e.starting + dt : 0;
        e.n2 = approach(e.n2, motoring ? 25 : 0, dt * (motoring ? 2.4 : 3));
        e.n1 = approach(e.n1, motoring ? 6 : ac.onGround ? 0 : clamp(ac.ias / 12, 0, 18), dt * 1.5);
        e.egt = approach(e.egt, ambient, dt * 14);
        e.ff = 0;
        if (lever && motoring && ac.fuel > 0 && e.n2 >= 8) {
          p.flags[litKey] = 1;
          p.flags['hot' + i] = e.n2 < 18 ? 1 : 0;
          if (e.n2 < 18) p.flags['hotStart'] = 1;
        }
        // windmill relight in flight
        if (lever && !ac.onGround && ac.ias > 200 && ac.fuel > 0 && e.n2 < 20) e.n2 = approach(e.n2, 20, dt * 3);
      }
      e.thrust = 0;
      e.oilP = clamp(e.n2 * 0.9, 0, 50);
      continue;
    }
    if (!lever || ac.fuel <= 0) { e.running = false; p.flags[litKey] = 0; continue; }
    const idle = ac.onGround ? 21 : 27;
    const lim = ac.reverse ? 78 : 101;
    const tgt = clamp(idle + ac.throttle[i] * (101 - idle), idle, lim);
    const up = clamp(3.5 + 0.38 * (e.n1 - 21), 3.5, 20);
    e.n1 = e.n1 < tgt ? Math.min(tgt, e.n1 + up * dt) : Math.max(tgt, e.n1 - 16 * dt);
    e.n2 = 60 + (e.n1 - 21) * 0.5;
    const tmax = def.thrust * Math.pow(atm.sigma, 0.85) * (1 - 0.3 * Math.min(ac.mach, 0.9));
    const frac = clamp((e.n1 - 21) / 80, 0, 1);
    const fwd = tmax * (0.04 + 0.96 * Math.pow(frac, 1.4));
    e.thrust = ac.reverse && ac.onGround ? -0.42 * tmax * Math.pow(frac, 1.2) - 0.02 * tmax : fwd;
    e.ff = 330 + Math.abs(e.thrust) * 0.045 * (ac.reverse ? 1.6 : 1);
    e.egt = approach(e.egt, 410 + (e.n1 - 21) * 5.2, dt * 40);
    e.oilP = 42 + e.n2 * 0.08;
    e.oilT = approach(e.oilT, 85, dt * 0.4);
    ac.fuel = Math.max(0, ac.fuel - (e.ff / 3600) * dt);
  }
}

function pistonSystems(p: PilotState, dt: number) {
  const { sw, sys, eng } = p;
  const charging = !!sw.alt && eng[0].running && eng[0].rpm > 900;
  sys.source = sw.batt ? (charging ? 'gen' : sys.batt > 0.02 ? 'battery' : 'none') : 'none';
  if (sys.source === 'battery') sys.batt = Math.max(0, sys.batt - dt / 2700);
  else if (sys.source === 'gen') sys.batt = Math.min(1, sys.batt + dt / 1200);
  sys.bus = sys.source !== 'none';
  sys.avionics = sys.bus && !!sw.avionics;
  if (sys.avionics) sys.align = Math.min(1, sys.align + dt / (p.cfg.assists.preset === 'study' ? 25 : 3));
  else sys.align = 0;
  sys.fuelPress = [(!!sw.pumpAux && sys.bus) || eng[0].running];
  sys.hyd = [3000, 3000];
  sys.cabinAlt = p.ac.z / FT;
  sys.extAvail = false;
  sys.packs = 0;
}

/** optimum mixture setting for an altitude (leaner as the air thins) */
export const bestMixture = (altFt: number) => clamp(1 - (Math.max(0, altFt - 2000) / 10000) * 0.5, 0.45, 1);

function pistonEngine(p: PilotState, dt: number) {
  const { sw, sys, ac } = p;
  const def = ACDEF.c172;
  const e = p.eng[0];
  const atm = isa(ac.z);
  const fuelOk = ac.fuel > 0 && sw.fuelShutoff === 1;
  // priming: aux pump on with the mixture rich
  if (sys.bus && sw.pumpAux && ac.mixture > 0.8 && !e.running) p.flags.primed = Math.min(8, (p.flags.primed ?? 0) + dt);
  else if (!e.running) p.flags.primed = Math.max(0, (p.flags.primed ?? 0) - dt * 0.02);
  if (sw.magnetos === 4) {
    if (sys.bus && !e.running) p.flags.crank = 3;
    sw.magnetos = 3;
  }
  if (!e.running) {
    if ((p.flags.crank ?? 0) > 0 && sys.bus) {
      p.flags.crank -= dt;
      e.rpm = approach(e.rpm, 180, dt * 400);
      if (p.flags.crank < 1.6) {
        if ((p.flags.primed ?? 0) >= 2 && ac.mixture > 0.4 && fuelOk && sw.magnetos >= 1) {
          e.running = true;
          p.flags.crank = 0;
          if (ac.throttle[0] > 0.45) p.flags.overRev = 1;
        } else if (p.flags.crank <= 0) p.flags.noStart = p.t;
      }
    } else {
      e.rpm = approach(e.rpm, ac.onGround ? 0 : clamp(ac.ias * 12, 0, 1100), dt * 600);
      p.flags.crank = 0;
    }
    e.thrust = ac.onGround ? 0 : -60;
    e.ff = 0;
    e.n1 = 0;
    e.oilP = clamp(e.rpm / 20, 0, 20);
    e.oilT = approach(e.oilT, atm.tempK - 273, dt * 0.2);
    e.egt = approach(e.egt, atm.tempK - 273, dt * 8);
    return;
  }
  const altFt = ac.z / FT;
  const mopt = bestMixture(altFt);
  const m = ac.mixture;
  const mixF = m >= mopt ? 1 - 0.5 * (m - mopt) : Math.max(0, 1 - ((mopt - m) / 0.25) ** 2);
  const magF = sw.magnetos === 3 ? 1 : sw.magnetos === 0 ? 0 : 0.945;
  if (!fuelOk || m < 0.08 || magF === 0 || mixF <= 0.02) { e.running = false; p.flags.primed = fuelOk ? 4 : 0; return; }
  const pf = (0.06 + 0.94 * ac.throttle[0]) * Math.pow(atm.sigma, 1.1) * mixF * magF;
  const P = def.power * pf;
  const V = Math.max(1, ac.tas);
  const eta = 0.8 * (1 - Math.exp(-V / 25));
  e.thrust = Math.min(def.thrust * Math.pow(pf, 0.67), (P * eta) / V);
  const rf = clamp((pf - 0.06) / 0.94, 0, 1);
  const tgt = 620 + 2090 * Math.sqrt(rf) * (0.86 + 0.14 * clamp(ac.tas / 55, 0, 1));
  e.rpm = approach(e.rpm, tgt, dt * 900);
  e.n1 = pf * 100;
  e.ff = (3 + 36 * pf) * (0.75 + 0.25 * clamp(m / mopt, 0.6, 1.4));
  e.egt = approach(e.egt, 600 + 150 * pf + (m < mopt ? 40 : -60 * (m - mopt)), dt * 30);
  e.oilP = 55;
  e.oilT = approach(e.oilT, 82 + pf * 12, dt * 0.25);
  ac.fuel = Math.max(0, ac.fuel - (e.ff / 3600) * dt);
}

function warnings(p: PilotState) {
  const { sys, ac, sw, eng } = p;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  const w: string[] = [], c: string[] = [];
  const aglFt = ac.agl / FT;
  const vs = stallKt(def, ac.mass, ac.flaps);
  sys.stallWarn = !ac.onGround && (ac.stalled || ac.ias < vs * 1.07 * Math.sqrt(Math.max(1, ac.g)) || ac.alpha > stallAlpha(p) - 1.5);
  const vfe = def.flaps[Math.ceil(ac.flaps - 0.01)]?.vfe ?? def.vmo;
  sys.overspeed = ac.ias > def.vmo + 3 || ac.mach > def.mmo + 0.01 || (ac.flaps > 0.05 && ac.ias > vfe + 5) || (def.retract && ac.gear > 0.05 && ac.gear < 0.99 && ac.ias > def.vle + 5);
  // takeoff configuration
  const toThrust = ac.throttle[0] > 0.6 && ac.onGround && !ac.reverse && p.phase !== 'rollout' && p.phase !== 'landing';
  sys.configWarn = toThrust && ac.gs < 45 * KT && (!def.toFlaps.includes(ac.flapIdx) || ac.parkBrake || ac.spoilerLever > 0.05 || Math.abs(ac.trim - takeoffTrim(p)) > 0.3);
  if (sys.configWarn) w.push('TAKEOFF CONFIG');
  if (sys.stallWarn) w.push('STALL');
  if (sys.overspeed) w.push('OVERSPEED');
  // ground proximity
  sys.gpws = null;
  if (!ac.onGround && sys.bus) {
    const fpm = -ac.vs / FT * 60;
    const landingCfg = ac.gear > 0.9 && ac.flapIdx >= def.ldgFlap - 1;
    if (aglFt < 2400 && fpm > 1700 + aglFt * 1.6) sys.gpws = fpm > 2400 + aglFt * 2.2 ? 'PULL UP' : 'SINK RATE';
    else if (jet && aglFt < 500 && ac.gear < 0.9 && ac.ias < 190 && (p.flags.airTime ?? 0) > 60) sys.gpws = 'TOO LOW GEAR';
    else if (jet && aglFt < 200 && !landingCfg && ac.ias < 160 && (p.flags.airTime ?? 0) > 60) sys.gpws = 'TOO LOW FLAPS';
    else if (aglFt < 1000 && aglFt > 80 && p.ils.gsValid && p.ils.gs > 1.4 && p.phase === 'approach') sys.gpws = 'GLIDESLOPE';
    else if (Math.abs(ac.bank) > (aglFt < 150 ? 20 : 40)) sys.gpws = 'BANK ANGLE';
    else if ((p.flags.airTime ?? 0) < 40 && aglFt < 700 && fpm > 250 && p.phase !== 'approach' && p.phase !== 'landing') sys.gpws = "DON'T SINK";
    if (sys.gpws === 'PULL UP') w.push('PULL UP');
    else if (sys.gpws) c.push(sys.gpws);
  }
  if (jet) {
    if (def.retract && !ac.onGround && ac.gear < 0.9 && aglFt < 800 && ac.throttle[0] < 0.15 && ac.flapIdx >= 3) w.push('GEAR');
    if (sys.cabinAlt > 10000) w.push('CABIN ALTITUDE');
    if (sys.source === 'battery') c.push('ON BATTERY');
    if (!ac.onGround && sys.packs === 0) c.push('PACKS OFF');
    if (sys.hyd[0] < 1500 || sys.hyd[1] < 1500) c.push('HYD PRESS LOW');
    for (let i = 0; i < 2; i++) {
      if (!eng[i].running && !ac.onGround) w.push(`ENG ${i + 1} FAIL`);
      if (eng[i].running && !sys.fuelPress[i]) c.push(`FUEL PUMP ${i ? 'R' : 'L'} LOW PRESS`);
      if (eng[i].running && !sw['gen' + (i + 1)]) c.push(`GEN ${i + 1} OFF`);
      if (eng[i].egt > 800 && eng[i].starting > 0) w.push(`ENG ${i + 1} HOT START`);
    }
    if (!ac.onGround && !sw.probeHeat) c.push('PROBE HEAT OFF');
    if (!ac.onGround && !sw.yawDamper) c.push('YAW DAMPER OFF');
    if (sys.apuRunning && !ac.onGround && ac.z / FT > 12000) c.push('APU RUNNING');
    if (ac.fuel < 1400) c.push('FUEL LOW');
    if (sys.align < 1 && sw.irsL && sw.irsR) c.push('IRS ALIGNING');
  } else {
    if (sys.bus && eng[0].running && sys.source === 'battery') c.push('LOW VOLTS');
    if (sys.bus && !eng[0].running && !ac.onGround) w.push('ENGINE FAILURE');
    if (sys.bus && eng[0].running && eng[0].oilP < 25) w.push('OIL PRESSURE');
    if (ac.fuel < 14) c.push('LOW FUEL');
  }
  sys.warnings = sys.bus ? w : [];
  sys.cautions = sys.bus ? c : [];
  if (!sys.bus) { sys.gpws = null; }
}

/** share of the flap lift increment that shifts the whole lift curve (the rest raises the stall angle) */
export const FLAP_CL0 = 0.6;

/** angle of attack at which the wing stalls for the current flap setting, deg */
export function stallAlpha(p: PilotState): number {
  const def = ACDEF[p.cfg.aircraft];
  return (def.CLmax + (1 - FLAP_CL0) * flapAt(def, p.ac.flaps).dCL - def.CL0) / def.CLa;
}

/** trim setting that suits the takeoff (green band centre) */
export function takeoffTrim(p: PilotState): number {
  return isJet(p) ? 0.3 : 0.2;
}

export function stepSystems(p: PilotState, dt: number) {
  if (isJet(p)) { jetSystems(p, dt); jetEngines(p, dt); }
  else { pistonSystems(p, dt); pistonEngine(p, dt); }
  warnings(p);
}

/** put the aircraft in a powered, engines-running state instantly (used by simplified starts) */
export function forceRunning(p: PilotState) {
  const { sw, sys } = p;
  sys.batt = 1;
  sys.align = 1;
  if (isJet(p)) {
    Object.assign(sw, { batt: 1, gpu: 0, apu: 0, apuGen: 0, gen1: 1, gen2: 1, pumpL: 1, pumpR: 1, hydEng1: 1, hydEng2: 1, hydElec1: 1, hydElec2: 1, bleedApu: 0, bleed1: 1, bleed2: 1, packL: 1, packR: 1, probeHeat: 1, windowHeat: 1, ltNav: 1, ltBeacon: 1, seatBelts: 2, emerLights: 1, irsL: 1, irsR: 1, yawDamper: 1, fuelLever1: 1, fuelLever2: 1, start1: 0, start2: 0 });
    for (const e of p.eng) { e.running = true; e.n1 = 21; e.n2 = 60; e.egt = 410; e.oilT = 80; }
    sys.hyd = [3000, 3000];
    sys.duct = 40;
    sys.apuN = 0;
    sys.apuRunning = false;
    p.flags.apuStart = 0;
  } else {
    Object.assign(sw, { batt: 1, alt: 1, avionics: 1, fuelSel: 1, fuelShutoff: 1, magnetos: 3, ltBeacon: 1, pumpAux: 0 });
    p.ac.mixture = 1;
    const e = p.eng[0];
    e.running = true;
    e.rpm = 800;
    e.oilT = 80;
    p.flags.primed = 4;
  }
  p.radios.xpdr.mode = isJet(p) ? 2 : 1;
}

/** powered but engines off, ready for the before-start checklist */
export function forceReady(p: PilotState) {
  const { sw, sys } = p;
  sys.batt = 1;
  p.ap.fd = isJet(p);
  if (isJet(p)) setControl(p, 'baroQnh', 1);
  if (isJet(p)) {
    Object.assign(sw, { batt: 1, gpu: 0, apu: 1, apuGen: 1, hydEng1: 1, hydEng2: 1, bleedApu: 1, bleed1: 1, bleed2: 1, packL: 1, packR: 1, ltNav: 1, emerLights: 1, irsL: 1, irsR: 1, yawDamper: 1, windowHeat: 1, seatBelts: 2 });
    sys.apuN = 100;
    sys.apuRunning = true;
    p.flags.apuStart = 1;
    sys.align = 1;
    sys.duct = 34;
  } else {
    Object.assign(sw, { fuelSel: 1, fuelShutoff: 1 });
  }
}
