/**
 * Pilot-side ("flight deck") simulation types.
 *
 * Conventions (shared with the ATC engine): world x = east, y = north, metres. Headings are
 * degrees TRUE (magnetic variation is not modelled). Altitudes inside the engine are metres MSL
 * (`z`), displayed in feet. Speeds inside the engine are m/s, displayed in knots.
 */
import type { Airport } from '../sim/types';

export type AcKind = 'c172' | 'jet';
export type RealismPreset = 'study' | 'standard' | 'simplified' | 'casual';
/** where/in what state the flight begins */
export type StartState = 'cold' | 'ready' | 'running' | 'runway' | 'final';
export type FlightKind = 'route' | 'pattern' | 'approach';

export interface Assists {
  preset: RealismPreset | 'custom';
  start: StartState;
  /** first officer / instructor operates the switches and runs the flows */
  autoSystems: boolean;
  /** first officer handles radio calls and tuning */
  autoRadio: boolean;
  /** gear, flaps, spoilers and lights are managed automatically */
  autoConfig: boolean;
  /** automatic turn coordination and rudder on the ground roll */
  autoRudder: boolean;
  autoTrim: boolean;
  /** stall / overbank / overspeed protection */
  protection: boolean;
  /** coach hints, highlighted next control, taxi line and approach gates in the 3D view */
  guidance: boolean;
  /** hard landings and excursions are scored but do not end the flight */
  forgiving: boolean;
  /** radio frequencies must be tuned manually before ATC answers */
  strictRadio: boolean;
}

export interface PilotConfig {
  aircraft: AcKind;
  kind: FlightKind;
  depId: string;
  destId: string;
  assists: Assists;
  /** local time of day, hours 0..24 */
  hour: number;
  weather: 'clear' | 'breezy' | 'crosswind' | 'overcast' | 'lowvis';
  seed: number;
  callsign?: string;
}

export interface PlacedAirport {
  ap: Airport;
  /** world position of the airport's local origin */
  ox: number;
  oy: number;
  /** field elevation, metres */
  elev: number;
  lat: number;
  lon: number;
  /** altimeter setting hPa */
  qnh: number;
  wind: { dir: number; kt: number };
  freq: { atis: number; clearance: number; ground: number; tower: number; departure: number; approach: number };
}

export interface RunwayRef {
  apIdx: number;
  rwyId: string;
  endIdx: 0 | 1;
  name: string;
  /** landing / takeoff direction, deg true */
  hdg: number;
  /** threshold, world coords */
  thrX: number;
  thrY: number;
  length: number;
  width: number;
  /** threshold elevation, m */
  elev: number;
  ilsFreq: number;
  /** glidepath aim point distance past the threshold, m */
  aim: number;
}

export interface Wp {
  name: string;
  x: number;
  y: number;
  /** target altitude at the fix, ft MSL */
  alt?: number;
  /** speed target, kt IAS */
  spd?: number;
  kind: 'dep' | 'enroute' | 'arrival' | 'base' | 'final' | 'rwy' | 'pattern';
}

export interface EngState {
  /** piston: rpm; jet: unused */
  rpm: number;
  n1: number; // %
  n2: number; // %
  egt: number; // °C
  ff: number; // kg/h
  oilP: number; // psi
  oilT: number; // °C
  running: boolean;
  /** 0 = not starting; >0 seconds into the start sequence */
  starting: number;
  /** current thrust, N (negative in reverse) */
  thrust: number;
}

export interface AcState {
  x: number;
  y: number;
  /** wheel height MSL, m */
  z: number;
  /** height above ground, m */
  agl: number;
  /** true airspeed, m/s */
  tas: number;
  /** indicated airspeed, kt */
  ias: number;
  mach: number;
  /** ground speed m/s and ground track deg */
  gs: number;
  gtrk: number;
  /** vertical speed, m/s */
  vs: number;
  /** nose heading, air-mass track, pitch, bank, flight-path angle, angle of attack, sideslip: degrees */
  hdg: number;
  trk: number;
  pitch: number;
  bank: number;
  gamma: number;
  alpha: number;
  beta: number;
  /** pitch / roll rates deg/s */
  q: number;
  p: number;
  /** turn rate deg/s */
  r: number;
  onGround: boolean;
  /** load factor */
  g: number;
  // control surfaces actually deflected (-1..1)
  elev: number;
  ail: number;
  rud: number;
  /** pitch trim -1..1 (positive = nose up) */
  trim: number;
  /** flap lever detent index and actual position (in detent units) */
  flapIdx: number;
  flaps: number;
  gearLever: boolean;
  /** 0 up .. 1 down & locked */
  gear: number;
  /** spoiler lever 0..1, armed flag, and actual deployment 0..1 */
  spoilerLever: number;
  spoilerArmed: boolean;
  spoiler: number;
  /** throttle lever 0..1 per engine */
  throttle: number[];
  reverse: boolean;
  /** toe brakes 0..1 actually applied, and parking brake */
  brake: number;
  parkBrake: boolean;
  /** piston only: mixture 0..1 */
  mixture: number;
  fuel: number; // kg
  mass: number; // kg
  stalled: boolean;
  /** what the wheels are on */
  surface: 'runway' | 'taxiway' | 'apron' | 'grass' | 'air';
  crashed: string | null;
}

