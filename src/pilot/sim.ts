/**
 * One flight from the pilot's seat: creation (start states), the fixed-step update, phase tracking,
 * callouts and the events that feed the debrief. Independent of rendering.
 */
import { FT, KT, NM, alongCross, angDiff, clamp, dist, norm360, vecOf } from '../sim/util';
import { ACDEF, coldSwitches, flapAt, isa, stallKt } from './aircraft';
import { initAtc, stepAtc, sys as sysMsg } from './atc';
import { stepAutopilot } from './autopilot';
import { GATES, missedItems, checklistsFor } from './checklists';
import { autoConfig, instructor, stepFo } from './copilot';
import { setCrash, stepFlight } from './flight';
import { FLAP_CL0, forceReady, forceRunning, indicatedAlt, isJet, setControl, stallAlpha, stepSystems, takeoffTrim } from './systems';
import { onFinal, buildRoute, greatCircle, groundElev, ilsFor, makeEnv, pickGate, pickRunway, placeAirports, planTaxiOut, rwyPoint, surfaceAt, AP_GEO } from './world';
import type { Assists, Inputs, Phase, PilotConfig, PilotState, RealismPreset } from './types';

export const DT = 1 / 60;

export const ASSIST_PRESETS: Record<RealismPreset, Assists> = {
  study: { preset: 'study', start: 'cold', autoSystems: false, autoRadio: false, autoConfig: false, autoRudder: false, autoTrim: false, protection: false, guidance: false, forgiving: false, strictRadio: true },
  standard: { preset: 'standard', start: 'ready', autoSystems: true, autoRadio: false, autoConfig: false, autoRudder: false, autoTrim: false, protection: false, guidance: true, forgiving: false, strictRadio: false },
  simplified: { preset: 'simplified', start: 'runway', autoSystems: true, autoRadio: true, autoConfig: true, autoRudder: true, autoTrim: false, protection: true, guidance: true, forgiving: true, strictRadio: false },
  casual: { preset: 'casual', start: 'runway', autoSystems: true, autoRadio: true, autoConfig: true, autoRudder: true, autoTrim: true, protection: true, guidance: true, forgiving: true, strictRadio: false },
};

export const PRESET_INFO: Record<RealismPreset, { name: string; blurb: string }> = {
  study: { name: 'Full procedures', blurb: 'Cold and dark at the stand. Every switch, every checklist, every radio call and frequency is yours. No assists.' },
  standard: { name: 'Line pilot', blurb: 'Aircraft powered up at the stand. The first officer runs the switch flows; you start the engines, talk to ATC, taxi and fly.' },
  simplified: { name: 'Fly the aeroplane', blurb: 'Lined up on the runway, engines running. Radios, gear, flaps and rudder are handled for you; stall protection is on.' },
  casual: { name: 'Easy', blurb: 'As above plus automatic trim, bank-angle control and an autopilot that can land. For getting the feel of flying.' },
};

export function defaultPilotConfig(): PilotConfig {
  return { aircraft: 'c172', kind: 'route', depId: 'LGA', destId: 'JFK', assists: { ...ASSIST_PRESETS.standard }, hour: 14, weather: 'clear', seed: 1 + Math.floor(Math.random() * 9999) };
}

/** problems that stop a configuration from being flown (shown on the setup screen) */
export function configProblems(cfg: PilotConfig): string[] {
  const out: string[] = [];
  const def = ACDEF[cfg.aircraft];
  if (cfg.kind === 'route') {
    if (cfg.depId === cfg.destId) out.push('Choose two different airports, or pick "Traffic pattern" to stay at one.');
    else {
      const nm = greatCircle(AP_GEO[cfg.depId], AP_GEO[cfg.destId]).nm;
      if (nm > def.rangeNm) out.push(`${Math.round(nm)} NM is beyond this aircraft's range (${def.rangeNm} NM).`);
    }
  }
  return out;
}

function phonetic(cs: string): string {
  return cs;
}

