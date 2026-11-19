/** Topics 15 + 19: emergency behaviour and scoring. */
import { describe, expect, it } from 'vitest';
import { declareEmergency, triggerRandomEmergency } from '../src/sim/emergencies';
import { computeScore } from '../src/sim/scoring';
import { runwayOccupants } from '../src/sim/ground';
import { runwayById, runwayZoneAt } from '../src/sim/airport/query';
import { spawnArrival } from '../src/sim/traffic';
import { typeOf } from '../src/sim/data/aircraft';
import { NM } from '../src/sim/util';
import { Sim, defaultConfig } from '../src/sim/sim';
import { eventsOf, mkSim, ok, placeAirborne, placeFinal, placeOnRoute, placeOnRunway, routeVia, until } from './helpers';

describe('engine failure on departure', () => {
  const sim = mkSim('ATL', { configName: 'West flow' });
  const ac = placeOnRunway(sim, '27R', { callsign: 'DAL1426' });
  const twin = typeOf(ac.type);

  it('the departure becomes a returning arrival and declares MAYDAY', () => {
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    until(sim, () => ac.phase === 'departure' && ac.alt > 1200, 200, 'climbing');
    ac.tgtAlt = 10000;
    expect(ac.kind).toBe('departure');
    expect(declareEmergency(sim, ac, 'engine_failure')).toBe(true);
    expect(ac.kind).toBe('arrival');
    expect(ac.phase).toBe('inbound');
    expect(ac.dest).toBe('ATL');
    expect(ac.emergency).toMatchObject({ kind: 'engine_failure', mayday: true });
    expect(ac.request?.type).toBe('emergency');
    expect(ac.tgtAlt).toBeLessThanOrEqual(5000);
    expect(ac.tgtAlt).toBeGreaterThanOrEqual(3000);
    const ev = eventsOf(sim, 'emergency');
    expect(ev).toHaveLength(1);
    expect(ev[0].sev).toBe('critical');
    expect(ev[0].text).toMatch(/DAL1426 declares MAYDAY: engine failure/);
    const call = sim.s.radio.find((m) => m.emergency && m.from === 'pilot')!;
    expect(call.text).toMatch(/^MAYDAY, MAYDAY, MAYDAY.*engine failure, requesting immediate return to the field/);
    // a second declaration on the same aircraft is ignored
    expect(declareEmergency(sim, ac, 'medical')).toBe(false);
    expect(ac.emergency?.kind).toBe('engine_failure');
  });

  it('climbs at a reduced rate on one engine and refuses a big climb or a hold', () => {
    let maxVs = 0;
    const a0 = ac.alt;
    for (let i = 0; i < 300; i++) { sim.advance(0.1); maxVs = Math.max(maxVs, ac.vs); }
    expect(ac.alt).toBeGreaterThan(a0);
    // vs was above the single-engine rate at the moment of failure; it must decay to ≤ 40 % of the normal climb rate
    let later = 0;
    for (let i = 0; i < 100; i++) { sim.advance(0.1); later = Math.max(later, ac.vs); }
    expect(later).toBeLessThanOrEqual(twin.climbFpm * 0.4 + 1e-6);
    expect(ac.ias).toBeLessThanOrEqual(twin.vClean + 1);
    const climb = sim.commandText('DAL1426 CLIMB 12000');
    expect(climb.refused).toBe(true);
    expect(climb.message).toMatch(/unable to climb that high on one engine/);
    const hold = sim.commandText('DAL1426 HOLD');
    expect(hold.refused).toBe(true);
    expect(hold.message).toMatch(/unable to hold, we have an emergency/);
  });

  it('can be vectored back, lands, parks and the emergency is recorded as handled', () => {
    // put it on a base leg for 27L to keep the test short
    const e = sim.ap.runways.find((r) => r.id === '09R/27L')!.ends[1];
    Object.assign(ac, { x: e.x + 12 * NM, y: e.y + 1.5 * NM, alt: 3000, tgtAlt: 3000, hdg: 240, tgtHdg: 240, latMode: 'hdg' });
    ok(sim, 'DAL1426 CLEARED ILS 27L, CLEARED LAND 27L');
    until(sim, () => ac.phase === 'vacated', 900, 'landed and vacated');
    expect(ac.goArounds).toBe(0);
    expect(sim.s.stats.emergenciesHandled).toBe(0); // not over until it is on stand
    ok(sim, 'DAL1426 TAXI GATE B18');
    until(sim, () => ac.phase === 'parked', 1500, 'parked', () => {
      if (ac.request?.type === 'crossing' && !ac.flags.pending) sim.command(ac, [{ t: 'CROSS', rwy: runwayById(sim.ap, ac.request.rwy!)!.ends[0].name }]);
    });
    expect(ac.emergency?.resolved).toBeGreaterThan(0);
    expect(sim.s.stats.emergenciesHandled).toBe(1);
    expect(sim.s.stats.emergenciesFailed).toBe(0);
    expect(sim.s.stats.emergencyRespSum).toBeGreaterThan(60);
    expect(eventsOf(sim, 'emergency').some((x) => /emergency resolved/.test(x.text))).toBe(true);
    expect(computeScore(sim.s).emergencyScore).toBe(100);
  });
});

