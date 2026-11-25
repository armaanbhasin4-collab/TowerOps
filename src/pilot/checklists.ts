/**
 * Normal checklists and first-officer flows.
 *
 * Each item is verified against the real simulated state (the tick appears when the aircraft is
 * actually configured, not when you click the item). The same list drives the first officer: when
 * "FO runs the flows" is on, the FO works through the unsatisfied items one at a time.
 *
 * The procedures are generic and abbreviated – written to teach the order and logic of a normal
 * flight. They are not any operator's or manufacturer's approved checklist.
 */
import { FT } from '../sim/util';
import { ACDEF } from './aircraft';
import { bestMixture, getControl, indicatedAlt, isJet, takeoffTrim } from './systems';
import { nearestAirport } from './world';
import type { Checklist, ChecklistItem, PilotState, Phase } from './types';

const TRANSITION = 18000;
type Extra = Partial<ChecklistItem>;
const sw = (ctl: string, label: string, expect: string, v: number, extra: Extra = {}): ChecklistItem => ({ id: ctl + v, label, expect, ok: (p) => getControl(p, ctl) === v, set: [[ctl, v]], ctl, ...extra });
const chk = (id: string, label: string, expect: string, ok: (p: PilotState) => boolean, extra: Extra = {}): ChecklistItem => ({ id, label, expect, ok, ...extra });

const qnhHere = (p: PilotState) => p.airports[nearestAirport(p, p.ac.x, p.ac.y)].qnh;
const altFt = (p: PilotState) => p.ac.z / FT;
const baroOk = (p: PilotState) => (altFt(p) > TRANSITION ? p.radios.std : !p.radios.std && Math.abs(p.radios.baro - qnhHere(p)) < 1.5);
const baroItem = (): ChecklistItem => chk('baro', 'Altimeter', 'SET (QNH / STD above 18,000)', baroOk, { set: (p) => (altFt(p) > TRANSITION ? [['baroStd', 1]] : [['baroQnh', 1]]), ctl: 'baro' });
const trimItem = (): ChecklistItem => chk('trim', 'Stabiliser trim', 'TAKEOFF (green band)', (p) => Math.abs(p.ac.trim - takeoffTrim(p)) < 0.12, { set: (p) => [['trim', takeoffTrim(p)]], ctl: 'trim' });
const airborne = (p: PilotState) => !p.ac.onGround;

