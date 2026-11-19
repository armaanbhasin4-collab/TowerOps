/** Challenge scenarios and career progression. All are built from the same simulation config. */
import type { Difficulty, ScenarioConfig, WeatherPreset } from './types';
import type { World } from './world';
import { isAirborne, logEvent } from './world';
import { declareEmergency } from './emergencies';
import { DIFFICULTY_PRESETS, defaultConfig } from './sim';

export interface ChallengeDef {
  id: string;
  title: string;
  airport: string;
  blurb: string;
  preset: Exclude<Difficulty['preset'], 'custom'>;
  weather: WeatherPreset;
  duration: number;
  startClock: number;
  tweak?: Partial<Difficulty>;
  closedRunways?: string[];
}

export const CHALLENGES: ChallengeDef[] = [
  { id: 'atl_rush', title: 'Atlanta evening rush', airport: 'ATL', blurb: 'A full Delta bank: heavy arrivals on three runways while a wall of departures pushes back.', preset: 'advanced', weather: 'clear', duration: 1800, startClock: 17.5 * 3600, tweak: { arrivalRate: 46, departureRate: 46, maxAircraft: 40 } },
  { id: 'jfk_intl', title: 'JFK international arrival bank', airport: 'JFK', blurb: 'Transatlantic heavies arrive in a stream – wake turbulence spacing decides your capacity.', preset: 'advanced', weather: 'rain', duration: 1800, startClock: 15 * 3600, tweak: { arrivalRate: 40, departureRate: 18 } },
  { id: 'lhr_lowvis', title: 'Heathrow low-visibility operations', airport: 'EGLL', blurb: 'Fog at 400 m visibility. Crews cannot see each other, spacing must open up and taxi speeds drop.', preset: 'advanced', weather: 'fog', duration: 1800, startClock: 7 * 3600, tweak: { weatherSeverity: 0.8 } },
  { id: 'lga_closure', title: 'LaGuardia runway closure', airport: 'LGA', blurb: 'Runway 13/31 is closed for maintenance. Every arrival and departure shares runway 4/22.', preset: 'intermediate', weather: 'clear', duration: 1500, startClock: 9 * 3600, closedRunways: ['13'], tweak: { arrivalRate: 22, departureRate: 22 } },
  { id: 'atl_storm', title: 'Severe thunderstorm approaching Atlanta', airport: 'ATL', blurb: 'Convective cells drift across the arrival corridors with wind shear and a likely runway change.', preset: 'advanced', weather: 'thunderstorm', duration: 1800, startClock: 16 * 3600, tweak: { weatherSeverity: 1 } },
  { id: 'emergency_peak', title: 'Emergency landing during peak departures', airport: 'ATL', blurb: 'An engine failure on departure needs an immediate return while the departure queue is full.', preset: 'intermediate', weather: 'clear', duration: 1500, startClock: 8 * 3600, tweak: { departureRate: 40, emergencyFreq: 0 } },
  { id: 'one_runway', title: 'One runway at maximum capacity', airport: 'REG', blurb: 'A single runway, arrivals and departures competing for every gap.', preset: 'intermediate', weather: 'clear', duration: 1500, startClock: 12 * 3600, tweak: { arrivalRate: 60, departureRate: 60, maxAircraft: 16 } },
  { id: 'multi_emergency', title: 'Multiple simultaneous emergencies', airport: 'ATL', blurb: 'Several aircraft declare emergencies within minutes of each other. Prioritise.', preset: 'intermediate', weather: 'clear', duration: 1500, startClock: 13 * 3600, tweak: { emergencyFreq: 0 } },
];

export function challengeConfig(id: string, seed = 777): ScenarioConfig {
  const c = CHALLENGES.find((x) => x.id === id) ?? CHALLENGES[0];
  return {
    ...defaultConfig(c.airport, c.preset), mode: 'challenge', challenge: c.id, weatherPreset: c.weather, duration: c.duration,
    startClock: c.startClock, seed, closedRunways: c.closedRunways,
    difficulty: { ...DIFFICULTY_PRESETS[c.preset], ...c.tweak },
  };
}

