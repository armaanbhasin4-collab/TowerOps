/**
 * Emergency system: random and fuel-driven emergencies with operational consequences
 * (performance degradation, runway blockage, priority handling) and outcome tracking.
 */
import type { Aircraft, EmergencyKind } from './types';
import { NM, dist, hdgOf, pickWeighted, rand, randRange } from './util';
import { typeOf } from './data/aircraft';
import { World, clearRequest, csay, isAirborne, logEvent, radioPilot } from './world';
import { rejectTakeoff } from './ground';
import { sayAlt } from './phraseology';
import { tickChallenge } from './scenarios';

const LABEL: Record<EmergencyKind, string> = {
  engine_failure: 'engine failure', dual_engine_failure: 'dual engine failure', hydraulic: 'hydraulic system failure',
  gear: 'landing gear malfunction', electrical: 'electrical failure', flight_control: 'flight control malfunction',
  brake_failure: 'brake failure', tire_failure: 'tire failure', rejected_takeoff: 'rejected takeoff',
  medical: 'passenger medical emergency', crew_medical: 'crew member incapacitated', min_fuel: 'minimum fuel',
  fuel_emergency: 'fuel emergency', turbulence: 'injuries from severe turbulence', windshear: 'wind shear encounter',
  fire: 'fire indication', evacuation: 'evacuation', disabled_taxiway: 'mechanical problem, unable to taxi',
  pilot_deviation: 'pilot deviation',
};
export const emergencyLabel = (k: EmergencyKind) => LABEL[k];
const MAYDAY = new Set<EmergencyKind>(['engine_failure', 'dual_engine_failure', 'fuel_emergency', 'fire', 'flight_control', 'evacuation', 'gear', 'hydraulic']);

export function scheduleNextEmergency(w: World) {
  const f = w.s.cfg.difficulty.emergencyFreq;
  w.s.nextEmergency = f > 0 ? w.s.t + Math.max(90, (-Math.log(1 - rand(w.s) * 0.999) * 3600) / f) : Infinity;
}

export function declareEmergency(w: World, ac: Aircraft, kind: EmergencyKind): boolean {
  const { s, ap } = w;
  if (ac.emergency && !ac.emergency.resolved) return false;
  const mayday = MAYDAY.has(kind);
  ac.emergency = { kind, since: s.t, mayday };
  const pre = mayday ? 'MAYDAY, MAYDAY, MAYDAY, ' : 'PAN-PAN, PAN-PAN, PAN-PAN, ';
  const fac = `${ap.facility} ${isAirborne(ac) ? (ac.kind === 'departure' ? 'Departure' : 'Approach') : 'Ground'}`;
  let msg = '';
  let reqText = LABEL[kind];
  switch (kind) {
    case 'engine_failure':
    case 'dual_engine_failure':
      if (ac.phase === 'departure') {
        // return to the field: the flight becomes an arrival
        ac.kind = 'arrival';
        ac.dest = ap.iata;
        ac.phase = 'inbound';
        ac.tgtAlt = Math.max(3000, Math.min(ac.tgtAlt, Math.ceil((ac.alt + 500) / 1000) * 1000, 5000));
        ac.latMode = 'hdg';
        ac.tgtHdg = ac.hdg;
        ac.sched = s.t + 600;
        ac.nextLeg = undefined;
        msg = `${LABEL[kind]}, requesting immediate return to the field`;
      } else msg = `${LABEL[kind]}, request priority handling and the longest runway`;
      if (kind === 'dual_engine_failure') msg = `we have lost all engines, gliding, need the nearest runway immediately`;
      ac.emergency.blockFor = kind === 'dual_engine_failure' ? 900 : undefined;
      break;
    case 'hydraulic':
      msg = `hydraulic failure, reduced braking and steering, we will stop on the runway, request emergency equipment`;
      ac.emergency.blockFor = randRange(s, 420, 720);
      break;
    case 'gear':
      msg = `unsafe gear indication, request emergency equipment standing by, we will be unable to clear the runway`;
      ac.emergency.blockFor = randRange(s, 600, 960);
      break;
    case 'electrical': msg = `electrical failure, limited instruments, request vectors to the nearest suitable runway`; break;
    case 'flight_control': msg = `flight control problem, limited manoeuvrability, request wide turns and a long final`; break;
    case 'brake_failure':
      msg = `we have lost braking, unable to exit, stopping on the runway`;
      ac.emergency.blockFor = randRange(s, 360, 600);
      break;
    case 'tire_failure':
      msg = `blown tires, stopping on the runway, request inspection`;
      ac.emergency.blockFor = randRange(s, 420, 660);
      ac.flags.stopOnRwy = 1;
      break;
    case 'rejected_takeoff': break;
    case 'medical':
    case 'crew_medical':
      msg = isAirborne(ac) ? `${LABEL[kind]}, request priority to the gate, paramedics on arrival` : `${LABEL[kind]}, ${ac.kind === 'departure' ? 'request return to the gate' : 'request expedited taxi, paramedics to meet the aircraft'}`;
      break;
    case 'min_fuel': msg = `declaring minimum fuel, ${Math.round(ac.fuelMin)} minutes remaining, unable to accept any undue delay`; break;
    case 'fuel_emergency': msg = `fuel emergency, ${Math.round(ac.fuelMin)} minutes of fuel remaining, request immediate approach`; break;
    case 'turbulence': msg = `severe turbulence encounter, passengers injured, request priority handling`; break;
    case 'fire':
      msg = isAirborne(ac) ? `fire indication, request immediate landing` : `fire indication, we are stopping and evacuating on the ${ac.phase === 'parked' ? 'stand' : 'taxiway'}`;
      break;
    case 'disabled_taxiway': msg = `we have a mechanical problem and are unable to taxi, request a tug`; break;
    default: msg = LABEL[kind];
  }
  if (kind === 'min_fuel') radioPilot(w, ac, `${fac}, ${csay(ac)}, ${msg}.`, true);
  else if (msg) radioPilot(w, ac, `${pre}${fac}, ${csay(ac)}, ${msg}.`, true);
  ac.request = { type: 'emergency', since: s.t, text: `${mayday ? 'MAYDAY' : 'PAN-PAN'} – ${reqText}` };
  logEvent(w, 'emergency', mayday ? 'critical' : 'warning', `${ac.callsign} declares ${mayday ? 'MAYDAY' : kind === 'min_fuel' ? 'minimum fuel' : 'PAN-PAN'}: ${LABEL[kind]}`, [ac]);

  // immediate ground effects
  if (!isAirborne(ac)) {
    if (kind === 'fire' || kind === 'evacuation') {
      ac.phase = 'disabled';
      ac.gs = 0;
      ac.flags.disabledUntil = s.t + randRange(s, 600, 900);
      ac.route = ac.route.length > 1 ? ac.route : [];
    } else if (kind === 'disabled_taxiway') {
      ac.holdPos = true;
      ac.flags.mechUntil = s.t + randRange(s, 240, 420);
    }
  }
  return true;
}