const JET: Checklist[] = [
  {
    id: 'preflight', title: 'Power-up & preflight', phase: ['preflight'],
    items: [
      sw('parkBrake', 'Parking brake', 'SET', 1),
      sw('batt', 'Battery', 'ON', 1),
      chk('power', 'Electrical power', 'ESTABLISHED (GRD PWR or APU)', (p) => p.sys.source === 'ext' || p.sys.source === 'apu' || p.sys.source === 'gen', { set: [['gpu', 1]], ctl: 'gpu' }),
      sw('ltNav', 'Position lights', 'ON', 1),
      sw('irsL', 'IRS left', 'NAV', 1),
      sw('irsR', 'IRS right', 'NAV', 1),
      sw('emerLights', 'Emergency exit lights', 'ARMED', 1),
      sw('seatBelts', 'Seat belt signs', 'ON', 2),
      sw('windowHeat', 'Window heat', 'ON', 1),
      sw('yawDamper', 'Yaw damper', 'ON', 1),
      chk('apuRun', 'APU', 'START, then RUNNING', (p) => p.sys.apuRunning, { set: (p) => (p.flags.apuStart ? [] : [['apu', 2]]), ctl: 'apu' }),
      sw('apuGen', 'APU generator', 'ON', 1, { when: (p) => p.sys.apuRunning }),
      sw('gpu', 'Ground power', 'OFF (disconnect)', 0, { when: (p) => p.sys.apuRunning && !!p.sw.apuGen }),
      sw('bleedApu', 'APU bleed', 'ON', 1, { when: (p) => p.sys.apuRunning }),
      sw('fd', 'Flight director', 'ON', 1),
      baroItem(),
      chk('align', 'IRS alignment', 'COMPLETE', (p) => p.sys.align >= 1, { ctl: 'irsL' }),
    ],
  },
  {
    id: 'before_start', title: 'Before start', phase: ['before_start'],
    items: [
      chk('ifr', 'ATC clearance', 'OBTAINED', (p) => p.atc.clearedIfr, { ctl: 'atc' }),
      chk('squawk', 'Transponder code', 'SET', (p) => !p.atc.squawk || p.radios.xpdr.code === p.atc.squawk, { set: (p) => [['squawk', p.atc.squawk]], when: (p) => p.atc.clearedIfr, ctl: 'squawk' }),
      chk('mcpAlt', 'MCP altitude', 'CLEARED ALTITUDE', (p) => !p.atc.alt || p.ap.selAlt === p.atc.alt, { set: (p) => [['selAlt', p.atc.alt]], when: (p) => p.atc.clearedIfr, ctl: 'selAlt' }),
      chk('mcpSpd', 'MCP speed', 'V2', (p) => Math.abs(p.ap.selSpd - p.vspeeds.v2) <= 2, { set: (p) => [['selSpd', p.vspeeds.v2]], ctl: 'selSpd' }),
      chk('mcpHdg', 'MCP heading', 'RUNWAY HEADING', (p) => Math.abs(((p.ap.selHdg - Math.round(p.depRwy.hdg) + 540) % 360) - 180) <= 2, { set: (p) => [['selHdg', Math.round(p.depRwy.hdg)]], ctl: 'selHdg' }),
      sw('pumpL', 'Fuel pumps left', 'ON', 1),
      sw('pumpR', 'Fuel pumps right', 'ON', 1),
      sw('hydElec1', 'Electric hydraulic pump 1', 'ON', 1),
      sw('hydElec2', 'Electric hydraulic pump 2', 'ON', 1),
      sw('packL', 'Pack left', 'OFF for start', 0),
      sw('packR', 'Pack right', 'OFF for start', 0),
      sw('ltBeacon', 'Anti-collision light', 'ON', 1),
      trimItem(),
      chk('pushClr', 'Pushback clearance', 'OBTAINED', (p) => p.atc.clearedPush || !!p.flags.pushed || !p.push, { ctl: 'atc' }),
    ],
  },
  {
    id: 'start', title: 'Pushback & engine start', phase: ['pushback', 'engine_start'],
    items: [
      chk('pbRel', 'Parking brake', 'RELEASED for pushback', (p) => !p.push || p.push.s > 0 || !p.ac.parkBrake, { set: [['parkBrake', 0]], when: (p) => p.atc.clearedPush, ctl: 'parkBrake' }),
      chk('s2', 'Engine 2 start switch', 'GRD', (p) => p.eng[1].running || !!p.flags.lit1 || p.sw.start2 === 1, { set: [['start2', 1]], ctl: 'start2' }),
      chk('f2', 'Engine 2 fuel lever', 'IDLE at 25% N2', (p) => p.sw.fuelLever2 === 1, { set: [['fuelLever2', 1]], when: (p) => p.eng[1].n2 >= 24, ctl: 'fuelLever2' }),
      chk('r2', 'Engine 2', 'STABLE AT IDLE', (p) => p.eng[1].running, { ctl: 'fuelLever2' }),
      chk('s1', 'Engine 1 start switch', 'GRD', (p) => p.eng[0].running || !!p.flags.lit0 || p.sw.start1 === 1, { set: [['start1', 1]], when: (p) => p.eng[1].running, ctl: 'start1' }),
      chk('f1', 'Engine 1 fuel lever', 'IDLE at 25% N2', (p) => p.sw.fuelLever1 === 1, { set: [['fuelLever1', 1]], when: (p) => p.eng[0].n2 >= 24, ctl: 'fuelLever1' }),
      chk('r1', 'Engine 1', 'STABLE AT IDLE', (p) => p.eng[0].running, { ctl: 'fuelLever1' }),
      chk('pbSet', 'Pushback complete – parking brake', 'SET', (p) => !p.push || (p.push.done && (p.ac.parkBrake || p.ac.gs > 0.5 || p.atc.clearedTaxi)), { set: [['parkBrake', 1]], when: (p) => !!p.push?.done, ctl: 'parkBrake' }),
    ],
  },
  {
    id: 'after_start', title: 'After start', phase: ['engine_start', 'taxi_out'],
    items: [
      sw('gen1', 'Generator 1', 'ON', 1, { when: (p) => p.eng[0].running }),
      sw('gen2', 'Generator 2', 'ON', 1, { when: (p) => p.eng[1].running }),
      sw('bleedApu', 'APU bleed', 'OFF', 0, { when: (p) => p.eng[0].running && p.eng[1].running }),
      sw('apu', 'APU', 'OFF', 0, { when: (p) => !!p.sw.gen1 && !!p.sw.gen2 && p.eng[0].running && p.eng[1].running }),
      sw('packL', 'Pack left', 'AUTO', 1, { when: (p) => p.eng[0].running && p.eng[1].running }),
      sw('packR', 'Pack right', 'AUTO', 1, { when: (p) => p.eng[0].running && p.eng[1].running }),
      sw('probeHeat', 'Probe heat', 'ON', 1),
      chk('toFlaps', 'Flaps', 'SET FOR TAKEOFF (5)', (p) => ACDEF.jet.toFlaps.includes(p.ac.flapIdx), { set: [['flaps', 2]], ctl: 'flaps' }),
      sw('autobrake', 'Autobrake', 'RTO', 0),
      chk('taxiClr', 'Taxi clearance', 'OBTAINED', (p) => p.atc.clearedTaxi, { ctl: 'atc' }),
      sw('ltTaxi', 'Taxi light', 'ON', 1, { when: (p) => p.atc.clearedTaxi }),
    ],
  },
  {
    id: 'before_takeoff', title: 'Before takeoff', phase: ['taxi_out', 'before_takeoff'],
    items: [
      chk('toFlaps', 'Flaps', 'TAKEOFF SETTING', (p) => ACDEF.jet.toFlaps.includes(p.ac.flapIdx) && Math.abs(p.ac.flaps - p.ac.flapIdx) < 0.05, { set: [['flaps', 2]], ctl: 'flaps' }),
      trimItem(),
      chk('sbDown', 'Speedbrake', 'DOWN', (p) => p.ac.spoilerLever < 0.02, { set: [['spoiler', 0]], ctl: 'spoiler' }),
      chk('toClr', 'Line-up / takeoff clearance', 'RECEIVED', (p) => p.atc.clearedLineup || p.atc.clearedTakeoff, { ctl: 'atc' }),
      sw('ltStrobe', 'Strobe lights', 'ON entering the runway', 1, { when: (p) => p.atc.clearedLineup || p.atc.clearedTakeoff }),
      sw('ltLanding', 'Landing lights', 'ON', 1, { when: (p) => p.atc.clearedLineup || p.atc.clearedTakeoff }),
      sw('xpdr', 'Transponder', 'TA/RA', 2, { when: (p) => p.atc.clearedLineup || p.atc.clearedTakeoff }),
    ],
  },
  {
    id: 'after_takeoff', title: 'After takeoff & climb', phase: ['takeoff', 'climb', 'cruise'],
    items: [
      chk('gearUp', 'Landing gear', 'UP (positive rate)', (p) => !airborne(p) || !p.ac.gearLever, { set: [['gear', 0]], when: (p) => airborne(p) && p.ac.vs > 1 && p.ac.agl > 15, ctl: 'gear' }),
      chk('flapsUp', 'Flaps', 'UP on schedule', (p) => !airborne(p) || p.ac.agl < 900 || p.ac.flapIdx === 0, { ctl: 'flaps', info: true }),
      sw('autobrake', 'Autobrake', 'OFF', 1, { when: (p) => airborne(p) && p.ac.agl > 300 }),
      sw('ltTaxi', 'Taxi light', 'OFF', 0, { when: airborne }),
      chk('ll10', 'Landing lights', 'OFF above 10,000 ft', (p) => altFt(p) < 10500 || !p.sw.ltLanding, { set: [['ltLanding', 0]], when: (p) => altFt(p) > 10200, ctl: 'ltLanding' }),
      chk('std', 'Altimeters', 'STD above 18,000 ft', (p) => altFt(p) < TRANSITION + 300 || p.radios.std, { set: [['baroStd', 1]], when: (p) => altFt(p) > TRANSITION, ctl: 'baro' }),
      chk('belts', 'Seat belt signs', 'AUTO in cruise', (p) => p.phase !== 'cruise' || p.sw.seatBelts === 1, { set: [['seatBelts', 1]], when: (p) => p.phase === 'cruise', ctl: 'seatBelts', info: true }),
    ],
  },
  {
    id: 'approach', title: 'Descent & approach', phase: ['descent', 'approach'],
    items: [
      baroItem(),
      chk('ils', 'ILS frequency', 'TUNED & IDENTIFIED', (p) => Math.abs(p.radios.nav.act - p.arrRwy.ilsFreq) < 0.011, { set: (p) => [['nav', p.arrRwy.ilsFreq], ['crs', Math.round(p.arrRwy.hdg)]], ctl: 'nav' }),
      chk('ab', 'Autobrake', 'SET (2 or 3)', (p) => (p.sw.autobrake ?? 1) >= 2, { set: [['autobrake', 3]], ctl: 'autobrake' }),
      sw('seatBelts', 'Seat belt signs', 'ON', 2),
      chk('ll', 'Landing lights', 'ON below 10,000 ft', (p) => altFt(p) > 10000 || !!p.sw.ltLanding, { set: [['ltLanding', 1]], when: (p) => altFt(p) < 10000, ctl: 'ltLanding' }),
      chk('appClr', 'Approach clearance', 'RECEIVED', (p) => p.atc.clearedApproach, { ctl: 'atc' }),
    ],
  },
  {
    id: 'landing', title: 'Landing', phase: ['approach', 'landing'],
    items: [
      chk('gearDn', 'Landing gear', 'DOWN, 3 GREEN', (p) => p.ac.gear > 0.99, { set: [['gear', 1]], when: (p) => p.flags.gearDue === 1, ctl: 'gear' }),
      chk('ldgFlaps', 'Flaps', '30', (p) => p.ac.flapIdx >= ACDEF.jet.ldgFlap && Math.abs(p.ac.flaps - p.ac.flapIdx) < 0.05, { ctl: 'flaps' }),
      chk('sbArm', 'Speedbrake', 'ARMED', (p) => p.ac.spoilerArmed || p.ac.onGround, { set: [['spoilerArm', 1]], when: (p) => p.ac.gear > 0.5, ctl: 'spoilerArm' }),
      chk('ldgClr', 'Landing clearance', 'RECEIVED', (p) => p.atc.clearedLand, { ctl: 'atc' }),
    ],
  },
  {
    id: 'after_landing', title: 'After landing', phase: ['taxi_in'],
    items: [
      chk('sbDown', 'Speedbrake', 'DOWN', (p) => p.ac.spoilerLever < 0.02, { set: [['spoiler', 0]], ctl: 'spoiler' }),
      sw('flaps', 'Flaps', 'UP', 0),
      sw('ltStrobe', 'Strobe lights', 'OFF', 0),
      sw('ltLanding', 'Landing lights', 'OFF', 0),
      sw('ltTaxi', 'Taxi light', 'ON', 1),
      sw('autobrake', 'Autobrake', 'OFF', 1),
      sw('probeHeat', 'Probe heat', 'OFF', 0),
      chk('apuRun', 'APU', 'START', (p) => p.sys.apuRunning || !!p.flags.apuStart, { set: [['apu', 2]], ctl: 'apu' }),
      sw('xpdr', 'Transponder', 'ALT (TCAS off)', 1),
    ],
  },
  {
    id: 'shutdown', title: 'Parking & shutdown', phase: ['shutdown'],
    items: [
      sw('parkBrake', 'Parking brake', 'SET', 1),
      sw('apuGen', 'APU generator', 'ON', 1, { when: (p) => p.sys.apuRunning }),
      sw('fuelLever1', 'Engine 1 fuel lever', 'CUTOFF', 0, { when: (p) => p.sys.apuRunning && !!p.sw.apuGen }),
      sw('fuelLever2', 'Engine 2 fuel lever', 'CUTOFF', 0, { when: (p) => p.sys.apuRunning && !!p.sw.apuGen }),
      sw('seatBelts', 'Seat belt signs', 'OFF', 0, { when: (p) => !p.eng[0].running && !p.eng[1].running }),
      sw('ltBeacon', 'Anti-collision light', 'OFF (engines stopped)', 0, { when: (p) => p.eng[0].n2 < 20 && p.eng[1].n2 < 20 }),
      sw('ltTaxi', 'Taxi light', 'OFF', 0),
      sw('pumpL', 'Fuel pumps left', 'OFF', 0),
      sw('pumpR', 'Fuel pumps right', 'OFF', 0),
      sw('hydElec1', 'Electric hydraulic pump 1', 'OFF', 0),
      sw('hydElec2', 'Electric hydraulic pump 2', 'OFF', 0),
      sw('windowHeat', 'Window heat', 'OFF', 0),
      sw('xpdr', 'Transponder', 'STBY', 0),
      sw('irsL', 'IRS left', 'OFF', 0),
      sw('irsR', 'IRS right', 'OFF', 0),
    ],
  },
];