describe('landing gear emergency', () => {
  const sim = mkSim('ATL', { configName: 'West flow' });
  const ac = placeFinal(sim, '27L', 5, { callsign: 'UAL892', landCleared: true });
  const rwy = runwayById(sim.ap, '09R/27L')!;

  it('the aircraft lands and stays disabled on the runway', () => {
    expect(declareEmergency(sim, ac, 'gear')).toBe(true);
    expect(ac.emergency?.mayday).toBe(true);
    expect(ac.emergency?.blockFor).toBeGreaterThanOrEqual(600);
    ac.landCleared = true;
    until(sim, () => ac.phase === 'disabled', 600, 'stopped on the runway');
    expect(ac.gs).toBe(0);
    expect(runwayZoneAt(sim.ap, ac.x, ac.y)?.id).toBe('09R/27L');
    expect(runwayOccupants(sim, rwy)).toContain(ac);
    expect(sim.s.aircraft).toContain(ac);
    expect(eventsOf(sim, 'emergency').some((e) => /UAL892 is disabled on runway 27L – runway blocked/.test(e.text))).toBe(true);
    expect(sim.s.radio.some((m) => m.emergency && /stopped on the runway, unable to taxi/.test(m.text))).toBe(true);
    const r = sim.commandText('UAL892 TAXI GATE B18');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/disabled and cannot comply/);
  });

  it('the runway is physically blocked: departures refuse to roll and arrivals go around', () => {
    const { x, y } = ac;
    const dep = placeOnRunway(sim, '27L', { callsign: 'DAL5', along: 30 });
    const r = sim.commandText('DAL5 CLEARED TAKEOFF 27L');
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/traffic on the runway \(UAL892\)/);
    dep.phase = 'gone';
    const arr = placeFinal(sim, '27L', 3, { callsign: 'SWA6', airline: 'SWA', landCleared: true });
    until(sim, () => arr.phase === 'go_around', 200, 'go-around');
    expect(eventsOf(sim, 'go_around').some((e) => /SWA6 going around – traffic on the runway/.test(e.text))).toBe(true);
    arr.phase = 'gone';
    expect([ac.x, ac.y]).toEqual([x, y]);
    expect(ac.phase).toBe('disabled');
    expect(sim.s.stats.collisions).toBe(0);
  });

  it('is later removed by a tow, which resolves the emergency', () => {
    const until2 = ac.flags.disabledUntil;
    expect(until2 - sim.s.t).toBeGreaterThan(100);
    sim.advance(until2 - sim.s.t - 5);
    expect(ac.phase).toBe('disabled');
    expect(sim.s.aircraft).toContain(ac);
    sim.advance(10);
    expect(ac.phase).toBe('gone');
    expect(ac.flags.towed).toBe(1);
    expect(runwayOccupants(sim, rwy)).not.toContain(ac);
    expect(eventsOf(sim, 'runway').some((e) => /UAL892 has been towed clear of runway 09R\/27L/.test(e.text))).toBe(true);
    expect(ac.emergency?.resolved).toBeGreaterThan(0);
    expect(sim.s.stats.emergenciesHandled).toBe(1);
    // the runway is usable again
    placeOnRunway(sim, '27L', { callsign: 'DAL7', along: 30 });
    expect(sim.commandText('DAL7 CLEARED TAKEOFF 27L').ok).toBe(true);
    // and the record is eventually purged from the aircraft list
    sim.advance(400);
    expect(sim.s.aircraft).not.toContain(ac);
  });
});

