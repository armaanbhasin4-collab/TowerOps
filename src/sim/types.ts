/**
 * Core simulation types. Everything in SimState is plain JSON-serialisable data so that
 * save/load, replay and deterministic stepping work without custom (de)serialisers.
 *
 * Units: positions in metres (x east, y north, origin = airport reference point),
 * altitude in feet above field elevation, speeds in knots, headings in degrees true
 * (0 = north, clockwise), time in simulated seconds.
 */

// ───────────────────────────── Static data ─────────────────────────────

export type WakeCat = 'L' | 'M' | 'H' | 'J';
/** Gate/stand size class, roughly ICAO aerodrome code C..F (S = regional/turboprop). */
export type SizeClass = 'S' | 'M' | 'L' | 'XL';

export interface AircraftType {
  id: string; // ICAO type designator, e.g. A321
  name: string;
  family: 'Airbus' | 'Boeing' | 'Embraer' | 'Bombardier' | 'ATR' | 'GA';
  wake: WakeCat;
  size: SizeClass;
  length: number; // m
  span: number; // m
  engines: number;
  turboprop?: boolean;
  vr: number; // rotation speed kt
  vref: number; // approach speed kt
  vClean: number; // minimum clean speed kt
  climbFpm: number; // typical initial climb rate
  descentFpm: number; // typical descent rate
  cruiseKt: number; // max IAS used in terminal area
  accelGround: number; // takeoff acceleration m/s²
  takeoffDist: number; // required takeoff distance m (dry, ISA, typical weight)
  landingDist: number; // required landing distance m (dry)
  maxXwind: number; // demonstrated crosswind kt
  taxiKt: number; // normal straight-line taxi speed
  fuelBurnKgMin: number; // approximate airborne terminal-area burn
  seats: number;
}

export interface Airline {
  icao: string; // DAL
  iata: string; // DL
  name: string;
  callsign: string; // telephony: "Delta"
  color: string; // fuselage / primary
  tail: string; // tail colour
  accent: string;
  cargo?: boolean;
}

export interface RunwayEnd {
  name: string; // "26R"
  x: number;
  y: number; // threshold position
  hdg: number; // landing/takeoff direction
  ils: boolean;
}

export interface Runway {
  id: string; // "08L/26R"
  ends: [RunwayEnd, RunwayEnd];
  length: number;
  width: number;
  /** graph node ids on the centreline, sorted from ends[0] toward ends[1] */
  nodes: number[];
}

export type NodeKind = 'twy' | 'rwy' | 'hold' | 'gate' | 'apron';
export interface GNode {
  id: number;
  x: number;
  y: number;
  kind: NodeKind;
  /** for 'rwy' and 'hold' nodes: runway id */
  rwy?: string;
  /** for 'gate' nodes: gate name */
  gate?: string;
}

export type EdgeKind = 'taxiway' | 'runway' | 'apron' | 'gate';
export interface GEdge {
  id: number;
  a: number;
  b: number;
  name: string; // taxiway designator ('' for gate lead-ins)
  kind: EdgeKind;
  len: number;
}

export interface Gate {
  name: string; // "B18"
  terminal: string; // "B"
  node: number; // gate (parking) node
  lane: number; // node where the lead-in meets the taxilane
  hdg: number; // parked nose heading
  size: SizeClass; // largest aircraft accepted
  airlines?: string[]; // preferred operators (advisory)
  cargo?: boolean;
  ga?: boolean;
}

export interface Fix {
  name: string;
  x: number;
  y: number;
  kind: 'arrival' | 'departure' | 'final' | 'nav';
  rwy?: string;
}

export interface RunwayConfig {
  name: string;
  arr: string[];
  dep: string[];
}

export interface TrafficMixEntry {
  airline: string;
  weight: number;
  types: string[];
  /** IATA codes of plausible origins/destinations */
  routes: string[];
}

export interface Airport {
  id: string;
  icao: string;
  iata: string;
  name: string;
  city: string;
  facility: string; // radio name "Atlanta"
  elevation: number;
  fictional: boolean;
  /** honest statement of data provenance shown in the UI */
  dataNote: string;
  runways: Runway[];
  nodes: GNode[];
  edges: GEdge[];
  /** adjacency: node id -> edge ids */
  adj: number[][];
  gates: Gate[];
  terminals: { name: string; poly: [number, number][]; label: [number, number] }[];
  aprons: [number, number][][];
  fixes: Fix[];
  configs: RunwayConfig[];
  mix: TrafficMixEntry[];
  airspaceRadius: number; // m
  ceiling: number; // ft
  holdDist: number; // m, hold line distance from runway centreline
  towerPos: [number, number];
  /** nominal movements per hour at density 1.0 */
  baseRate: number;
}