/** set the angle of attack and trim for steady flight at the present speed */
function trimNow(p: PilotState) {
  const { ac } = p;
  const def = ACDEF[p.cfg.aircraft];
  const atm = isa(ac.z);
  const q = 0.5 * atm.rho * ac.tas * ac.tas;
  const CL = (ac.mass * 9.80665) / (q * def.S);
  const a = (CL - def.CL0 - FLAP_CL0 * flapAt(def, ac.flaps).dCL) / def.CLa;
  const aS = stallAlpha(p);
  ac.alpha = a;
  ac.trim = clamp(a >= 2 ? (a - 2) / (aS + 3) : (a - 2) / 7, -1, 1);
}

export function createPilot(cfg: PilotConfig): PilotState {
  const kind = cfg.aircraft;
  const def = ACDEF[kind];
  const jet = kind === 'jet';
  const A = cfg.assists;
  const start = cfg.kind === 'approach' ? 'final' : A.start === 'final' ? 'runway' : A.start;
  const airports = placeAirports(cfg);
  const last = airports.length - 1;
  const depRwy = pickRunway(airports, 0, kind);
  const arrRwy = cfg.kind === 'route' ? pickRunway(airports, last, kind) : depRwy;
  const { route, cruise } = buildRoute(cfg, airports, depRwy, arrRwy);
  const nm = cfg.kind === 'route' ? greatCircle(airports[0], airports[last]).nm : 20;
  const fuel = jet ? clamp(nm * 5.2 + 3200, 4500, def.fuelCap) : clamp(nm * 0.3 + 45, 60, def.fuelCap);
  const callsign = cfg.callsign ?? (jet ? `DAL${200 + (cfg.seed % 1700)}` : `N${100 + (cfg.seed % 800)}SP`);
  const depGate = pickGate(airports[0].ap, kind, cfg.seed);
  const arrGate = pickGate(airports[last].ap, kind, cfg.seed + 7, cfg.kind === 'route' ? undefined : undefined);
  const mass = def.oew + def.payload + fuel;
  const vsTo = stallKt(def, mass, jet ? 2 : 0), vsLd = stallKt(def, mass - (jet ? nm * 4.5 : 0), def.ldgFlap);
  const vr = jet ? Math.round(vsTo * 1.14) : 55;
  const p: PilotState = {
    cfg, t: 0, rng: cfg.seed * 7919 + 13, callsign, radioName: jet ? `Delta ${callsign.slice(3)}` : `Skyhawk ${callsign.slice(1)}`,
    airports, env: makeEnv(cfg, airports[0]),
    ac: {
      x: 0, y: 0, z: airports[0].elev, agl: 0, tas: 0, ias: 0, mach: 0, gs: 0, gtrk: 0, vs: 0, hdg: 0, trk: 0, pitch: 0, bank: 0, gamma: 0, alpha: 0, beta: 0, q: 0, p: 0, r: 0,
      onGround: true, g: 1, elev: 0, ail: 0, rud: 0, trim: 0, flapIdx: 0, flaps: 0, gearLever: true, gear: 1, spoilerLever: 0, spoilerArmed: false, spoiler: 0,
      throttle: Array(def.engines).fill(0), reverse: false, brake: 0, parkBrake: true, mixture: 0, fuel, mass, stalled: false, surface: 'apron', crashed: null,
    },
    eng: Array.from({ length: def.engines }, () => ({ rpm: 0, n1: 0, n2: 0, egt: 15, ff: 0, oilP: 0, oilT: 15, running: false, starting: 0, thrust: 0 })),
    sw: coldSwitches(kind),
    sys: { bus: false, source: 'none', batt: 1, extAvail: jet, apuN: 0, apuRunning: false, hyd: [0, 0], duct: 0, packs: 0, align: 0, cabinAlt: 0, fuelPress: [false, false], avionics: false, warnings: [], cautions: [], configWarn: false, stallWarn: false, overspeed: false, gpws: null },
    ap: { fd: false, cmd: false, at: false, atMode: 'off', lat: 'off', vert: 'off', locArmed: false, gsArmed: false, selHdg: Math.round(depRwy.hdg) % 360, selAlt: 0, selVs: 0, selSpd: jet ? 100 : 76, fdPitch: 0, fdBank: 0 },
    radios: { com: { act: 122.8, sby: 121.5 }, nav: { act: 110.5, sby: 111.1, crs: Math.round(arrRwy.hdg) % 360 }, xpdr: { code: jet ? 2000 : 1200, mode: 0 }, baro: 1013, std: false },
    ils: { valid: false, loc: 0, gs: 0, gsValid: false, dme: 0, crs: 0 },
    phase: 'preflight', route, leg: 0, cruiseAlt: cruise, depRwy, arrRwy, depGate: depGate.name, arrGate: arrGate.name,
    taxi: null, push: null,
    atc: { stage: 'none', station: '', freq: 0, log: [], clearedIfr: false, clearedPush: false, clearedTaxi: false, clearedLineup: false, clearedTakeoff: false, clearedApproach: false, clearedLand: false, clearedTaxiIn: false, alt: 0, squawk: 0, queue: [], foDelay: 4, flags: {} },
    findings: [], landings: [], flags: {}, callouts: [], foQueue: [], foTimer: 2,
    vspeeds: { v1: vr - 5, vr, v2: jet ? Math.round(vsTo * 1.2) : 74, vref: Math.round(vsLd * 1.3), vapp: Math.round(vsLd * 1.3) + (jet ? 5 : 4) },
    distFlown: 0, accel: 1, over: false,
  };
  void phonetic;
  const ac = p.ac;
  // surface plan (stand, pushback, taxi route)
  const plan = planTaxiOut(p);
  if (plan) {
    p.taxi = plan.taxi;
    p.push = plan.push;
    ac.x = plan.gatePos[0];
    ac.y = plan.gatePos[1];
    ac.hdg = jet ? plan.gateHdg : norm360(plan.gateHdg + 180);
  }
  if (start === 'cold') { /* everything off */ }
  if (start === 'ready') { forceReady(p); if (jet) p.phase = 'before_start'; }
  if (start === 'running' || start === 'runway' || start === 'final') {
    forceRunning(p);
    setControl(p, 'baroQnh', 1);
    p.ap.fd = true;
    if (p.push) {
      const e = p.push.pts[p.push.pts.length - 1], l = p.push.pts[p.push.pts.length - 2];
      ac.x = e[0];
      ac.y = e[1];
      ac.hdg = Math.atan2(l[0] - e[0], l[1] - e[1]) * (180 / Math.PI);
      ac.hdg = norm360(ac.hdg);
      p.push.done = true;
      p.push.s = p.push.len;
    }
    p.flags.pushed = 1;
    p.phase = 'taxi_out';
    ac.trim = takeoffTrim(p);
    ac.flapIdx = jet ? 2 : 0;
    ac.flaps = ac.flapIdx;
    if (jet) { p.sw.autobrake = 0; p.sw.ltTaxi = 1; }
    else { p.flags.magL = 1; p.flags.magR = 1; }
  }
  if (start === 'runway') {
    const [x, y] = rwyPoint(depRwy, -70);
    ac.x = x;
    ac.y = y;
    ac.hdg = depRwy.hdg;
    p.phase = 'before_takeoff';
    p.taxi = null;
    Object.assign(p.sw, jet ? { ltStrobe: 1, ltLanding: 1, ltTaxi: 0 } : { ltStrobe: 1, ltLanding: 1, pumpAux: 1 });
    p.radios.xpdr.mode = jet ? 2 : 1;
    ac.surface = 'runway';
    ac.parkBrake = true;
  }
  if (start === 'final') {
    const f = route[0];
    ac.x = f.x;
    ac.y = f.y;
    const [ux, uy] = vecOf(arrRwy.hdg + 180);
    const back = (jet ? 10 : 4) * NM - dist(f.x, f.y, arrRwy.thrX, arrRwy.thrY);
    ac.x += ux * back;
    ac.y += uy * back;
    ac.z = arrRwy.elev + Math.tan((3 * Math.PI) / 180) * ((jet ? 10 : 4) * NM + arrRwy.aim);
    ac.onGround = false;
    ac.parkBrake = false;
    ac.hdg = ac.trk = ac.gtrk = arrRwy.hdg;
    ac.flapIdx = jet ? 2 : 1;
    ac.flaps = ac.flapIdx;
    if (jet) { ac.gearLever = false; ac.gear = 0; }
    const atm = isa(ac.z);
    ac.tas = ((jet ? 185 : 85) * KT) / Math.sqrt(atm.sigma);
    ac.gamma = 0;
    trimNow(p);
    ac.pitch = ac.alpha;
    setControl(p, 'throttle', jet ? 0.42 : 0.5);
    for (const e of p.eng) { e.n1 = jet ? 55 : 60; e.n2 = 78; e.rpm = 2200; e.thrust = jet ? 22000 : 600; }
    p.phase = 'approach';
    p.taxi = null;
    p.radios.nav.act = arrRwy.ilsFreq;
    p.ap.selAlt = Math.round(ac.z / FT / 100) * 100;
    p.ap.selSpd = jet ? 185 : 85;
    p.ap.selHdg = Math.round(arrRwy.hdg) % 360;
    Object.assign(p.sw, jet ? { ltLanding: 1, ltStrobe: 1 } : { ltLanding: 1, ltStrobe: 1, pumpAux: 1 });
    p.flags.airTime = 100;
    p.flags.wasAir = 1;
  }
  ac.trk = ac.gtrk = ac.hdg;
  ac.z = start === 'final' ? ac.z : groundElev(p, ac.x, ac.y);
  ac.agl = ac.z - groundElev(p, ac.x, ac.y);
  p.sys.cabinAlt = ac.z / FT;
  initAtc(p);
  stepSystems(p, 0.001);
  p.ils = ilsFor(p);
  sysMsg(p, cfg.kind === 'approach' ? `You are on a ${jet ? 10 : 4}-mile final for runway ${arrRwy.name}. Fly the approach and land.` : `${callsign} at ${airports[0].ap.icao} ${start === 'runway' ? `runway ${depRwy.name}` : `stand ${depGate.name}`}. ${cfg.kind === 'pattern' ? 'Traffic-pattern training.' : `Destination ${airports[last].ap.icao}, ${Math.round(nm)} NM.`}`);
  return p;
}

