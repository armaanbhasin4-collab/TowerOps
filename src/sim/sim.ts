/**
 * Simulation: the single authoritative state + fixed-timestep update loop.
 * Rendering, UI panels, the voice front-end and AI delegation all read/write this object.
 */
import type { Aircraft, Command, CommandResult, Difficulty, Position, RunwayConfig, ScenarioConfig, SimState, Stats } from './types';
import { getAirport } from './airport';
import { endRef, normRwyName } from './airport/query';
import { World, acByCallsign, isAirborne, logEvent, radioSystem } from './world';
import { computeGroundLimits, updateGround, type GroundLimit } from './ground';
import { updateAirborne } from './air';
import { populate, updateTraffic } from './traffic';
import { makeWeather, updateWeather, metar, bumpAtis } from './weather';
import { scheduleNextEmergency, updateEmergencies } from './emergencies';
import { updateSeparation } from './separation';
import { issue, processPending } from './commands';
import { parseCommand, ParseError } from './parse';
import { runDelegation } from './delegation';
import { setupChallenge } from './scenarios';

export const DT = 0.1; // fixed simulation step (s)
export const SAVE_VERSION = 4;

export const DIFFICULTY_PRESETS: Record<Exclude<Difficulty['preset'], 'custom'>, Difficulty> = {
  beginner: { preset: 'beginner', maxAircraft: 6, arrivalRate: 9, departureRate: 8, emergencyFreq: 0.15, weatherSeverity: 0.1, pilotAssist: true, atcGuidance: true, safetyIntervention: true, strictSeparation: false, wakeSeparation: false, radioComplexity: 0, fuelRealism: false, perfRealism: false, collisionEnds: false, groundComplexity: 0.2, runwayCapacity: 1 },
  intermediate: { preset: 'intermediate', maxAircraft: 15, arrivalRate: 20, departureRate: 18, emergencyFreq: 0.6, weatherSeverity: 0.4, pilotAssist: true, atcGuidance: true, safetyIntervention: true, strictSeparation: true, wakeSeparation: false, radioComplexity: 0.3, fuelRealism: true, perfRealism: true, collisionEnds: false, groundComplexity: 0.5, runwayCapacity: 1 },
  advanced: { preset: 'advanced', maxAircraft: 30, arrivalRate: 36, departureRate: 34, emergencyFreq: 1.2, weatherSeverity: 0.65, pilotAssist: true, atcGuidance: false, safetyIntervention: false, strictSeparation: true, wakeSeparation: true, radioComplexity: 0.6, fuelRealism: true, perfRealism: true, collisionEnds: false, groundComplexity: 0.8, runwayCapacity: 1 },
  expert: { preset: 'expert', maxAircraft: 48, arrivalRate: 52, departureRate: 50, emergencyFreq: 2, weatherSeverity: 0.85, pilotAssist: false, atcGuidance: false, safetyIntervention: false, strictSeparation: true, wakeSeparation: true, radioComplexity: 1, fuelRealism: true, perfRealism: true, collisionEnds: true, groundComplexity: 1, runwayCapacity: 1 },
};

export function defaultConfig(airportId = 'ATL', preset: Exclude<Difficulty['preset'], 'custom'> = 'intermediate'): ScenarioConfig {
  return {
    airportId, mode: 'sandbox', difficulty: { ...DIFFICULTY_PRESETS[preset] }, weatherPreset: 'clear',
    seed: 12345, startClock: 14 * 3600, duration: 0,
    delegation: { delivery: false, ground: false, tower: false, approach: false, departure: false },
  };
}

const emptyStats = (): Stats => ({
  landed: 0, departed: 0, parked: 0, goArounds: 0, pilotGoArounds: 0, diversions: 0, separationViolations: 0, wakeViolations: 0,
  incursions: 0, nearMisses: 0, collisions: 0, groundConflicts: 0, emergenciesHandled: 0, emergenciesFailed: 0, emergencyRespSum: 0,
  arrDelaySum: 0, arrDelayN: 0, depDelaySum: 0, depDelayN: 0, taxiActualSum: 0, taxiIdealSum: 0, improperExits: 0,
  commands: 0, rejectedCommands: 0, safetyPenalty: 0, demand: 0,
});

export class Sim implements World {
  s!: SimState;
  ap!: World['ap'];
  private limits = new Map<number, GroundLimit>();