// ───────────────────────────── Dynamic state ─────────────────────────────

export type Phase =
  // arrivals
  | 'inbound' // airborne arrival under vectors / own navigation / holding
  | 'approach' // cleared approach, not yet established
  | 'final' // established on localiser
  | 'landing_roll'
  | 'vacated' // clear of runway, holding for taxi instructions
  | 'taxi_in'
  // gate
  | 'parked'
  // departures
  | 'pushback'
  | 'push_done' // pushback complete, waiting for taxi
  | 'taxi_out'
  | 'holding_short' // at departure runway hold line
  | 'lining_up'
  | 'lined_up'
  | 'takeoff_roll'
  | 'departure' // airborne departure
  // terminal / abnormal
  | 'go_around'
  | 'disabled' // immobile on surface (emergency, collision)
  | 'crashed'
  | 'gone'; // left the simulation (departed / diverted) – kept for boards

export type TurnStage =
  | 'arriving'
  | 'deboarding'
  | 'unloading'
  | 'servicing' // refuel + catering + cleaning
  | 'boarding'
  | 'deicing'
  | 'ready'; // pushback preparation complete

export type RequestType =
  | 'clearance'
  | 'pushback'
  | 'taxi'
  | 'crossing'
  | 'takeoff'
  | 'approach'
  | 'landing'
  | 'taxi_in'
  | 'departure' // airborne departure wants further climb / routing
  | 'emergency'
  | 'tow';

export interface Request {
  type: RequestType;
  since: number;
  text: string;
  deferredUntil?: number;
  /** runway relevant to the request (crossing) */
  rwy?: string;
}

export type EmergencyKind =
  | 'engine_failure'
  | 'dual_engine_failure'
  | 'hydraulic'
  | 'gear'
  | 'electrical'
  | 'flight_control'
  | 'brake_failure'
  | 'tire_failure'
  | 'rejected_takeoff'
  | 'medical'
  | 'crew_medical'
  | 'min_fuel'
  | 'fuel_emergency'
  | 'turbulence'
  | 'windshear'
  | 'fire'
  | 'evacuation'
  | 'disabled_taxiway'
  | 'pilot_deviation';

export interface Emergency {
  kind: EmergencyKind;
  since: number;
  mayday: boolean; // MAYDAY vs PAN-PAN
  resolved?: number;
  /** seconds the aircraft will block its position after stopping */
  blockFor?: number;
}

export type LatMode = 'hdg' | 'fix' | 'hold' | 'loc';

export interface Aircraft {
  id: number;
  callsign: string; // DAL1426
  airline: string; // ICAO
  type: string; // aircraft type id
  reg: string;
  /** provenance label of the flight data */
  source: 'simulated' | 'historical' | 'live';
  kind: 'arrival' | 'departure'; // current leg
  origin: string;
  dest: string;
  sched: number; // scheduled arrival (arrivals) or departure (departures), sim seconds
  est: number;
  actual?: number;
  delay: number; // seconds vs schedule, updated continuously
  phase: Phase;

  // kinematics
  x: number;
  y: number;
  alt: number;
  hdg: number;
  ias: number; // kt (ground speed when on the ground)
  gs: number; // kt
  vs: number; // fpm
  track: number;

  // airborne guidance
  latMode: LatMode;
  tgtHdg: number;
  turnDir: 0 | 1 | -1; // forced turn direction for next heading change
  tgtAlt: number;
  tgtSpd: number; // 0 = pilot's discretion
  fix?: string; // direct-to / hold fix
  holdLeg?: number; // hold state timer
  holdOut?: boolean;

  // runway / approach
  rwy?: string; // assigned runway end name
  apprCleared: boolean;
  landCleared: boolean;
  established: boolean;
  goArounds: number;
  exitPref?: string; // requested exit taxiway name
  /** distance travelled along runway from threshold (landing / takeoff) */
  rwyDist?: number;

  // departure clearances
  depCleared: boolean; // IFR clearance delivered
  pushApproved: boolean;
  lineUpCleared: boolean;
  takeoffCleared: boolean;
  /** runways the aircraft is cleared to cross / enter */
  crossCleared: string[];
  depFix?: string;
  handedOff: boolean;