describe('fuel emergencies', () => {
  it('with fuelRealism an arrival low on fuel declares minimum fuel, then a fuel emergency', () => {
    const sim = mkSim('ATL', {}, { fuelRealism: true });
    const ac = spawnArrival(sim, { airline: 'UAL', type: 'B738', callsign: 'UAL892', fix: 'LOGEN', distNm: 22, alt: 8000, fuelMin: 33 })!;
    sim.advance(60);
    expect(ac.emergency).toBeUndefined();
    until(sim, () => !!ac.emergency, 400, 'minimum fuel');
    expect(ac.emergency).toMatchObject({ kind: 'min_fuel', mayday: false });
    expect(ac.fuelMin).toBeLessThan(30);
    expect(ac.fuelMin).toBeGreaterThan(28);
    expect(sim.s.radio.some((m) => /declaring minimum fuel, \d+ minutes remaining/.test(m.text))).toBe(true);
    expect(eventsOf(sim, 'emergency')[0].text).toMatch(/UAL892 declares minimum fuel/);
    // not yet an emergency in the MAYDAY sense, but the crew will no longer accept a hold
    const hold = sim.commandText('UAL892 HOLD LOGEN');
    expect(hold.refused).toBe(true);
    until(sim, () => ac.emergency?.kind === 'fuel_emergency', 1200, 'fuel emergency');
    expect(ac.emergency?.mayday).toBe(true);
    expect(ac.fuelMin).toBeLessThan(15);
    expect(ac.fuelMin).toBeGreaterThan(13);
    expect(sim.s.radio.some((m) => m.emergency && /^MAYDAY.*fuel emergency, \d+ minutes of fuel remaining/.test(m.text))).toBe(true);
    expect(eventsOf(sim, 'emergency').map((e) => e.sev)).toEqual(['warning', 'critical']);
  });

  it('fuel exhaustion: the engines flame out and the aircraft glides down', () => {
    const sim = mkSim('ATL', {}, { fuelRealism: true });
    const ac = placeAirborne(sim, { callsign: 'UAL892', airline: 'UAL', x: -12 * NM, y: 12 * NM, alt: 6000, hdg: 90 });
    ac.fuel = typeOf(ac.type).fuelBurnKgMin * 0.5;
    until(sim, () => !!ac.flags.flameout, 120, 'flameout');
    expect(ac.emergency?.kind).toBe('dual_engine_failure');
    expect(eventsOf(sim, 'fuel').some((e) => /UAL892 has run out of fuel and is gliding/.test(e.text))).toBe(true);
    sim.advance(60);
    expect(ac.vs).toBeLessThan(-500);
    expect(sim.commandText('UAL892 CLIMB 8000').message).toMatch(/gliding, unable to maintain altitude/);
    until(sim, () => ac.phase === 'crashed', 900, 'ground contact');
    expect(sim.s.stats.collisions).toBe(1);
    expect(sim.s.stats.emergenciesFailed).toBe(1);
    expect(sim.s.aircraft).toContain(ac);
    expect(computeScore(sim.s).overall).toBeLessThanOrEqual(20);
    expect(computeScore(sim.s).emergencyScore).toBeLessThanOrEqual(50);
  });

  it('without fuelRealism nobody declares a fuel state', () => {
    const sim = mkSim('ATL', {}, { fuelRealism: false });
    const ac = spawnArrival(sim, { airline: 'UAL', type: 'B738', callsign: 'UAL892', fix: 'LOGEN', distNm: 22, alt: 8000, fuelMin: 25 })!;
    sim.advance(900);
    expect(ac.emergency).toBeUndefined();
    expect(eventsOf(sim, 'emergency')).toHaveLength(0);
    expect(sim.commandText('UAL892 HOLD LOGEN').ok).toBe(true);
  });

  it('a fuel-emergency aircraft lands even without a landing clearance (reported pilot action)', () => {
    const sim = mkSim('ATL', { configName: 'West flow' }, { fuelRealism: true });
    const ac = placeFinal(sim, '27L', 3, { callsign: 'UAL892' });
    declareEmergency(sim, ac, 'fuel_emergency');
    until(sim, () => ac.phase === 'landing_roll', 300, 'touchdown');
    expect(sim.s.radio.some((m) => m.emergency && /landing runway two seven left, emergency/.test(m.text))).toBe(true);
    expect(eventsOf(sim, 'incursion').some((e) => /landed runway 27L without a landing clearance/.test(e.text))).toBe(true);
  });
});