/** raw pilot inputs for the current frame (-1..1), merged from keyboard/mouse/gamepad */
export interface Inputs {
  pitch: number; // + = pull (nose up)
  roll: number; // + = right
  yaw: number; // + = right rudder
  brake: number;
}

export type LatMode = 'off' | 'hdg' | 'lnav' | 'loc' | 'rollout';
export type VertMode = 'off' | 'alt' | 'altacq' | 'vs' | 'flch' | 'gs' | 'toga';
export interface Autopilot {
  fd: boolean;
  /** autopilot engaged (commands the controls) */
  cmd: boolean;
  /** autothrottle armed / engaged */
  at: boolean;
  atMode: 'off' | 'spd' | 'n1' | 'idle';
  lat: LatMode;
  vert: VertMode;
  locArmed: boolean;
  gsArmed: boolean;
  selHdg: number;
  selAlt: number; // ft
  selVs: number; // fpm
  selSpd: number; // kt
  /** flight-director commands, deg */
  fdPitch: number;
  fdBank: number;
}

export interface Radios {
  com: { act: number; sby: number };
  nav: { act: number; sby: number; crs: number };
  xpdr: { code: number; mode: 0 | 1 | 2 }; // 0 STBY, 1 ALT, 2 TA/RA
  /** altimeter setting hPa; std = 1013 selected */
  baro: number;
  std: boolean;
}

/** deviation from the tuned ILS */
export interface IlsState {
  valid: boolean;
  /** localiser deviation in dots (+ = fly right), glideslope in dots (+ = fly up) */
  loc: number;
  gs: number;
  gsValid: boolean;
  dme: number; // NM to threshold
  crs: number;
}

export type Phase =
  | 'preflight'
  | 'before_start'
  | 'pushback'
  | 'engine_start'
  | 'taxi_out'
  | 'before_takeoff'
  | 'takeoff'
  | 'climb'
  | 'cruise'
  | 'descent'
  | 'approach'
  | 'landing'
  | 'rollout'
  | 'taxi_in'
  | 'shutdown'
  | 'complete';

export interface RadioMsg {
  t: number;
  from: 'atc' | 'me' | 'fo' | 'sys';
  station?: string;
  text: string;
}

export type AtcStage =
  | 'none'
  | 'clearance'
  | 'push'
  | 'taxi'
  | 'tower_dep'
  | 'lineup'
  | 'takeoff'
  | 'departure'
  | 'center'
  | 'approach'
  | 'tower_arr'
  | 'landing'
  | 'ground_arr'
  | 'done';

export interface AtcRequest {
  id: string;
  label: string;
  /** what the pilot says */
  say: string;
}

export interface AtcState {
  stage: AtcStage;
  /** station the pilot should be talking to and its frequency */
  station: string;
  freq: number;
  log: RadioMsg[];
  clearedIfr: boolean;
  clearedPush: boolean;
  clearedTaxi: boolean;
  clearedLineup: boolean;
  clearedTakeoff: boolean;
  clearedApproach: boolean;
  clearedLand: boolean;
  clearedTaxiIn: boolean;
  /** currently assigned altitude ft MSL (0 = none) */
  alt: number;
  squawk: number;
  /** queued ATC transmissions: [due time, station, text, effect id] */
  queue: { due: number; station: string; text: string; fx?: string; rb?: string }[];
  /** seconds until the first officer makes the next call (autoRadio) */
  foDelay: number;
  /** one-shot flags */
  flags: Record<string, number>;
}

export interface TaxiRoute {
  pts: [number, number][];
  names: string[];
  /** hold-short point (departures) */
  hold?: [number, number];
  /** runway ids the route crosses */
  crosses: string[];
}