const mixOk = (p: PilotState) => (altFt(p) - p.airports[0].elev / FT < 3000 ? p.ac.mixture > 0.9 : Math.abs(p.ac.mixture - bestMixture(altFt(p))) < 0.17);

const C172: Checklist[] = [
  {
    id: 'preflight', title: 'Before starting engine', phase: ['preflight', 'before_start'],
    items: [
      sw('parkBrake', 'Parking brake', 'SET', 1),
      sw('fuelSel', 'Fuel selector', 'BOTH', 1),
      sw('fuelShutoff', 'Fuel shut-off valve', 'ON (in)', 1),
      sw('avionics', 'Avionics switch', 'OFF for start', 0, { ok: (p) => p.eng[0].running || p.sw.avionics === 0 } as Extra),
      sw('batt', 'Master battery', 'ON', 1),
      sw('alt', 'Master alternator', 'ON', 1),
      sw('ltBeacon', 'Beacon', 'ON', 1),
      chk('thr', 'Throttle', 'OPEN ¼ INCH', (p) => p.eng[0].running || (p.ac.throttle[0] > 0.03 && p.ac.throttle[0] < 0.3), { set: [['throttle', 0.1]], ctl: 'throttle' }),
      chk('mixRich', 'Mixture', 'RICH', (p) => p.eng[0].running || p.ac.mixture > 0.9, { set: [['mixture', 1]], ctl: 'mixture' }),
      chk('prime', 'Fuel pump', 'ON to prime (3 seconds)', (p) => p.eng[0].running || (p.flags.primed ?? 0) >= 2, { set: [['pumpAux', 1]], ctl: 'pumpAux' }),
    ],
  },
  {
    id: 'start', title: 'Engine start', phase: ['before_start', 'engine_start'],
    items: [
      chk('crank', 'Propeller area clear – magnetos', 'START, release to BOTH', (p) => p.eng[0].running, { set: [['magnetos', 4]], when: (p) => (p.flags.primed ?? 0) >= 2 && (p.flags.crank ?? 0) <= 0, ctl: 'magnetos' }),
      chk('oil', 'Oil pressure', 'GREEN within 30 s', (p) => p.eng[0].running && p.eng[0].oilP > 25),
      chk('idle', 'Throttle', '1000 RPM', (p) => p.eng[0].running && p.eng[0].rpm > 780 && p.eng[0].rpm < 1250, { set: [['throttle', 0.07]], when: (p) => p.eng[0].running, ctl: 'throttle' }),
      sw('pumpAux', 'Fuel pump', 'OFF', 0, { when: (p) => p.eng[0].running }),
      sw('avionics', 'Avionics switch', 'ON', 1, { when: (p) => p.eng[0].running }),
      sw('flaps', 'Flaps', 'UP', 0),
      baroItem(),
      sw('xpdr', 'Transponder', 'ALT', 1, { when: (p) => p.sys.avionics }),
      chk('taxiClr', 'Taxi clearance', 'OBTAINED', (p) => p.atc.clearedTaxi, { ctl: 'atc' }),
    ],
  },
  {
    id: 'runup', title: 'Run-up & before takeoff', phase: ['taxi_out', 'before_takeoff'],
    items: [
      chk('mags', 'Magneto check at 1800 RPM', 'L and R checked, back to BOTH', (p) => !!p.flags.magL && !!p.flags.magR && p.sw.magnetos === 3, { set: (p) => { p.flags.magL = 1; p.flags.magR = 1; return [['magnetos', 3]]; }, when: (p) => p.ac.gs < 0.5 && p.phase === 'before_takeoff', ctl: 'magnetos' }),
      chk('toFlaps', 'Flaps', '0–10°', (p) => p.ac.flapIdx <= 1, { set: [['flaps', 0]], ctl: 'flaps' }),
      trimItem(),
      chk('mixRich', 'Mixture', 'RICH', (p) => p.ac.mixture > 0.9, { set: [['mixture', 1]], ctl: 'mixture' }),
      sw('pumpAux', 'Fuel pump', 'ON', 1, { when: (p) => p.phase === 'before_takeoff' }),
      sw('ltLanding', 'Landing light', 'ON', 1, { when: (p) => p.phase === 'before_takeoff' }),
      sw('ltStrobe', 'Strobes', 'ON', 1, { when: (p) => p.phase === 'before_takeoff' }),
      chk('toClr', 'Takeoff clearance', 'RECEIVED', (p) => p.atc.clearedTakeoff || p.atc.clearedLineup, { ctl: 'atc' }),
    ],
  },
  {
    id: 'climb', title: 'Climb & cruise', phase: ['takeoff', 'climb', 'cruise'],
    items: [
      chk('flapsUp', 'Flaps', 'UP above 300 ft', (p) => !airborne(p) || p.ac.agl < 120 || p.ac.flapIdx === 0, { set: [['flaps', 0]], when: (p) => airborne(p) && p.ac.agl > 100 && p.ac.ias > 62, ctl: 'flaps' }),
      chk('pumpOff', 'Fuel pump', 'OFF above 1000 ft AGL', (p) => !airborne(p) || p.ac.agl < 340 || !p.sw.pumpAux, { set: [['pumpAux', 0]], when: (p) => p.ac.agl > 320, ctl: 'pumpAux' }),
      chk('lean', 'Mixture', 'LEAN above 3000 ft', (p) => !airborne(p) || mixOk(p), { set: (p) => [['mixture', altFt(p) - p.airports[0].elev / FT < 3000 ? 1 : bestMixture(altFt(p))]], when: (p) => p.phase === 'cruise' || altFt(p) > 4000, ctl: 'mixture' }),
      chk('trimCruise', 'Trim', 'ADJUST for cruise', () => true, { info: true, ctl: 'trim' }),
    ],
  },
  {
    id: 'approach', title: 'Descent & before landing', phase: ['descent', 'approach', 'landing'],
    items: [
      baroItem(),
      sw('fuelSel', 'Fuel selector', 'BOTH', 1),
      chk('mixRich', 'Mixture', 'RICH below 3000 ft', (p) => p.ac.agl / FT > 3000 || p.ac.mixture > 0.9, { set: [['mixture', 1]], when: (p) => p.ac.agl / FT < 3000, ctl: 'mixture' }),
      sw('pumpAux', 'Fuel pump', 'ON', 1, { when: (p) => p.phase !== 'descent' }),
      sw('ltLanding', 'Landing light', 'ON', 1),
      chk('ldgFlaps', 'Flaps', 'AS REQUIRED (20°–FULL on final)', (p) => p.phase !== 'landing' || p.ac.flapIdx >= 2, { ctl: 'flaps' }),
      chk('ldgClr', 'Landing clearance', 'RECEIVED', (p) => p.atc.clearedLand, { ctl: 'atc' }),
    ],
  },
  {
    id: 'after_landing', title: 'After landing', phase: ['taxi_in'],
    items: [
      sw('flaps', 'Flaps', 'UP', 0),
      sw('pumpAux', 'Fuel pump', 'OFF', 0),
      sw('ltStrobe', 'Strobes', 'OFF', 0),
      sw('ltLanding', 'Landing light', 'OFF', 0),
      sw('ltTaxi', 'Taxi light', 'ON', 1),
    ],
  },
  {
    id: 'shutdown', title: 'Securing the aircraft', phase: ['shutdown'],
    items: [
      sw('parkBrake', 'Parking brake', 'SET', 1),
      chk('thrIdle', 'Throttle', 'IDLE', (p) => p.ac.throttle[0] < 0.12, { set: [['throttle', 0.03]], ctl: 'throttle' }),
      sw('avionics', 'Avionics switch', 'OFF', 0),
      chk('cut', 'Mixture', 'IDLE CUT-OFF', (p) => p.ac.mixture < 0.05, { set: [['mixture', 0]], ctl: 'mixture' }),
      sw('magnetos', 'Magnetos', 'OFF (engine stopped)', 0, { when: (p) => !p.eng[0].running && p.eng[0].rpm < 100 }),
      sw('ltTaxi', 'Taxi light', 'OFF', 0),
      sw('ltBeacon', 'Beacon', 'OFF', 0, { when: (p) => !p.eng[0].running }),
      sw('alt', 'Master alternator', 'OFF', 0, { when: (p) => p.sw.magnetos === 0 }),
      sw('batt', 'Master battery', 'OFF', 0, { when: (p) => p.sw.magnetos === 0 && !p.sw.ltBeacon }),
    ],
  },
];