// ───────────────────────────── phase tracking & events ─────────────────────────────

function finding(p: PilotState, key: string, cat: PilotState['findings'][0]['cat'], pts: number, text: string, cool = 1e9) {
  if (p.t - (p.flags['f_' + key] ?? -1e9) < cool) return;
  p.flags['f_' + key] = p.t;
  p.findings.push({ t: p.t, cat, pts, text });
}

function setPhase(p: PilotState, ph: Phase) {
  if (p.phase === ph) return;
  const gates = GATES[p.cfg.aircraft][ph];
  if (gates && !(ph === 'landing' && p.flags.gatedLanding) && !(ph === 'takeoff' && p.flags.tng)) {
    for (const id of gates) {
      const miss = missedItems(p, id).filter((i) => i.ctl !== 'atc');
      if (!miss.length) continue;
      const title = checklistsFor(p).find((c) => c.id === id)!.title;
      p.findings.push({ t: p.t, cat: 'procedure', pts: -Math.min(10, miss.length * 2), text: `"${title}" checklist not complete: ${miss.slice(0, 5).map((m) => `${m.label} (${m.expect})`).join('; ')}${miss.length > 5 ? ` and ${miss.length - 5} more` : ''}.` });
    }
    if (ph === 'landing') p.flags.gatedLanding = 1;
  }
  p.phase = ph;
  p.flags.phaseT = p.t;
}