export interface Pushback {
  /** tail-first path in world coords */
  pts: [number, number][];
  /** distance travelled along the path, m */
  s: number;
  len: number;
  done: boolean;
}

export interface Finding {
  t: number;
  cat: 'procedure' | 'atc' | 'flying' | 'landing' | 'safety';
  /** negative = penalty, positive = credit */
  pts: number;
  text: string;
}

export interface LandingData {
  /** touchdown vertical speed, fpm (positive = descending) */
  fpm: number;
  /** IAS at touchdown and reference speed */
  ias: number;
  vref: number;
  /** lateral offset from the centreline, m */
  offset: number;
  /** distance past the threshold, m */
  dist: number;
  pitch: number;
  bank: number;
  /** nose vs runway heading at touchdown, deg */
  crab: number;
  g: number;
  rwy: string;
  /** true when the wheels touched outside the runway */
  offRunway: boolean;
}

export interface SystemsState {
  /** electrical buses powered */
  bus: boolean;
  /** which source feeds the buses */
  source: 'none' | 'battery' | 'ext' | 'apu' | 'gen';
  batt: number; // 0..1 charge
  extAvail: boolean;
  apuN: number; // %
  apuRunning: boolean;
  hyd: [number, number]; // psi
  /** bleed duct pressure psi */
  duct: number;
  packs: number; // number running
  /** IRS / AHRS alignment 0..1 */
  align: number;
  cabinAlt: number; // ft
  fuelPress: boolean[];
  avionics: boolean;
  /** master warning (red) / caution (amber) messages */
  warnings: string[];
  cautions: string[];
  /** aural / visual configuration warning active */
  configWarn: boolean;
  stallWarn: boolean;
  overspeed: boolean;
  gpws: string | null;
}

export interface Environment {
  hour: number;
  /** visibility in metres and cloud base in ft AGL (99999 = clear) */
  vis: number;
  cloudBase: number;
  /** wind aloft (cruise level) */
  windAloft: { dir: number; kt: number };
  tempC: number;
}

/** Complete plain-data state of one flight. Everything the renderers need is in here. */
export interface PilotState {
  cfg: PilotConfig;
  t: number;
  rng: number;
  callsign: string;
  /** spoken callsign */
  radioName: string;
  airports: PlacedAirport[];
  env: Environment;
  ac: AcState;
  eng: EngState[];
  /** switch / selector positions keyed by control id */
  sw: Record<string, number>;
  sys: SystemsState;
  ap: Autopilot;
  radios: Radios;
  ils: IlsState;
  phase: Phase;
  route: Wp[];
  /** index of the waypoint currently flown TO */
  leg: number;
  cruiseAlt: number; // ft
  depRwy: RunwayRef;
  arrRwy: RunwayRef;
  /** gate/stand names */
  depGate: string;
  arrGate: string;
  taxi: TaxiRoute | null;
  push: Pushback | null;
  atc: AtcState;
  findings: Finding[];
  landings: LandingData[];
  /** flags and timers used by the phase tracker / callouts */
  flags: Record<string, number>;
  /** queued aural callouts (drained by the UI) */
  callouts: string[];
  /** first-officer flow queue: control actions executed one at a time */
  foQueue: { id: string; v: number; say?: string }[];
  foTimer: number;
  /** V-speeds, kt */
  vspeeds: { v1: number; vr: number; v2: number; vref: number; vapp: number };
  distFlown: number;
  /** time acceleration requested by the player */
  accel: number;
  over: boolean;
}

/** UI-visible definition of one cockpit control */
export interface ControlDef {
  id: string;
  label: string;
  /** panel section */
  section: string;
  panel: 'overhead' | 'pedestal' | 'main';
  /** position labels; index = value */
  pos: string[];
  /** momentary (springs back to 0) */
  momentary?: boolean;
  guard?: boolean;
  help: string;
  /** initial value when starting cold & dark */
  cold?: number;
}

export interface ChecklistItem {
  id: string;
  label: string;
  expect: string;
  ok: (p: PilotState) => boolean;
  /** control(s) the first officer sets to complete the item (may be computed from the state) */
  set?: [string, number][] | ((p: PilotState) => [string, number][]);
  /** the first officer waits until this is true before acting on the item */
  when?: (p: PilotState) => boolean;
  /** informational: shown but never blocks the flow */
  info?: boolean;
  /** control id to highlight for the player */
  ctl?: string;
  /** only the pilot flying can do this (never automated) */
  pilotOnly?: boolean;
}
export interface Checklist {
  id: string;
  title: string;
  phase: Phase[];
  items: ChecklistItem[];
}
