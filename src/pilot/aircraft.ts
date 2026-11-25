/**
 * Aircraft performance data and cockpit control definitions for the two flyable types.
 *
 * HONESTY NOTE: these are GENERIC approximations built from public, rounded figures
 * (a Cessna 172S-class piston trainer and a Boeing 737-800-class twin jet). They are tuned to give
 * believable speeds, climb rates and handling for procedure familiarisation. They are NOT derived
 * from manufacturer data and must not be used as a reference for any real aircraft.
 */
import type { AcKind, ControlDef } from './types';

export interface FlapDetent {
  label: string;
  /** added to CLmax */
  dCL: number;
  dCD: number;
  /** max speed with this flap, kt */
  vfe: number;
}

export interface AcDef {
  kind: AcKind;
  name: string;
  short: string;
  span: number;
  length: number;
  /** pilot eye position relative to the reference point (ground under the main gear) */
  eye: { fwd: number; up: number };
  S: number; // wing area m²
  oew: number; // kg
  mtow: number;
  mlw: number;
  payload: number;
  fuelCap: number; // kg
  CL0: number;
  CLa: number; // per degree
  CLmax: number; // clean
  CD0: number;
  k: number; // induced drag factor
  CDgear: number;
  retract: boolean;
  flaps: FlapDetent[];
  /** flap detents that are legal for takeoff */
  toFlaps: number[];
  /** normal landing flap detent */
  ldgFlap: number;
  engines: number;
  /** jet: static thrust per engine, N. piston: max shaft power, W */
  thrust: number;
  power: number;
  /** short-period natural frequency rad/s and damping */
  wn: number;
  zeta: number;
  /** max roll rate deg/s at full aileron, cruise */
  rollRate: number;
  /** dihedral (wings-levelling) tendency, 1/s */
  dihedral: number;
  vmo: number; // kt
  mmo: number;
  /** gear limit speed kt */
  vle: number;
  wheelbase: number;
  /** max nose-wheel steering angle at walking pace, deg */
  steer: number;
  brakeMu: number;
  /** pitch at which the tail touches the ground, deg */
  tailStrike: number;
  /** max bank on the ground before a wingtip / pod strike, deg */
  wingStrike: number;
  cruiseKt: number; // typical cruise IAS (c172) or used below crossover (jet)
  cruiseMach: number;
  climbKt: number;
  ceiling: number; // ft
  rangeNm: number;
  /** touchdown limits, fpm */
  hardFpm: number;
  crashFpm: number;
  taxiKt: number;
  /** typical pattern / initial approach speeds */
  vy: number;
  glideKt: number;
}