function eligible(w: World): { ac: Aircraft; kind: EmergencyKind; weight: number }[] {
  const out: { ac: Aircraft; kind: EmergencyKind; weight: number }[] = [];
  const expert = !w.s.cfg.difficulty.pilotAssist;
  for (const ac of w.s.aircraft) {
    if (ac.emergency) continue;
    const add = (kind: EmergencyKind, weight: number) => out.push({ ac, kind, weight });
    switch (ac.phase) {
      case 'inbound':
      case 'approach':
        add('medical', 4); add('engine_failure', 2); add('hydraulic', 1.4); add('gear', 1.4); add('electrical', 0.8);
        add('flight_control', 0.7); add('crew_medical', 0.6); add('dual_engine_failure', 0.06);
        break;
      case 'departure':
        if (ac.alt < 7000 && ac.alt > 400) { add('engine_failure', 3.5); add('medical', 0.6); }
        break;
      case 'takeoff_roll':
        if (ac.ias < typeOf(ac.type).vr - 25) { add('rejected_takeoff', 6); add('tire_failure', 3); }
        break;
      case 'landing_roll':
        if (ac.gs > 70 && ac.route.length < 2) { add('brake_failure', 3); add('tire_failure', 3); }
        break;
      case 'taxi_out':
        add('medical', 1); add('disabled_taxiway', 1.2); add('fire', 0.4);
        break;
      case 'taxi_in':
        add('disabled_taxiway', 1); add('fire', 0.3); add('medical', 0.5);
        break;
    }
    void expert;
  }
  return out;
}

export function triggerRandomEmergency(w: World): boolean {
  const opts = eligible(w);
  if (!opts.length) return false;
  const o = pickWeighted(w.s, opts, (x) => x.weight);
  if (o.kind === 'rejected_takeoff') {
    o.ac.emergency = { kind: 'rejected_takeoff', since: w.s.t, mayday: false };
    rejectTakeoff(w, o.ac, 'engine warning');
    o.ac.emergency.resolved = w.s.t;
    return true;
  }
  if (o.kind === 'tire_failure' && o.ac.phase === 'takeoff_roll') {
    rejectTakeoff(w, o.ac, 'tire failure');
  }
  return declareEmergency(w, o.ac, o.kind);
}