describe('other emergencies', () => {
  it('every emergency makes the crew refuse a hold; sending one around is penalised', () => {
    for (const kind of ['medical', 'hydraulic', 'electrical', 'flight_control', 'engine_failure'] as const) {
      const sim = mkSim('ATL', { configName: 'West flow' });
      const ac = placeFinal(sim, '27L', 6, { callsign: 'UAL892', landCleared: true });
      declareEmergency(sim, ac, kind);
      const p0 = sim.s.stats.safetyPenalty;
      expect(sim.commandText('UAL892 GO AROUND').ok).toBe(true);
      until(sim, () => ac.phase === 'go_around', 20, 'go-around read back'); // an electrical failure slows the readback
      expect(sim.s.stats.safetyPenalty, kind).toBe(p0 + 4);
      until(sim, () => ac.phase === 'inbound', 200, 'missed approach');
      const r = sim.commandText('UAL892 HOLD');
      expect(r.refused, kind).toBe(true);
      expect(r.message, kind).toMatch(/unable to hold, we have an emergency/);
    }
  });

  it('a fire on the ground disables the aircraft where it is; it is removed later', () => {
    const sim = mkSim('ATL');
    const ac = placeOnRoute(sim, routeVia(sim, [[-1300, -80], [600, -80]]), { callsign: 'DAL1' });
    sim.advance(30);
    declareEmergency(sim, ac, 'fire');
    expect(ac.phase).toBe('disabled');
    const { x, y } = ac;
    sim.advance(300);
    expect([ac.x, ac.y]).toEqual([x, y]);
    // traffic behind it stops instead of running into it
    const b = placeOnRoute(sim, routeVia(sim, [[-1300, -80], [600, -80]]), { callsign: 'DAL2' });
    sim.advance(200);
    expect(b.gs).toBe(0);
    expect(b.blockedBy).toBe(ac.id);
    expect(sim.s.stats.collisions).toBe(0);
    sim.advance(700);
    expect(ac.phase).toBe('gone');
    expect(sim.s.stats.emergenciesHandled).toBe(1);
  });

  it('a mechanical stop on a taxiway holds the aircraft until the tug arrives', () => {
    const sim = mkSim('ATL');
    const ac = placeOnRoute(sim, routeVia(sim, [[-1300, -80], [1400, -80]]), { callsign: 'DAL1' });
    sim.advance(20);
    declareEmergency(sim, ac, 'disabled_taxiway');
    sim.advance(30);
    expect(ac.gs).toBe(0);
    const x = ac.x;
    sim.advance(180);
    expect(ac.x).toBe(x);
    sim.advance(260);
    expect(ac.emergency?.resolved).toBeGreaterThan(0);
    expect(ac.x).toBeGreaterThan(x);
    expect(sim.s.stats.emergenciesHandled).toBe(1);
  });

  it('random emergencies only occur when emergencyFreq > 0, and are reproducible', () => {
    const quiet = mkSim('ATL');
    placeAirborne(quiet, { callsign: 'DAL1', x: -10 * NM, y: 10 * NM, alt: 6000, hdg: 90 });
    quiet.advance(1800);
    expect(eventsOf(quiet, 'emergency')).toHaveLength(0);
    expect(quiet.s.nextEmergency).toBe(Infinity);
    const run = () => {
      const s = mkSim('ATL', { seed: 99 });
      const a = placeAirborne(s, { callsign: 'DAL1', x: -10 * NM, y: 10 * NM, alt: 6000, hdg: 90 });
      expect(triggerRandomEmergency(s)).toBe(true);
      return a.emergency!.kind;
    };
    expect(run()).toBe(run());
  });

  it('an emergency left airborne for 15 minutes is penalised', () => {
    const sim = mkSim('ATL', {}, { fuelRealism: false });
    const ac = spawnArrival(sim, { airline: 'UAL', type: 'B738', callsign: 'UAL892', fix: 'LOGEN', distNm: 10, alt: 8000 })!;
    declareEmergency(sim, ac, 'medical');
    const p0 = sim.s.stats.safetyPenalty;
    sim.advance(905);
    expect(sim.s.stats.safetyPenalty).toBe(p0 + 6);
    expect(eventsOf(sim, 'emergency').some((e) => /airborne with an emergency for 15 minutes/.test(e.text))).toBe(true);
  });
});