export const ACDEF: Record<AcKind, AcDef> = {
  c172: {
    kind: 'c172', name: 'Single-engine piston trainer (Cessna 172S class, glass cockpit)', short: 'C172',
    span: 11, length: 8.3, eye: { fwd: 0.6, up: 1.55 },
    S: 16.2, oew: 780, mtow: 1157, mlw: 1157, payload: 170, fuelCap: 144,
    CL0: 0.3, CLa: 0.08, CLmax: 1.54, CD0: 0.028, k: 0.0566, CDgear: 0, retract: false,
    flaps: [
      { label: 'UP', dCL: 0, dCD: 0, vfe: 163 },
      { label: '10°', dCL: 0.2, dCD: 0.01, vfe: 110 },
      { label: '20°', dCL: 0.33, dCD: 0.025, vfe: 85 },
      { label: 'FULL', dCL: 0.42, dCD: 0.045, vfe: 85 },
    ],
    toFlaps: [0, 1], ldgFlap: 3,
    engines: 1, thrust: 2150, power: 134000,
    wn: 3.2, zeta: 0.75, rollRate: 55, dihedral: 0.05,
    vmo: 163, mmo: 1, vle: 999, wheelbase: 1.65, steer: 32, brakeMu: 0.38,
    tailStrike: 14, wingStrike: 18,
    cruiseKt: 115, cruiseMach: 0, climbKt: 76, ceiling: 13000, rangeNm: 520,
    hardFpm: 500, crashFpm: 950, taxiKt: 15, vy: 74, glideKt: 68,
  },
  jet: {
    kind: 'jet', name: 'Twin-jet airliner (Boeing 737-800 class, generic)', short: 'B738',
    span: 35.8, length: 39.5, eye: { fwd: 16.5, up: 5.2 },
    S: 124.6, oew: 41400, mtow: 79000, mlw: 66400, payload: 14500, fuelCap: 20800,
    CL0: 0.2, CLa: 0.095, CLmax: 1.36, CD0: 0.019, k: 0.042, CDgear: 0.02, retract: true,
    flaps: [
      { label: 'UP', dCL: 0, dCD: 0, vfe: 340 },
      { label: '1', dCL: 0.35, dCD: 0.008, vfe: 250 },
      { label: '5', dCL: 0.6, dCD: 0.015, vfe: 250 },
      { label: '15', dCL: 0.9, dCD: 0.035, vfe: 200 },
      { label: '30', dCL: 1.15, dCD: 0.065, vfe: 175 },
      { label: '40', dCL: 1.25, dCD: 0.085, vfe: 162 },
    ],
    toFlaps: [1, 2, 3], ldgFlap: 4,
    engines: 2, thrust: 112000, power: 0,
    wn: 1.7, zeta: 0.8, rollRate: 22, dihedral: 0,
    vmo: 340, mmo: 0.82, vle: 270, wheelbase: 15.6, steer: 70, brakeMu: 0.42,
    tailStrike: 11, wingStrike: 12,
    cruiseKt: 280, cruiseMach: 0.78, climbKt: 280, ceiling: 41000, rangeNm: 2900,
    hardFpm: 600, crashFpm: 1100, taxiKt: 25, vy: 250, glideKt: 220,
  },
};

const T = ['OFF', 'ON'];
const sw = (id: string, label: string, section: string, help: string, pos = T, extra: Partial<ControlDef> = {}): ControlDef => ({ id, label, section, panel: 'overhead', pos, help, ...extra });