function trackPhase(p: PilotState) {
  const { ac } = p;
  const jet = isJet(p);
  const def = ACDEF[p.cfg.aircraft];
  const running = p.eng.every((e) => e.running);
  const anyStart = p.eng.some((e) => e.running || e.starting > 0 || (p.flags.crank ?? 0) > 0);
  const aglFt = ac.agl / FT;
  const alt = ac.z / FT;
  const dArr = dist(ac.x, ac.y, p.arrRwy.thrX, p.arrRwy.thrY) / NM;
  const sfc = ac.onGround ? surfaceAt(p, ac.x, ac.y) : null;
  const toThrust = ac.throttle[0] > (jet ? 0.6 : 0.7) && !ac.reverse;
  switch (p.phase) {
    case 'preflight':
      if (jet ? missedItems(p, 'preflight').length === 0 : p.sys.bus) setPhase(p, 'before_start');
      if (anyStart) setPhase(p, 'engine_start');
      break;
    case 'before_start':
      if (jet && p.push && p.atc.clearedPush && !p.push.done) setPhase(p, 'pushback');
      else if (anyStart) setPhase(p, 'engine_start');
      break;
    case 'pushback':
      if (anyStart || p.push?.done) setPhase(p, 'engine_start');
      break;
    case 'engine_start':
      if (running && (!p.push || p.push.done) && (p.atc.clearedTaxi || ac.gs > 1.5)) setPhase(p, 'taxi_out');
      break;
    case 'taxi_out': {
      const nearHold = p.taxi?.hold ? dist(ac.x, ac.y, p.taxi.hold[0], p.taxi.hold[1]) < 90 : false;
      if (nearHold || sfc?.rwy === p.depRwy.rwyId) setPhase(p, 'before_takeoff');
      break;
    }
    case 'before_takeoff':
      if (sfc?.kind === 'runway' && toThrust && ac.gs > 5) setPhase(p, 'takeoff');
      break;
    case 'takeoff':
      if (!ac.onGround && aglFt > (jet ? 1000 : 500)) setPhase(p, 'climb');
      if (ac.onGround && ac.gs < 3 && !toThrust && p.t - (p.flags.phaseT ?? 0) > 8) setPhase(p, 'before_takeoff'); // rejected
      break;
    case 'climb':
      if (p.cfg.kind === 'pattern') { if (p.leg >= 3) setPhase(p, 'approach'); }
      else if (alt > p.cruiseAlt - 300 && Math.abs(ac.vs) < 2.5) setPhase(p, 'cruise');
      else if (dArr < (jet ? 30 : 9) && ac.vs < -1) setPhase(p, 'descent');
      break;
    case 'cruise':
      if ((alt < p.cruiseAlt - 800 && ac.vs < -1) || dArr < (jet ? 28 : 7)) setPhase(p, 'descent');
      break;
    case 'descent':
      if (dArr < (jet ? 26 : 7) && aglFt < (jet ? 9000 : 3500)) setPhase(p, 'approach');
      break;
    case 'approach': {
      const [along, cross] = alongCross(ac.x, ac.y, p.arrRwy.thrX, p.arrRwy.thrY, p.arrRwy.hdg);
      if (aglFt < (jet ? 1000 : 500) && along < 0 && -along < 5 * NM && Math.abs(cross) < 600) setPhase(p, 'landing');
      break;
    }
    case 'landing':
      if (aglFt > (jet ? 1500 : 800) && ac.vs > 2) setPhase(p, 'approach'); // went around
      break;
    case 'rollout':
      if (toThrust && p.cfg.kind === 'pattern') { p.flags.tng = (p.flags.tng ?? 0) + 1; p.flags.gatedLanding = 0; p.leg = 0; Object.assign(p.ap, { lat: 'off', vert: 'off', locArmed: false, gsArmed: false, cmd: false }); setPhase(p, 'takeoff'); }
      else if (ac.gs < 30 * KT && sfc && sfc.kind !== 'runway') setPhase(p, 'taxi_in');
      else if (ac.gs < 0.3 && p.t - (p.flags.phaseT ?? 0) > 6 && sfc?.kind !== 'runway') setPhase(p, 'taxi_in');
      break;
    case 'taxi_in': {
      const pa = p.airports[p.arrRwy.apIdx];
      const g = pa.ap.gates.find((x) => x.name === p.arrGate);
      const n = g ? pa.ap.nodes[g.node] : null;
      const atGate = n ? dist(ac.x, ac.y, n.x + pa.ox, n.y + pa.oy) < (jet ? 45 : 30) : false;
      if (ac.gs < 0.3 && ((atGate && ac.parkBrake) || !running)) { p.flags.atGate = atGate ? 1 : 0; setPhase(p, 'shutdown'); }
      break;
    }
    case 'shutdown':
      if (p.eng.every((e) => !e.running) && ac.gs < 0.3 && !p.flags.engOffT) p.flags.engOffT = p.t;
      if (p.flags.engOffT && ac.gs < 0.3 && (missedItems(p, 'shutdown').length === 0 || p.t - p.flags.engOffT > 60)) { setPhase(p, 'complete'); finding(p, 'done', 'procedure', p.flags.atGate ? 5 : 0, p.flags.atGate ? `Parked at stand ${p.arrGate} and shut down.` : 'Engines shut down away from the assigned stand.'); }
      else if (ac.gs > 2) setPhase(p, 'taxi_in');
      break;
  }
  // touchdown → roll-out
  if (ac.onGround && p.flags.wasAir && p.phase !== 'rollout' && p.phase !== 'taxi_in' && p.phase !== 'shutdown' && p.phase !== 'complete' && p.phase !== 'takeoff') {
    if (p.phase !== 'landing') setPhase(p, 'landing');
    setPhase(p, 'rollout');
  }
  if (ac.onGround && p.flags.wasAir && p.phase === 'takeoff' && p.cfg.kind !== 'pattern' && p.t - (p.flags.liftoff ?? 0) > 3 && !toThrust) setPhase(p, 'rollout');
  p.flags.wasAir = ac.onGround ? 0 : 1;
  if (!ac.onGround && (p.phase === 'before_takeoff' || p.phase === 'taxi_out' || p.phase === 'rollout')) setPhase(p, 'takeoff');
  void def;
}