export const CHECKLISTS = { jet: JET, c172: C172 };

export const checklistsFor = (p: PilotState): Checklist[] => CHECKLISTS[p.cfg.aircraft];
export const activeChecklists = (p: PilotState, phase: Phase = p.phase): Checklist[] => checklistsFor(p).filter((c) => c.phase.includes(phase));

/** first item of the active checklists that is not yet satisfied */
export function nextItem(p: PilotState): { list: Checklist; item: ChecklistItem } | null {
  for (const list of activeChecklists(p)) {
    for (const item of list.items) if (!item.info && !item.ok(p)) return { list, item };
  }
  return null;
}

/** checklist ids that must be complete when the given phase begins (used for the debrief) */
export const GATES: Record<'jet' | 'c172', Partial<Record<Phase, string[]>>> = {
  jet: { pushback: ['preflight', 'before_start'], taxi_out: ['start'], takeoff: ['after_start', 'before_takeoff'], landing: ['approach', 'landing'], complete: ['shutdown'] },
  c172: { taxi_out: ['preflight', 'start'], takeoff: ['runup'], landing: ['approach'], complete: ['shutdown'] },
};

export const missedItems = (p: PilotState, listId: string): ChecklistItem[] => {
  const list = checklistsFor(p).find((c) => c.id === listId);
  return list ? list.items.filter((i) => !i.info && !i.ok(p)) : [];
};

const KNOWN_READ = new Set(['flaps', 'gear', 'parkBrake', 'spoilerArm', 'spoiler', 'reverse', 'throttle', 'mixture', 'xpdr', 'fd', 'at', 'baroStd']);

/** first-officer flow: queue the control actions for unsatisfied items of the active checklists */
export function foFlow(p: PilotState): void {
  if (p.foQueue.length) return;
  for (const list of activeChecklists(p)) {
    for (const item of list.items) {
      if (item.ok(p) || !item.set || item.pilotOnly) continue;
      if (item.when && !item.when(p)) continue;
      const acts = (typeof item.set === 'function' ? item.set(p) : item.set).filter(([id, v]) => KNOWN_READ.has(id) || p.sw[id] !== undefined ? getControl(p, id) !== v : true);
      if (!acts.length) continue;
      acts.forEach(([id, v], i) => p.foQueue.push({ id, v, say: i === 0 ? `${item.label} – ${item.expect.toLowerCase()}` : undefined }));
      return; // one item at a time, in order
    }
  }
}

export const isJetList = isJet;
void indicatedAlt;