const JET_CONTROLS: ControlDef[] = [
  sw('batt', 'BATTERY', 'Electrical', 'Connects the battery. First switch on, last switch off. Battery alone powers only essentials and drains in about 30 minutes.'),
  sw('gpu', 'GRD POWER', 'Electrical', 'Connects ground power while parked at the gate (available until pushback).'),
  sw('apuGen', 'APU GEN', 'Electrical', 'Puts the APU generator on the buses once the APU is running.'),
  sw('gen1', 'GEN 1', 'Electrical', 'Engine 1 generator. Select ON after engine start.'),
  sw('gen2', 'GEN 2', 'Electrical', 'Engine 2 generator. Select ON after engine start.'),
  sw('apu', 'APU', 'APU', 'Auxiliary power unit. Hold START (click START) to begin the start; it runs in ON. Provides electrics and bleed air for engine start.', ['OFF', 'ON', 'START']),
  sw('pumpL', 'FUEL PUMPS L', 'Fuel', 'Left main tank boost pumps. ON before engine start.'),
  sw('pumpR', 'FUEL PUMPS R', 'Fuel', 'Right main tank boost pumps. ON before engine start.'),
  sw('pumpC', 'CTR PUMPS', 'Fuel', 'Centre tank pumps. ON only when the centre tank holds fuel.'),
  sw('xfeed', 'CROSSFEED', 'Fuel', 'Opens the crossfeed valve. Normally closed.', ['CLOSE', 'OPEN']),
  sw('hydEng1', 'ENG 1 HYD', 'Hydraulics', 'Engine-driven hydraulic pump 1. Normally left ON.', T, { cold: 1 }),
  sw('hydEng2', 'ENG 2 HYD', 'Hydraulics', 'Engine-driven hydraulic pump 2. Normally left ON.', T, { cold: 1 }),
  sw('hydElec1', 'ELEC 1 HYD', 'Hydraulics', 'Electric hydraulic pump, system A. ON before pushback (brakes, steering).'),
  sw('hydElec2', 'ELEC 2 HYD', 'Hydraulics', 'Electric hydraulic pump, system B. ON before pushback.'),
  sw('bleedApu', 'APU BLEED', 'Air', 'Supplies APU bleed air to the duct. Required for engine start; OFF after start.'),
  sw('bleed1', 'ENG 1 BLEED', 'Air', 'Engine 1 bleed air.', T, { cold: 1 }),
  sw('bleed2', 'ENG 2 BLEED', 'Air', 'Engine 2 bleed air.', T, { cold: 1 }),
  sw('packL', 'PACK L', 'Air', 'Left air-conditioning pack. OFF for engine start, AUTO afterwards.', ['OFF', 'AUTO']),
  sw('packR', 'PACK R', 'Air', 'Right air-conditioning pack. OFF for engine start, AUTO afterwards.', ['OFF', 'AUTO']),
  sw('probeHeat', 'PROBE HEAT', 'Anti-ice', 'Pitot / static probe heat. ON before takeoff.'),
  sw('windowHeat', 'WINDOW HEAT', 'Anti-ice', 'Windshield heat. ON at least 10 minutes before takeoff.'),
  sw('antiIceEng', 'ENG ANTI-ICE', 'Anti-ice', 'Engine cowl anti-ice. ON in icing conditions (visible moisture at or below 10°C).'),
  sw('antiIceWing', 'WING ANTI-ICE', 'Anti-ice', 'Wing leading-edge anti-ice. As required in icing.'),
  sw('ltNav', 'POSITION', 'Lights', 'Navigation (position) lights. ON whenever the aircraft is powered.'),
  sw('ltBeacon', 'ANTI COLLISION', 'Lights', 'Red rotating beacon. ON before pushback / engine start, OFF after shutdown.'),
  sw('ltStrobe', 'STROBE', 'Lights', 'White strobes. ON when entering the runway, OFF when vacating.'),
  sw('ltTaxi', 'TAXI', 'Lights', 'Taxi light. ON when taxiing, OFF when holding.'),
  sw('ltRwy', 'RWY TURNOFF', 'Lights', 'Runway turn-off lights.'),
  sw('ltLanding', 'LANDING', 'Lights', 'Landing lights. ON when cleared for takeoff and below 10,000 ft.'),
  sw('ltLogo', 'LOGO', 'Lights', 'Logo lights (night).'),
  sw('ltWing', 'WING', 'Lights', 'Wing inspection lights.'),
  sw('seatBelts', 'SEAT BELTS', 'Cabin', 'Seat belt signs.', ['OFF', 'AUTO', 'ON']),
  sw('emerLights', 'EMER EXIT LIGHTS', 'Cabin', 'Emergency exit lights. ARMED for all flight.', ['OFF', 'ARMED'], { guard: true }),
  sw('irsL', 'IRS L', 'Navigation', 'Left inertial reference. NAV to align (aircraft must stay stationary; alignment is shortened to about 90 s in this sim).', ['OFF', 'NAV']),
  sw('irsR', 'IRS R', 'Navigation', 'Right inertial reference. NAV to align.', ['OFF', 'NAV']),
  sw('yawDamper', 'YAW DAMPER', 'Flight controls', 'Damps Dutch roll. ON for all flight.'),
  sw('start1', 'ENG 1 START', 'Engine start', 'GRD opens the start valve and motors engine 1 with bleed air. Releases to OFF automatically at starter cut-out.', ['OFF', 'GRD']),
  sw('start2', 'ENG 2 START', 'Engine start', 'GRD opens the start valve and motors engine 2 with bleed air.', ['OFF', 'GRD']),
  { id: 'fuelLever1', label: 'ENG 1 FUEL', section: 'Engine', panel: 'pedestal', pos: ['CUTOFF', 'IDLE'], help: 'Engine 1 start lever. IDLE at 25% N2 during the start; CUTOFF to shut the engine down.' },
  { id: 'fuelLever2', label: 'ENG 2 FUEL', section: 'Engine', panel: 'pedestal', pos: ['CUTOFF', 'IDLE'], help: 'Engine 2 start lever.' },
  { id: 'autobrake', label: 'AUTOBRAKE', section: 'Brakes', panel: 'pedestal', pos: ['RTO', 'OFF', '1', '2', '3', 'MAX'], help: 'RTO for takeoff (max braking if the takeoff is rejected). 1–MAX select landing deceleration.', cold: 1 },
];