const RA_CALLS = [1000, 500, 100, 50, 30, 20, 10];

function events(p: PilotState, dt: number) {
  const { ac, sys } = p;
  const jet = isJet(p);
  const def = ACDEF[p.cfg.aircraft];
  const aglFt = ac.agl / FT;
  // takeoff callouts
  if (p.phase === 'takeoff' && ac.onGround) {
    if (jet && ac.ias > 80 && !p.flags.c80) { p.flags.c80 = 1; p.callouts.push('80 knots'); }
    if (jet && ac.ias > p.vspeeds.v1 && !p.flags.cV1) { p.flags.cV1 = 1; p.callouts.push('V1'); }
    if (ac.ias > p.vspeeds.vr && !p.flags.cVr) { p.flags.cVr = 1; p.callouts.push('rotate'); }
  }
  if (!ac.onGround && p.phase === 'takeoff' && ac.vs > 1.5 && !p.flags.cPos) { p.flags.cPos = 1; if (def.retract) p.callouts.push('positive rate'); }
  if (ac.onGround && p.phase === 'before_takeoff') { p.flags.c80 = p.flags.cV1 = p.flags.cVr = p.flags.cPos = 0; }
  // radio-altitude callouts on the way down
  if (!ac.onGround && ac.vs < -0.5 && (p.phase === 'approach' || p.phase === 'landing')) {
    const prev = p.flags.lastRa ?? 99999;
    for (const h of RA_CALLS) if (jet && prev > h && aglFt <= h) p.callouts.push(String(h));
    if (jet && prev > 200 && aglFt <= 200) p.callouts.push('minimums');
    // stabilised-approach gate
    const gate = jet ? 1000 : 400;
    if (prev > gate && aglFt <= gate) {
      const probs: string[] = [];
      if (ac.ias > p.vspeeds.vapp + (jet ? 20 : 15)) probs.push(`${Math.round(ac.ias - p.vspeeds.vapp)} kt fast`);
      if (ac.ias < p.vspeeds.vref - 5) probs.push('below Vref');
      if (def.retract && ac.gear < 0.99) probs.push('gear not down');
      if (ac.flapIdx < def.ldgFlap - 1) probs.push('landing flap not set');
      if (-ac.vs / FT * 60 > (jet ? 1200 : 900)) probs.push('high sink rate');
      const [, cross] = alongCross(ac.x, ac.y, p.arrRwy.thrX, p.arrRwy.thrY, p.arrRwy.hdg);
      if (Math.abs(cross) > (jet ? 250 : 180)) probs.push('not aligned with the runway');
      if (probs.length) finding(p, 'unstable', 'flying', -8, `Unstable approach at ${gate} ft: ${probs.join(', ')}. A go-around would be the correct decision.`, 120);
      else finding(p, 'stable', 'flying', 4, `Stabilised approach at ${gate} ft.`, 120);
    }
  }
  p.flags.lastRa = ac.onGround ? 99999 : aglFt;

  // new landing
  if (p.flags.touchdown === p.t) {
    const L = p.landings[p.landings.length - 1];
    if (!p.atc.clearedLand) finding(p, 'noLdgClr', 'atc', -15, 'Landed without a landing clearance.', 30);
    if ((p.flags.bounces ?? 0) > 0) finding(p, 'bounce', 'landing', -5, `Bounced ${p.flags.bounces} time(s) before staying down – hold the landing attitude, do not push forward.`, 30);
    if (L.offRunway) finding(p, 'offRwy', 'safety', -25, 'Touched down off the runway.', 30);
    p.callouts.push('touchdown');
  }
  if (p.flags.tailStrike === p.t) finding(p, 'tail', 'safety', -15, 'Tail strike: rotated to too high a pitch attitude on the ground.');
  if (p.flags.hotStart) { p.flags.hotStart = 0; finding(p, 'hot', 'procedure', -5, 'Hot start: fuel was introduced below 20% N2.'); }
  if (p.flags.overRev) { p.flags.overRev = 0; finding(p, 'overrev', 'procedure', -2, 'Engine started with the throttle too far open.'); }
  if (p.flags.noStart === p.t && !p.cfg.assists.autoSystems) sysMsg(p, 'The engine cranked but did not fire. Prime first: fuel pump ON with the mixture RICH for a few seconds, magnetos to START.');

  // warnings held for a moment become findings and aural alerts
  const hold = (key: string, on: boolean, sec: number) => {
    p.flags[key] = on ? (p.flags[key] ?? 0) + dt : 0;
    return on && p.flags[key] >= sec && p.flags[key] - dt < sec;
  };
  if (hold('hStall', sys.stallWarn, 0.8)) { finding(p, 'stall', 'safety', -10, 'Stall warning – angle of attack too high. Lower the nose and add power.', 25); p.callouts.push('stall'); }
  if (hold('hOver', sys.overspeed, 1.5)) { finding(p, 'overspeed', 'safety', -5, ac.flaps > 0.05 && ac.ias < def.vmo ? 'Flap limit speed exceeded.' : 'Maximum operating speed exceeded.', 40); p.callouts.push('overspeed'); }
  if (hold('hCfg', sys.configWarn, 0.3)) { finding(p, 'config', 'procedure', -8, 'Takeoff configuration warning: flaps, trim, speedbrake or parking brake not set for takeoff.', 60); p.callouts.push('config'); }
  if (sys.gpws && sys.gpws !== p.atc.flags.lastGpws as unknown) {
    p.callouts.push(sys.gpws.toLowerCase());
    if (sys.gpws === 'PULL UP') finding(p, 'pullup', 'safety', -10, 'GPWS "PULL UP": excessive descent rate close to the ground.', 30);
    if (sys.gpws === 'TOO LOW GEAR') finding(p, 'tlg', 'safety', -8, 'GPWS "TOO LOW GEAR": below 500 ft without the gear down.', 60);
  }
  (p.atc.flags as Record<string, unknown>).lastGpws = sys.gpws ?? 0;
  if (!ac.onGround && Math.abs(ac.bank) > (jet ? 38 : 50)) finding(p, 'bank', 'flying', -3, `Bank angle beyond ${jet ? 35 : 45}°.`, 40);
  if (ac.onGround && ac.surface === 'grass' && ac.gs > 2) finding(p, 'grass', 'safety', -12, 'Left the paved surface.', 60);
  if (ac.onGround && ac.gs > 3 && p.sys.bus && jet && !p.sw.ltBeacon) finding(p, 'beacon', 'procedure', -2, 'Aircraft moved with the anti-collision light off.');

  // run-up magneto check (trainer)
  if (!jet && p.eng[0].running && p.eng[0].rpm > 1600 && ac.gs < 1) {
    if (p.sw.magnetos === 1) p.flags.magR = 1;
    if (p.sw.magnetos === 2) p.flags.magL = 1;
  }
  if (ac.crashed && !p.over) { p.over = true; p.findings.push({ t: p.t, cat: 'safety', pts: -60, text: `Accident: ${ac.crashed}.` }); p.callouts.push('crash'); }
  if (!ac.onGround && ac.fuel <= 0 && !p.flags.dry) { p.flags.dry = 1; finding(p, 'dry', 'safety', -30, 'Fuel exhausted in flight.'); }
  if (p.phase === 'complete' && !p.over) p.over = true;
  void setCrash;
}