  constructor(cfg: ScenarioConfig, saved?: SimState) {
    this.ap = getAirport(cfg);
    if (saved) {
      this.s = saved;
      this.limits = computeGroundLimits(this);
      return;
    }
    // scale traffic to what the airport can plausibly handle
    const scale = Math.min(1, this.ap.baseRate / 60);
    const d = cfg.difficulty;
    const diff: Difficulty = cfg.emptyStart ? d : { ...d, arrivalRate: Math.max(d.arrivalRate > 0 ? 3 : 0, d.arrivalRate * scale), departureRate: Math.max(3, d.departureRate * scale), maxAircraft: Math.max(3, Math.round(d.maxAircraft * Math.max(0.35, scale))) };
    const cfg2 = { ...cfg, difficulty: diff };
    this.s = {
      version: SAVE_VERSION, cfg: cfg2, t: 0, step: 0, rng: cfg.seed | 0, nextId: 1, aircraft: [],
      weather: undefined as never, rwy: {}, closedEdges: [],
      activeConfig: this.ap.configs.find((c) => c.name === cfg.configName) ?? this.ap.configs[0],
      events: [], radio: [], alerts: [], stats: emptyStats(), pending: [],
      nextArrival: 30, nextOrigin: 300, nextEmergency: Infinity, usedCallsigns: [], over: false, track: [], atis: 'A', spawnQueue: 0,
      aux: { seen: {}, wx: {}, meter: { lastEta: {}, lastWake: {}, lastTx: {} } },
    };
    for (const r of this.ap.runways) this.s.rwy[r.id] = { closed: false, lastDep: {}, lastArr: {}, movements: 0, busySeconds: 0 };
    this.s.weather = makeWeather(this, cfg.weatherPreset);
    this.pickConfigForWind();
    for (const name of cfg.closedRunways ?? []) this.setRunwayClosed(name, true, 'scenario');
    if (diff.runwayCapacity < 1 && this.ap.runways.length > 1) {
      const keep = Math.max(1, Math.round(this.ap.runways.length * diff.runwayCapacity));
      const used = new Set([...this.s.activeConfig.arr, ...this.s.activeConfig.dep].map((n) => endRef(this.ap, n)?.rwy.id));
      const order = [...this.ap.runways].sort((a, b) => Number(used.has(a.id)) - Number(used.has(b.id)));
      for (const r of order.slice(0, this.ap.runways.length - keep)) this.setRunwayClosed(r.ends[0].name, true, 'reduced capacity');
    }
    logEvent(this, 'system', 'info', `${this.ap.icao} ${this.ap.name} – position open. ${metar(this)}`);
    radioSystem(this, `ATIS information ${this.s.atis}: ${metar(this)}. ${this.s.activeConfig.name}: landing ${this.s.activeConfig.arr.join(', ')}, departing ${this.s.activeConfig.dep.join(', ')}.`);
    if (!cfg.emptyStart) populate(this);
    if (cfg.challenge) setupChallenge(this, cfg.challenge);
    scheduleNextEmergency(this);
  }

  /** choose the configuration with the best headwind component */
  private pickConfigForWind() {
    if (this.s.cfg.configName) return;
    const wx = this.s.weather;
    let best = this.ap.configs[0], bestScore = -1e9;
    for (const c of this.ap.configs) {
      let score = 0;
      for (const n of c.arr) {
        const e = endRef(this.ap, n);
        if (e) score += Math.cos(((e.end.hdg - wx.windDir) * Math.PI) / 180) * wx.windKt;
      }
      score /= Math.max(1, c.arr.length);
      if (score > bestScore + 0.5) { bestScore = score; best = c; }
    }
    this.s.activeConfig = best;
  }

  /** advance the simulation by exactly one fixed step */
  step() {
    const s = this.s;
    if (s.over) return;
    s.t = Math.round((s.t + DT) * 1000) / 1000;
    s.step++;
    processPending(this);
    const second = s.step % 10 === 0;
    if (second) {
      updateWeather(this);
      updateTraffic(this);
      updateEmergencies(this);
    }
    if (s.step % 5 === 0) this.limits = computeGroundLimits(this);
    for (const ac of s.aircraft) {
      if (ac.phase === 'gone' || ac.phase === 'crashed') continue;
      if (isAirborne(ac)) updateAirborne(this, ac, DT);
      else updateGround(this, ac, DT, this.limits);
    }
    if (second) {
      updateSeparation(this);
      if (s.step % 20 === 0) {
        runDelegation(this);
        this.recordTrack();
      }
      if (s.cfg.duration > 0 && s.t >= s.cfg.duration && !s.over) {
        s.over = true;
        s.overReason = 'Scenario time limit reached';
      }
    }
  }