describe('scoring', () => {
  const fresh = () => new Sim({ ...defaultConfig('ATL', 'intermediate'), emptyStart: true }).s;

  it('a fresh session scores 100 and all parts are within 0..100', () => {
    const sc = computeScore(fresh());
    expect(sc).toMatchObject({ overall: 100, safety: 100, efficiency: 100, emergencyScore: 100, grade: 'A+' });
    expect(sc.breakdown.length).toBeGreaterThan(8);
  });

  it('always stays within 0..100 for arbitrary (even absurd) statistics', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 300; i++) {
      const s = fresh();
      s.t = rnd() * 7200;
      for (const k of Object.keys(s.stats) as (keyof typeof s.stats)[]) s.stats[k] = Math.floor(rnd() * (rnd() < 0.3 ? 5000 : 6));
      const sc = computeScore(s);
      for (const v of [sc.overall, sc.safety, sc.efficiency, sc.emergencyScore]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      expect(sc.taxiEfficiency).toBeGreaterThanOrEqual(0);
      expect(sc.taxiEfficiency).toBeLessThanOrEqual(1);
      expect(['A+', 'A', 'B', 'C', 'D', 'F']).toContain(sc.grade);
    }
  });

  it('a session with a collision scores at most 20, whatever else went well', () => {
    const s = fresh();
    s.stats.collisions = 1;
    expect(computeScore(s).overall).toBeLessThanOrEqual(20);
    expect(computeScore(s).grade).toBe('F');
    // and through the real pipeline: a ground collision
    const sim = mkSim('ATL', {}, { pilotAssist: false });
    const a = placeOnRunway(sim, '27R', { callsign: 'DAL1', along: 500, phase: 'vacated', kind: 'arrival' });
    const b = placeOnRunway(sim, '27R', { callsign: 'DAL2', along: 300, phase: 'landing_roll', gs: 100, kind: 'arrival' });
    b.landCleared = true; b.flags.stopOnRwy = 1; b.emergency = { kind: 'brake_failure', since: 0, mayday: false };
    sim.advance(20);
    expect(sim.s.stats.collisions).toBe(1);
    expect(eventsOf(sim, 'collision')[0].text).toMatch(/GROUND COLLISION: DAL1 and DAL2 on runway 09L\/27R/);
    expect(a.phase).toBe('disabled');
    expect(b.phase).toBe('disabled');
    expect(sim.s.aircraft).toEqual(expect.arrayContaining([a, b]));
    const sc = computeScore(sim.s);
    expect(sc.overall).toBeLessThanOrEqual(20);
    expect(sc.safety).toBeLessThanOrEqual(45);
  });

  it('near misses and repeated incursions cap the score at 60', () => {
    const s = fresh();
    s.stats.nearMisses = 1;
    expect(computeScore(s).overall).toBeLessThanOrEqual(60);
    const s2 = fresh();
    s2.stats.incursions = 2;
    expect(computeScore(s2).overall).toBeLessThanOrEqual(60);
  });

  it('separation violations cost more safety than delays cost efficiency, and safety outweighs efficiency overall', () => {
    const viol = fresh();
    viol.stats.separationViolations = 1; viol.stats.safetyPenalty = 7; // what updateSeparation charges for one loss of separation
    const delay = fresh();
    delay.stats.arrDelayN = 1; delay.stats.arrDelaySum = 60; // one flight one minute late
    const sv = computeScore(viol), sd = computeScore(delay);
    expect(100 - sv.safety).toBeGreaterThan(100 - sd.efficiency);
    expect(sd.safety).toBe(100);
    expect(sv.efficiency).toBe(100);
    expect(sv.overall).toBeLessThan(sd.overall);
    // even three minutes of average delay hurts less than a single violation
    delay.stats.arrDelaySum = 180;
    expect(100 - computeScore(delay).efficiency).toBeLessThan(100 - sv.safety + 0.5);
    expect(computeScore(delay).overall).toBeGreaterThan(sv.overall);
    // equal raw penalties: the safety one weighs about twice as much in the overall score
    const s1 = fresh(); s1.stats.safetyPenalty = 22;
    const s2 = fresh(); s2.stats.arrDelayN = 1; s2.stats.arrDelaySum = 600; // 22 efficiency points
    expect(computeScore(s2).efficiency).toBe(78);
    expect(computeScore(s1).overall).toBeLessThan(computeScore(s2).overall);
  });

  it('monotonic: more violations / more delay never improve the score', () => {
    let prev = 101;
    for (let n = 0; n <= 12; n++) { const s = fresh(); s.stats.safetyPenalty = 7 * n; const o = computeScore(s).overall; expect(o).toBeLessThanOrEqual(prev); prev = o; }
    prev = 101;
    for (let n = 0; n <= 30; n += 3) { const s = fresh(); s.stats.depDelayN = 1; s.stats.depDelaySum = 60 * n; const o = computeScore(s).overall; expect(o).toBeLessThanOrEqual(prev); prev = o; }
  });

  it('real events move the score: a loss of separation lowers safety, a failed emergency lowers the emergency score', () => {
    const sim = mkSim('ATL');
    placeAirborne(sim, { callsign: 'DAL1', x: -10 * NM, y: 12 * NM, alt: 6000, hdg: 90 });
    placeAirborne(sim, { callsign: 'DAL2', x: -10 * NM, y: 14 * NM, alt: 6000, hdg: 90 });
    expect(computeScore(sim.s).safety).toBe(100);
    sim.advance(2);
    expect(computeScore(sim.s).safety).toBe(93);
    expect(computeScore(sim.s).overall).toBeLessThan(100);
    const s = fresh();
    s.stats.emergenciesFailed = 1;
    expect(computeScore(s).emergencyScore).toBe(50);
    s.stats.emergenciesHandled = 1; s.stats.emergencyRespSum = 3000;
    expect(computeScore(s).emergencyScore).toBeLessThan(50);
  });
});