/** called once per simulated second */
export function updateEmergencies(w: World) {
  const { s, ap } = w;
  tickChallenge(w);
  if (s.t >= s.nextEmergency) {
    const ok = triggerRandomEmergency(w);
    if (ok) scheduleNextEmergency(w);
    else s.nextEmergency = s.t + 20;
  }
  for (const ac of s.aircraft) {
    // fuel state
    if (isAirborne(ac) && ac.kind === 'arrival' && s.cfg.difficulty.fuelRealism) {
      const em = ac.emergency && !ac.emergency.resolved ? ac.emergency.kind : undefined;
      if (ac.fuelMin < 30 && !ac.flags.minFuel) {
        ac.flags.minFuel = 1;
        if (!em) declareEmergency(w, ac, 'min_fuel');
        else logEvent(w, 'fuel', 'warning', `${ac.callsign} is now at minimum fuel`, [ac]);
      }
      if (ac.fuelMin < 15 && !ac.flags.fuelEmerg) {
        ac.flags.fuelEmerg = 1;
        if (em === 'min_fuel' || !em) {
          ac.emergency = undefined;
          declareEmergency(w, ac, 'fuel_emergency');
        }
        if (ac.latMode === 'hold') radioPilot(w, ac, `${csay(ac)} unable to hold any longer, we need an approach now.`, true);
      }
      if (ac.fuel <= 0 && !ac.flags.flameout) {
        ac.flags.flameout = 1;
        ac.emergency = { kind: 'dual_engine_failure', since: ac.emergency?.since ?? s.t, mayday: true, blockFor: 900 };
        radioPilot(w, ac, `MAYDAY, MAYDAY, MAYDAY, ${csay(ac)}, fuel exhausted, engines have flamed out, ${sayAlt(Math.round(ac.alt / 100) * 100)}.`, true);
        logEvent(w, 'fuel', 'critical', `${ac.callsign} has run out of fuel and is gliding`, [ac]);
        s.stats.safetyPenalty += 15;
      }
      // long holds / repeated missed approaches with marginal fuel end in a diversion
      const holding = ac.latMode === 'hold' && s.t - (ac.flags.holdStart ?? s.t) > 900;
      if (!em && !ac.flags.diverting && ac.phase === 'inbound' && ((holding && ac.fuelMin < 45) || ac.goArounds >= 3)) {
        ac.flags.diverting = 1;
        ac.latMode = 'hdg';
        ac.tgtHdg = hdgOf(ac.x, ac.y);
        ac.tgtAlt = 10000;
        ac.tgtSpd = 0;
        clearRequest(ac);
        s.stats.diversions++;
        s.stats.safetyPenalty += 1;
        radioPilot(w, ac, `${csay(ac)}, we can't accept any further delay, diverting to our alternate.`);
        logEvent(w, 'diversion', 'warning', `${ac.callsign} is diverting (${ac.goArounds >= 3 ? 'multiple missed approaches' : 'excessive holding'})`, [ac]);
      }
    }
    if (ac.flags.turbInjury && !ac.emergency && isAirborne(ac)) {
      ac.flags.turbInjury = 0;
      declareEmergency(w, ac, 'turbulence');
    }
    // mechanical stop on a taxiway clears after the tug arrives
    if (ac.flags.mechUntil && s.t >= ac.flags.mechUntil && ac.emergency && !ac.emergency.resolved && ac.emergency.kind === 'disabled_taxiway') {
      ac.flags.mechUntil = 0;
      ac.emergency.resolved = s.t;
      ac.holdPos = false;
      s.stats.emergenciesHandled++;
      s.stats.emergencyRespSum += s.t - ac.emergency.since;
      clearRequest(ac, 'emergency');
      radioPilot(w, ac, `${ap.facility} Ground, ${csay(ac)}, problem resolved, ready to continue taxi.`);
      logEvent(w, 'emergency', 'info', `${ac.callsign} mechanical problem resolved`, [ac]);
    }
    // an engine-failure / medical emergency made to wait is a failure of priority handling
    if (ac.emergency && !ac.emergency.resolved && isAirborne(ac) && s.t - ac.emergency.since > 900 && !ac.flags.emLate) {
      ac.flags.emLate = 1;
      s.stats.safetyPenalty += 6;
      logEvent(w, 'emergency', 'warning', `${ac.callsign} has been airborne with an emergency for 15 minutes – priority handling required`, [ac]);
    }
    if (isAirborne(ac) && ac.alt <= 0 && ac.phase !== 'final') crash(w, ac, 'impacted terrain');
    else if (ac.phase === 'final' && ac.alt <= 1 && ac.emergency?.kind === 'dual_engine_failure' && dist(ac.x, ac.y, 0, 0) > 4 * NM) crash(w, ac, 'landed short of the airport');
  }
}

export function crash(w: World, ac: Aircraft, why: string) {
  const { s } = w;
  if (ac.phase === 'crashed') return;
  ac.phase = 'crashed';
  ac.gs = 0; ac.vs = 0; ac.alt = 0;
  clearRequest(ac);
  s.stats.collisions++;
  s.stats.safetyPenalty += 60;
  if (ac.emergency && !ac.emergency.resolved) { ac.emergency.resolved = s.t; s.stats.emergenciesFailed++; }
  logEvent(w, 'collision', 'critical', `ACCIDENT: ${ac.callsign} ${why}`, [ac]);
  if (s.cfg.difficulty.collisionEnds) { s.over = true; s.overReason = `Accident: ${ac.callsign} ${why}`; }
}