  /** advance by wall-clock style delta (used by tests and the game loop) */
  advance(seconds: number) {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n && !this.s.over; i++) this.step();
  }

  private recordTrack() {
    const s = this.s;
    const d: number[] = [];
    for (const a of s.aircraft) {
      if (a.phase === 'gone') continue;
      d.push(a.id, Math.round(a.x), Math.round(a.y), Math.round(a.alt), Math.round(a.hdg), isAirborne(a) ? 0 : a.phase === 'parked' ? 2 : 1);
      if (a.phase !== 'parked' && s.step % 40 === 0) {
        a.trail.push(Math.round(a.x), Math.round(a.y));
        if (a.trail.length > 60) a.trail.splice(0, 2);
      }
    }
    s.track.push({ t: s.t, d });
    if (s.track.length > 900) s.track.shift();
  }

  // ───────── command entry points ─────────

  command(ac: Aircraft | number | string, cmds: Command[], by: 'player' | 'ai' = 'player'): CommandResult {
    const a = typeof ac === 'number' ? this.s.aircraft.find((x) => x.id === ac) : typeof ac === 'string' ? acByCallsign(this, ac) : ac;
    if (!a) return { ok: false, message: 'Unknown aircraft.' };
    return issue(this, a, cmds, by);
  }

  /** typed / spoken command text → structured command → same pipeline */
  commandText(text: string): CommandResult {
    const t = text.trim();
    if (!t) return { ok: false, message: 'Empty command.' };
    const up = t.toUpperCase().split(/\s+/);
    try {
      // airport-level commands
      if (up[0] === 'RWY' || up[0] === 'RUNWAY') {
        const name = normRwyName(this.ap, up[1] ?? '');
        if (!name) return { ok: false, message: `Runway ${up[1] ?? ''} does not exist.` };
        if (up[2] === 'CLOSE' || up[2] === 'CLOSED') { this.setRunwayClosed(name, true, 'controller'); return { ok: true }; }
        if (up[2] === 'OPEN') { this.setRunwayClosed(name, false); return { ok: true }; }
        return { ok: false, message: 'Use "RWY 27R CLOSE" or "RWY 27R OPEN".' };
      }
      if (up[0] === 'CONFIG') {
        const q = up.slice(1).join(' ');
        const c = this.ap.configs.find((x) => x.name.toUpperCase().includes(q)) ?? this.ap.configs[+q - 1];
        if (!c) return { ok: false, message: `Configurations: ${this.ap.configs.map((x, i) => `${i + 1}=${x.name}`).join(', ')}` };
        this.setConfig(c);
        return { ok: true };
      }
      const p = parseCommand(this.ap, t, this.s.aircraft.filter((a) => a.phase !== 'gone').map((a) => a.callsign));
      return this.command(p.callsign, p.cmds);
    } catch (e) {
      if (e instanceof ParseError) return { ok: false, message: e.message };
      throw e;
    }
  }

  setRunwayClosed(endName: string, closed: boolean, reason?: string) {
    const e = endRef(this.ap, normRwyName(this.ap, endName));
    if (!e) return;
    const st = this.s.rwy[e.rwy.id];
    if (st.closed === closed) return;
    st.closed = closed;
    st.closedReason = closed ? reason : undefined;
    logEvent(this, 'runway', closed ? 'warning' : 'info', `Runway ${e.rwy.id} ${closed ? `CLOSED${reason ? ` (${reason})` : ''}` : 'reopened'}`);
    bumpAtis(this);
  }

  setConfig(c: RunwayConfig) {
    this.s.activeConfig = c;
    bumpAtis(this);
    logEvent(this, 'runway', 'advisory', `Runway configuration changed to ${c.name}: landing ${c.arr.join(', ')}, departing ${c.dep.join(', ')}`);
    radioSystem(this, `ATIS information ${this.s.atis}: now ${c.name}, landing ${c.arr.join(', ')}, departing ${c.dep.join(', ')}.`);
  }

  setTaxiwayClosed(name: string, closed: boolean) {
    const ids = this.ap.edges.filter((e) => e.name === name.toUpperCase() && e.kind !== 'runway').map((e) => e.id);
    if (!ids.length) return false;
    const set = new Set(this.s.closedEdges);
    for (const id of ids) closed ? set.add(id) : set.delete(id);
    this.s.closedEdges = [...set];
    logEvent(this, 'runway', closed ? 'warning' : 'info', `Taxiway ${name.toUpperCase()} ${closed ? 'CLOSED' : 'reopened'}`);
    return true;
  }

  setDelegation(pos: Position, on: boolean) {
    this.s.cfg.delegation[pos] = on;
    logEvent(this, 'system', 'info', `${pos[0].toUpperCase() + pos.slice(1)} position ${on ? 'delegated to AI controller' : 'returned to manual control'}`);
  }

  deferRequest(acId: number, seconds = 60) {
    const a = this.s.aircraft.find((x) => x.id === acId);
    if (a?.request) a.request.deferredUntil = this.s.t + seconds;
  }

  // ───────── persistence ─────────

  serialize(): string {
    return JSON.stringify({ version: SAVE_VERSION, state: this.s }, (_k, v) => (v === Infinity ? '__INF__' : v));
  }
  static deserialize(json: string): Sim {
    const data = JSON.parse(json, (_k, v) => (v === '__INF__' ? Infinity : v));
    if (!data || data.version !== SAVE_VERSION) throw new Error(`Incompatible save version (${data?.version}); this build reads version ${SAVE_VERSION}.`);
    const st = data.state as SimState;
    return new Sim(st.cfg, st);
  }
}