/** advance the flight by one fixed step */
export function stepPilot(p: PilotState, inp: Inputs, dt = DT) {
  if (p.over && p.ac.crashed) return;
  p.t += dt;
  stepSystems(p, dt);
  p.ils = ilsFor(p);
  const A = p.cfg.assists;
  const inst = !!p.flags.instructor;
  let ctl = inp;
  if (inst) ctl = instructor(p, dt);
  else if (A.autoConfig) autoConfig(p);
  ctl = stepAutopilot(p, ctl, dt);
  stepFlight(p, ctl, dt);
  if (p.cfg.kind !== 'pattern' && (p.phase === 'approach' || p.phase === 'descent') && p.leg < p.route.length - 1 && onFinal(p) && (p.flags.airTime ?? 0) > 20) p.leg = p.route.length - 1;
  stepAtc(p, dt);
  trackPhase(p);
  events(p, dt);
  stepFo(p, dt, A.autoSystems || inst);
  if (inst && !A.autoRadio) {
    // the instructor also works the radio
    p.cfg.assists.autoRadio = true;
    p.flags.instRadio = 1;
  }
}

export function setInstructor(p: PilotState, on: boolean) {
  p.flags.instructor = on ? 1 : 0;
  if (on) { p.flags.instructorUsed = 1; p.flags.taxiI = 0; }
  else if (p.flags.instRadio) { p.cfg.assists.autoRadio = false; p.flags.instRadio = 0; }
}

/** maximum time acceleration allowed right now */
export function maxAccel(p: PilotState): number {
  const { ac } = p;
  if (ac.onGround) return ac.gs < 1 ? 4 : 2;
  if (!p.ap.cmd && !p.flags.instructor) return 1;
  const aglFt = ac.agl / FT;
  if (p.phase === 'approach' || p.phase === 'landing' || aglFt < 3000) return 2;
  if (p.phase === 'cruise') return 32;
  return 8;
}

export { indicatedAlt };