  // ground movement
  gate?: string;
  route: number[]; // node ids
  routeS: number; // distance travelled along route
  routeStop: number; // clearance limit as distance along route
  reverse: boolean; // being pushed tail-first
  holdPos: boolean; // instructed to hold position
  /** current surface segment (from -> to, distance) when stationary without a route */
  seg?: { a: number; b: number; d: number };
  taxiNames: string[]; // taxiways in the cleared route (for display/readback)
  blockedBy?: number; // id of traffic we are giving way to
  blockedSince?: number;
  taxiStart?: number;
  taxiIdeal?: number; // unimpeded taxi time estimate (s)

  // turnaround
  turn?: { stage: TurnStage; stageEnd: number; readyAt: number; progress: number };
  nextLeg?: { callsign: string; dest: string; sched: number };

  fuel: number; // kg
  fuelMin: number; // minutes of fuel remaining (derived)
  emergency?: Emergency;
  request?: Request;
  lastContact: number;
  checkedIn: boolean;
  spawnT: number;
  /** runway exit time / airborne time etc. for scoring */
  landedAt?: number;
  airborneAt?: number;
  trail: number[]; // recent positions x,y,x,y...
  lastRwy?: string;
  /** set when pilot has reported a weather deviation etc. to avoid repeats */
  flags: Record<string, number>;
}

export interface StormCell {
  x: number;
  y: number;
  r: number; // m
  intensity: number; // 0..1
  vx: number;
  vy: number; // m/s
}

export type Precip = 'none' | 'rain' | 'heavy_rain' | 'snow' | 'fog' | 'thunderstorm';
export interface Weather {
  windDir: number;
  windKt: number;
  gustKt: number;
  visSM: number;
  ceilingFt: number; // 99999 = clear
  tempC: number;
  dewC: number;
  qnh: number; // inHg * 100
  precip: Precip;
  surface: 'dry' | 'wet' | 'snow' | 'ice';
  windshear: boolean;
  cells: StormCell[];
  /** slowly varying targets for dynamic weather */
  tgtWindDir: number;
  tgtWindKt: number;
  nextChange: number;
}

export type WeatherPreset = 'clear' | 'rain' | 'thunderstorm' | 'fog' | 'winter' | 'dynamic' | 'custom';

export type Severity = 'info' | 'advisory' | 'warning' | 'critical';
export type EventKind =
  | 'system'
  | 'landing'
  | 'takeoff'
  | 'gate'
  | 'pushback'
  | 'go_around'
  | 'conflict'
  | 'separation'
  | 'wake'
  | 'incursion'
  | 'collision'
  | 'near_miss'
  | 'emergency'
  | 'weather'
  | 'runway'
  | 'diversion'
  | 'fuel'
  | 'pilot_action'
  | 'handoff'
  | 'score';

export interface SimEvent {
  t: number;
  kind: EventKind;
  sev: Severity;
  text: string;
  ac?: number[];
  x?: number;
  y?: number;
}

export interface RadioMsg {
  t: number;
  from: 'pilot' | 'atc' | 'system';
  ac?: number;
  callsign?: string;
  text: string;
  emergency?: boolean;
  pos?: Position;
}

export type Position = 'delivery' | 'ground' | 'tower' | 'approach' | 'departure';

export interface RunwayState {
  closed: boolean;
  closedReason?: string;
  /** last departure from each end: time + wake category */
  lastDep: Record<string, { t: number; wake: WakeCat; ac: number }>;
  lastArr: Record<string, { t: number; wake: WakeCat; ac: number }>;
  movements: number;
  busySeconds: number;
}

export interface Alert {
  key: string;
  level: 'predict' | 'violation' | 'critical';
  kind: 'airborne' | 'runway' | 'ground' | 'wake' | 'approach';
  ac: number[];
  text: string;
  since: number;
}

export interface Stats {
  landed: number;
  departed: number;
  parked: number;
  goArounds: number;
  pilotGoArounds: number;
  diversions: number;
  separationViolations: number;
  wakeViolations: number;
  incursions: number;
  nearMisses: number;
  collisions: number;
  groundConflicts: number;
  emergenciesHandled: number;
  emergenciesFailed: number;
  emergencyRespSum: number; // seconds declared -> resolved
  arrDelaySum: number;
  arrDelayN: number;
  depDelaySum: number;
  depDelayN: number;
  taxiActualSum: number;
  taxiIdealSum: number;
  improperExits: number;
  commands: number;
  rejectedCommands: number;
  safetyPenalty: number;
  demand: number; // flights that wanted to move
}