/** scenario-specific events are scheduled through flags checked by tickChallenge */
export function setupChallenge(w: World, id: string) {
  const c = CHALLENGES.find((x) => x.id === id);
  if (c) logEvent(w, 'system', 'advisory', `Challenge: ${c.title} – ${c.blurb}`);
}

/** called once per second from the emergency update to fire scripted challenge events */
export function tickChallenge(w: World) {
  const { s } = w;
  const id = s.cfg.challenge;
  if (!id) return;
  const fired = (s as unknown as { _ch?: Record<string, number> });
  const ch = ((s as unknown as { chal?: Record<string, number> }).chal ??= {});
  void fired;
  if (id === 'emergency_peak' && !ch.e1 && s.t > 60) {
    const dep = s.aircraft.find((a) => a.phase === 'departure' && a.alt > 500 && a.alt < 6000 && !a.emergency);
    if (dep) { ch.e1 = 1; declareEmergency(w, dep, 'engine_failure'); }
  }
  if (id === 'multi_emergency') {
    const arrivals = s.aircraft.filter((a) => isAirborne(a) && a.kind === 'arrival' && !a.emergency && a.phase === 'inbound');
    if (!ch.e1 && s.t > 60 && arrivals[0]) { ch.e1 = 1; declareEmergency(w, arrivals[0], 'medical'); }
    else if (!ch.e2 && s.t > 150 && arrivals[0]) { ch.e2 = 1; declareEmergency(w, arrivals[0], 'gear'); }
    else if (!ch.e3 && s.t > 260 && arrivals[0]) { ch.e3 = 1; declareEmergency(w, arrivals[0], 'engine_failure'); }
    else if (!ch.e4 && s.t > 420) {
      const tx = s.aircraft.find((a) => a.phase === 'taxi_out' && !a.emergency);
      if (tx) { ch.e4 = 1; declareEmergency(w, tx, 'disabled_taxiway'); }
    }
  }
}

export interface CareerLevel {
  id: number;
  title: string;
  airport: string;
  preset: Exclude<Difficulty['preset'], 'custom'>;
  weather: WeatherPreset;
  duration: number;
  pass: number;
  blurb: string;
}
export const CAREER: CareerLevel[] = [
  { id: 1, title: 'Trainee – Cedar Valley Tower', airport: 'REG', preset: 'beginner', weather: 'clear', duration: 900, pass: 70, blurb: 'One runway, light regional traffic, full guidance.' },
  { id: 2, title: 'Cedar Valley in the rain', airport: 'REG', preset: 'intermediate', weather: 'rain', duration: 1200, pass: 70, blurb: 'More traffic, wet runway, no hand-holding on separation.' },
  { id: 3, title: 'LaGuardia Tower', airport: 'LGA', preset: 'intermediate', weather: 'clear', duration: 1200, pass: 72, blurb: 'Intersecting runways demand precise timing.' },
  { id: 4, title: 'Los Angeles', airport: 'LAX', preset: 'intermediate', weather: 'dynamic', duration: 1500, pass: 72, blurb: 'Four parallels, runway crossings and heavy jets.' },
  { id: 5, title: 'Heathrow in fog', airport: 'EGLL', preset: 'advanced', weather: 'fog', duration: 1500, pass: 74, blurb: 'Two runways, long-haul heavies, low visibility procedures.' },
  { id: 6, title: 'New York JFK', airport: 'JFK', preset: 'advanced', weather: 'dynamic', duration: 1800, pass: 75, blurb: 'International banks with strict wake separation.' },
  { id: 7, title: 'Atlanta – world\'s busiest', airport: 'ATL', preset: 'advanced', weather: 'dynamic', duration: 1800, pass: 76, blurb: 'Five runways and the Delta hub at full tilt.' },
  { id: 8, title: 'Atlanta – Master Controller', airport: 'ATL', preset: 'expert', weather: 'thunderstorm', duration: 1800, pass: 78, blurb: 'Expert rules, storms, emergencies. No safety nets.' },
];
export function careerConfig(level: number, seed = 4242): ScenarioConfig {
  const l = CAREER.find((x) => x.id === level) ?? CAREER[0];
  return { ...defaultConfig(l.airport, l.preset), mode: 'career', weatherPreset: l.weather, duration: l.duration, seed: seed + level, challenge: undefined };
}