const C172_CONTROLS: ControlDef[] = [
  sw('batt', 'MASTER BAT', 'Electrical', 'Battery master. Powers the electrical bus.'),
  sw('alt', 'MASTER ALT', 'Electrical', 'Alternator. ON with the battery; charges once the engine runs.'),
  sw('avionics', 'AVIONICS', 'Electrical', 'Avionics bus (displays, radios, transponder). ON after engine start, OFF before shutdown.'),
  sw('pumpAux', 'FUEL PUMP', 'Fuel', 'Electric auxiliary fuel pump. Used to prime before start; ON for takeoff and landing as a backup.'),
  sw('fuelSel', 'FUEL SELECTOR', 'Fuel', 'Tank selector. BOTH for takeoff and landing.', ['LEFT', 'BOTH', 'RIGHT'], { cold: 1 }),
  sw('fuelShutoff', 'FUEL SHUTOFF', 'Fuel', 'Fuel shut-off valve. ON (pushed in) for all normal operations.', ['OFF', 'ON'], { cold: 1 }),
  sw('magnetos', 'MAGNETOS', 'Engine', 'Ignition. OFF / R / L / BOTH / START. Click START to crank; it springs back to BOTH. Check L and R during the run-up (about 100 RPM drop each).', ['OFF', 'R', 'L', 'BOTH', 'START']),
  sw('ltBeacon', 'BEACON', 'Lights', 'Red beacon. ON before engine start.'),
  sw('ltNav', 'NAV', 'Lights', 'Navigation lights. ON at night.'),
  sw('ltStrobe', 'STROBE', 'Lights', 'Strobes. ON when entering the runway.'),
  sw('ltTaxi', 'TAXI', 'Lights', 'Taxi light.'),
  sw('ltLanding', 'LAND', 'Lights', 'Landing light. ON for takeoff and landing.'),
  sw('pitotHeat', 'PITOT HEAT', 'Anti-ice', 'Pitot heat. ON in visible moisture near freezing.'),
];

export const CONTROLS: Record<AcKind, ControlDef[]> = { jet: JET_CONTROLS, c172: C172_CONTROLS };

export function coldSwitches(kind: AcKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of CONTROLS[kind]) out[c.id] = c.cold ?? 0;
  return out;
}

/** density ratio, speed of sound and temperature for an altitude in metres (ISA) */
export function isa(z: number): { sigma: number; a: number; tempK: number; rho: number } {
  const h = Math.max(-500, z);
  let T: number, p: number;
  if (h < 11000) {
    T = 288.15 - 0.0065 * h;
    p = 101325 * Math.pow(T / 288.15, 5.2559);
  } else {
    T = 216.65;
    p = 22632 * Math.exp(-(h - 11000) / 6341.6);
  }
  const rho = p / (287.05 * T);
  return { sigma: rho / 1.225, a: Math.sqrt(1.4 * 287.05 * T), tempK: T, rho };
}

/** total flap effect at a (possibly fractional) flap position */
export function flapAt(def: AcDef, pos: number): { dCL: number; dCD: number } {
  const i = Math.max(0, Math.min(def.flaps.length - 1, Math.floor(pos)));
  const j = Math.min(def.flaps.length - 1, i + 1);
  const f = pos - i;
  return { dCL: def.flaps[i].dCL + (def.flaps[j].dCL - def.flaps[i].dCL) * f, dCD: def.flaps[i].dCD + (def.flaps[j].dCD - def.flaps[i].dCD) * f };
}

/** 1-g stall speed in kt IAS for a mass and flap position */
export function stallKt(def: AcDef, mass: number, flapPos: number): number {
  const cl = def.CLmax + flapAt(def, flapPos).dCL;
  return Math.sqrt((2 * mass * 9.80665) / (1.225 * def.S * cl)) / 0.514444;
}