export interface Difficulty {
  preset: 'beginner' | 'intermediate' | 'advanced' | 'expert' | 'custom';
  maxAircraft: number; // cap on simultaneously active (non-parked) aircraft
  arrivalRate: number; // arrivals per hour
  departureRate: number; // departures per hour (drives initial gate population)
  emergencyFreq: number; // expected emergencies per hour
  weatherSeverity: number; // 0..1
  pilotAssist: boolean; // pilots refuse clearly unsafe clearances / self-separate on ground
  atcGuidance: boolean; // suggestion engine + path guidance
  safetyIntervention: boolean; // TCAS-style automatic resolution
  strictSeparation: boolean; // full 3nm/1000ft + wake
  wakeSeparation: boolean;
  radioComplexity: number; // 0..1 readback errors, missed calls
  fuelRealism: boolean;
  perfRealism: boolean; // enforce runway length / crosswind limits
  collisionEnds: boolean; // collision ends scenario
  groundComplexity: number; // 0..1 (affects initial gate fill)
  runwayCapacity: number; // 0..1 fraction of runways open at start
}

export type GameMode = 'sandbox' | 'career' | 'challenge' | 'realism';

export interface CustomAirportParams {
  name: string;
  runways: { length: number; hdg: number; offset: number; along: number }[];
  layout: 'parallel' | 'intersecting' | 'mixed';
  terminals: number;
  gatesPerTerminal: number;
  taxiComplexity: number; // 0..1
  size: number; // 0.6 .. 1.6 scale
  categories: SizeClass[];
  airlines: string[];
}

export interface ScenarioConfig {
  airportId: string;
  custom?: CustomAirportParams;
  mode: GameMode;
  difficulty: Difficulty;
  weatherPreset: WeatherPreset;
  customWeather?: Partial<Weather>;
  seed: number;
  startClock: number; // seconds since local midnight
  /** challenge scenario id */
  challenge?: string;
  /** scenario time limit in sim seconds (0 = unlimited) */
  duration: number;
  delegation: Record<Position, boolean>;
  /** scripted set-up for tests/challenges: skip random initial traffic */
  emptyStart?: boolean;
  closedRunways?: string[];
  configName?: string;
}

export interface TrackFrame {
  t: number;
  /** id, x, y, alt, hdg, flags(1=ground) flattened */
  d: number[];
}

export interface SimState {
  version: number;
  cfg: ScenarioConfig;
  t: number; // sim seconds since scenario start
  step: number;
  rng: number; // rng state
  nextId: number;
  aircraft: Aircraft[];
  weather: Weather;
  rwy: Record<string, RunwayState>;
  closedEdges: number[];
  activeConfig: RunwayConfig;
  events: SimEvent[];
  radio: RadioMsg[];
  alerts: Alert[];
  stats: Stats;
  /** pending pilot readbacks: commands take effect when the readback is made */
  pending: PendingTx[];
  nextArrival: number;
  nextOrigin: number;
  nextEmergency: number;
  usedCallsigns: string[];
  over: boolean;
  overReason?: string;
  track: TrackFrame[];
  atis: string; // information letter
  spawnQueue: number; // arrivals waiting outside the airspace due to caps
}

// ───────────────────────────── Commands ─────────────────────────────

export type Command =
  | { t: 'DEP_CLEARANCE' }
  | { t: 'PUSHBACK'; face?: 'N' | 'E' | 'S' | 'W' }
  | { t: 'TAXI'; rwy?: string; gate?: string; via?: string[]; holdShort?: string }
  | { t: 'HOLD_POSITION' }
  | { t: 'CONTINUE_TAXI' }
  | { t: 'CROSS'; rwy: string }
  | { t: 'LINE_UP'; rwy?: string }
  | { t: 'TAKEOFF'; rwy?: string }
  | { t: 'CANCEL_TAKEOFF' }
  | { t: 'HEADING'; hdg: number; dir?: 'L' | 'R' }
  | { t: 'ALTITUDE'; alt: number }
  | { t: 'SPEED'; spd: number }
  | { t: 'DIRECT'; fix: string }
  | { t: 'HOLD'; fix?: string }
  | { t: 'APPROACH'; rwy: string }
  | { t: 'LAND'; rwy?: string }
  | { t: 'GO_AROUND' }
  | { t: 'ASSIGN_RUNWAY'; rwy: string }
  | { t: 'ASSIGN_GATE'; gate: string }
  | { t: 'EXIT'; twy: string }
  | { t: 'HANDOFF' }
  | { t: 'TOW' };

export interface PendingTx {
  at: number;
  ac: number;
  cmds: Command[];
  readback: string;
  /** who issued it (for delegation logging) */
  by: 'player' | 'ai';
}

export interface CommandResult {
  ok: boolean;
  /** error or pilot "unable" message */
  message?: string;
  /** true when the clearance was transmitted but the pilot refused it */
  refused?: boolean;
}
