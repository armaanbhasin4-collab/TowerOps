/** Topic 9: airborne separation, wake tables, TCAS-style resolution, mid-air collisions. */
import { describe, expect, it } from 'vitest';
import type { WakeCat } from '../src/sim/types';
import { wakeDepartureInterval, wakeMinimum } from '../src/sim/separation';
import { NM } from '../src/sim/util';
import { eventsOf, mkSim, placeAirborne, placeFinal } from './helpers';

// a quiet piece of sky north-west of the field
const X0 = -10 * NM, Y0 = 12 * NM;

/** two level aircraft flying the same heading and speed, `latNm` apart laterally and `dAlt` ft apart */
function pair(latNm: number, dAlt: number, diff = {}) {
  const sim = mkSim('ATL', {}, diff);
  const a = placeAirborne(sim, { callsign: 'DAL1', x: X0, y: Y0, alt: 6000, hdg: 90 });
  const b = placeAirborne(sim, { callsign: 'UAL2', airline: 'UAL', x: X0, y: Y0 + latNm * NM, alt: 6000 + dAlt, hdg: 90 });
  return { sim, a, b };
}

describe('airborne separation monitoring', () => {
  it('< 3 NM and < 1000 ft: a separation violation event, alert and stat', () => {
    const { sim, a, b } = pair(2, 500);
    sim.advance(1);
    expect(sim.s.stats.separationViolations).toBe(1);
    const ev = eventsOf(sim, 'separation');
    expect(ev).toHaveLength(1);
    expect(ev[0].text).toMatch(/Loss of separation: DAL1 and UAL2 – 2\.0 NM \/ 500 ft \(required 3 NM or 1000 ft\)/);
    expect(ev[0].ac).toEqual([a.id, b.id]);
    const al = sim.s.alerts.find((x) => x.key.startsWith('sep:'))!;
    expect(al.level).toBe('violation');
    expect(al.kind).toBe('airborne');
    expect(al.ac).toEqual([a.id, b.id]);
    expect(sim.s.stats.safetyPenalty).toBe(7);
    expect(sim.s.stats.nearMisses).toBe(0);
  });

  it('a continuing violation is counted once; a new one after separation was restored is counted again', () => {
    const { sim, b } = pair(2, 0);
    sim.advance(60);
    expect(sim.s.stats.separationViolations).toBe(1);
    expect(eventsOf(sim, 'separation')).toHaveLength(1);
    expect(sim.s.alerts.some((x) => x.key.startsWith('sep:'))).toBe(true); // the alert itself stays up
    b.alt = b.tgtAlt = 8000;
    sim.advance(40);
    expect(sim.s.alerts.some((x) => x.key.startsWith('sep:'))).toBe(false);
    b.alt = b.tgtAlt = 6000;
    sim.advance(2);
    expect(sim.s.stats.separationViolations).toBe(2);
  });

  it('1000 ft or more vertically, or 3 NM or more laterally: no violation', () => {
    for (const [lat, dAlt] of [[0.5, 1000], [2, 1000], [2.9, 2000], [3.1, 0], [5, 0]] as const) {
      const { sim } = pair(lat, dAlt);
      sim.advance(30);
      expect(sim.s.stats.separationViolations, `${lat} NM / ${dAlt} ft`).toBe(0);
      expect(eventsOf(sim, 'separation'), `${lat} NM / ${dAlt} ft`).toHaveLength(0);
      expect(sim.s.alerts.filter((x) => x.level !== 'predict'), `${lat} NM / ${dAlt} ft`).toHaveLength(0);
    }
  });

  it('just inside the minima is a violation (2.9 NM / 900 ft)', () => {
    const { sim } = pair(2.9, 900);
    sim.advance(2);
    expect(sim.s.stats.separationViolations).toBe(1);
  });

  it('relaxed separation (strictSeparation off) uses 2 NM', () => {
    const relaxed = pair(2.5, 0, { strictSeparation: false });
    relaxed.sim.advance(10);
    expect(relaxed.sim.s.stats.separationViolations).toBe(0);
    const close = pair(1.8, 0, { strictSeparation: false });
    close.sim.advance(2);
    expect(close.sim.s.stats.separationViolations).toBe(1);
  });

  it('very close proximity is additionally recorded as a near mid-air collision', () => {
    const { sim } = pair(0.3, 200);
    sim.advance(1);
    expect(sim.s.stats.separationViolations).toBe(1);
    expect(sim.s.stats.nearMisses).toBe(1);
    expect(eventsOf(sim, 'near_miss')).toHaveLength(1);
    expect(sim.s.alerts.find((x) => x.key.startsWith('sep:'))!.level).toBe('critical');
  });

  it('a predicted conflict raises a "predict" alert before separation is lost', () => {
    const sim = mkSim('ATL');
    placeAirborne(sim, { callsign: 'DAL1', x: X0, y: Y0, alt: 6000, hdg: 90 });
    placeAirborne(sim, { callsign: 'UAL2', airline: 'UAL', x: X0 + 9 * NM, y: Y0, alt: 6000, hdg: 270 });
    let predictedAt = -1, violatedAt = -1;
    for (let i = 0; i < 120 && violatedAt < 0; i++) {
      sim.advance(1);
      if (predictedAt < 0 && sim.s.alerts.some((x) => x.level === 'predict')) predictedAt = sim.s.t;
      if (sim.s.stats.separationViolations) violatedAt = sim.s.t;
    }
    expect(predictedAt).toBeGreaterThan(0);
    expect(violatedAt).toBeGreaterThan(predictedAt + 10);
  });

  it('established aircraft on parallel runways are exempt', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const a = placeFinal(sim, '26R', 8, { callsign: 'DAL1', airline: 'DAL', landCleared: true });
    const b = placeFinal(sim, '27L', 8, { callsign: 'UAL2', landCleared: true });
    expect(Math.hypot(a.x - b.x, a.y - b.y) / NM).toBeLessThan(3);
    expect(Math.abs(a.alt - b.alt)).toBeLessThan(100);
    sim.advance(90);
    expect(a.phase).toBe('final');
    expect(b.phase).toBe('final');
    expect(sim.s.stats.separationViolations).toBe(0);
    expect(sim.s.alerts.filter((x) => x.kind === 'airborne' || x.kind === 'approach')).toHaveLength(0);
  });

  it('...but the same geometry is a violation when one of them is not established', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const a = placeFinal(sim, '26R', 8, { callsign: 'DAL1', airline: 'DAL' });
    const b = placeFinal(sim, '27L', 8, { callsign: 'UAL2' });
    // b is merely being vectored along the same track, not established on its localiser
    Object.assign(b, { phase: 'inbound', latMode: 'hdg', established: false, apprCleared: false, tgtAlt: Math.round(b.alt / 100) * 100 });
    sim.advance(3);
    expect(a.phase).toBe('final');
    expect(sim.s.stats.separationViolations).toBe(1);
  });

  it('in trail on the same final: 2.5 NM inside 10 NM', () => {
    const ok = mkSim('ATL', { configName: 'West flow' });
    placeFinal(ok, '27L', 4, { callsign: 'DAL1', airline: 'DAL', landCleared: true });
    placeFinal(ok, '27L', 6.8, { callsign: 'UAL2', landCleared: true });
    ok.advance(5);
    expect(ok.s.stats.separationViolations).toBe(0);
    const bad = mkSim('ATL', { configName: 'West flow' });
    placeFinal(bad, '27L', 5, { callsign: 'DAL1', airline: 'DAL', landCleared: true });
    placeFinal(bad, '27L', 6.5, { callsign: 'UAL2', landCleared: true });
    bad.advance(2);
    expect(bad.s.stats.separationViolations).toBe(1);
    expect(bad.s.alerts.find((x) => x.key.startsWith('sep:'))!.kind).toBe('approach');
  });

  /** heavy leading a medium by 4.5 NM on the 27L final; `level` = both still level at 3000 ft outside the glidepath intercept */
  function wakePair(wakeSeparation: boolean, level: boolean, heavyFirst = true) {
    const sim = mkSim('ATL', { configName: 'West flow' }, { wakeSeparation });
    const d0 = level ? 11 : 5;
    const lead = placeFinal(sim, '27L', d0, { callsign: 'DAL1', airline: 'DAL', type: heavyFirst ? 'B77W' : 'B738', landCleared: true });
    const foll = placeFinal(sim, '27L', d0 + 4.5, { callsign: 'UAL2', type: heavyFirst ? 'B738' : 'B77W', landCleared: true });
    if (level) { lead.alt = foll.alt = 3000; lead.ias = foll.ias = 180; }
    sim.advance(3);
    return sim;
  }

  it('with wake separation on, a medium 4.5 NM behind a heavy on the same final (same level) is a wake violation', () => {
    const sim = wakePair(true, true);
    expect(sim.s.stats.wakeViolations).toBe(1);
    expect(sim.s.stats.separationViolations).toBe(0);
    expect(eventsOf(sim, 'wake')).toHaveLength(1);
    expect(sim.s.alerts.find((x) => x.key.startsWith('sep:'))!.kind).toBe('wake');
    // the same spacing is fine without wake rules, and fine with the heavy behind
    const off = wakePair(false, true);
    expect(off.s.stats.wakeViolations + off.s.stats.separationViolations).toBe(0);
    const rev = wakePair(true, true, false);
    expect(rev.s.stats.wakeViolations + rev.s.stats.separationViolations).toBe(0);
  });

  // ENGINE BUG: in-trail wake (and radar) separation on final is never flagged once both aircraft are on the glidepath.
  // updateSeparation() requires `dv < 950` ft for every violation, but two aircraft on the same 3° glidepath are
  // ~318 ft apart per NM of spacing, so any in-trail spacing above ~2.98 NM is "vertically separated". The 4–8 NM wake
  // minima of wakeMinimum() can therefore never be violated on the glidepath (a B738 3.5 NM behind an A380 passes).
  // Repro: wakeSeparation on, B77W on the 27L ILS at 5 NM, B738 at 9.5 NM (required 5 NM) → no event, no stat.
  // Suspected: separation.ts updateSeparation, `const viol = !exempt && lat < req && dv < 950` applied to kind 'wake'/'approach'.
  it('with wake separation on, a medium 4.5 NM behind a heavy on the glidepath is a wake violation', () => {
    const sim = wakePair(true, false);
    expect(sim.s.stats.wakeViolations).toBe(1);
    expect(eventsOf(sim, 'wake')).toHaveLength(1);
  });
});

describe('wake turbulence tables', () => {
  const cats: WakeCat[] = ['L', 'M', 'H', 'J'];
  it('wakeMinimum (NM in trail)', () => {
    expect(wakeMinimum('J', 'J')).toBe(4);
    expect(wakeMinimum('J', 'H')).toBe(6);
    expect(wakeMinimum('J', 'M')).toBe(7);
    expect(wakeMinimum('J', 'L')).toBe(8);
    expect(wakeMinimum('H', 'H')).toBe(4);
    expect(wakeMinimum('H', 'M')).toBe(5);
    expect(wakeMinimum('H', 'L')).toBe(6);
    expect(wakeMinimum('M', 'L')).toBe(4);
    expect(wakeMinimum('M', 'M')).toBe(3);
    expect(wakeMinimum('M', 'H')).toBe(3);
    expect(wakeMinimum('L', 'L')).toBe(3);
    expect(wakeMinimum('L', 'J')).toBe(3);
  });
  it('wakeDepartureInterval (seconds)', () => {
    expect(wakeDepartureInterval('J', 'J')).toBe(60);
    expect(wakeDepartureInterval('J', 'H')).toBe(180);
    expect(wakeDepartureInterval('J', 'M')).toBe(180);
    expect(wakeDepartureInterval('J', 'L')).toBe(180);
    expect(wakeDepartureInterval('H', 'H')).toBe(60);
    expect(wakeDepartureInterval('H', 'M')).toBe(120);
    expect(wakeDepartureInterval('H', 'L')).toBe(120);
    expect(wakeDepartureInterval('M', 'L')).toBe(120);
    expect(wakeDepartureInterval('M', 'M')).toBe(50);
    expect(wakeDepartureInterval('L', 'H')).toBe(50);
  });
  it('both tables are monotonic: never less than 3 NM / 50 s, heavier leaders and lighter followers need more', () => {
    for (let l = 0; l < 4; l++) for (let f = 0; f < 4; f++) {
      expect(wakeMinimum(cats[l], cats[f])).toBeGreaterThanOrEqual(3);
      expect(wakeDepartureInterval(cats[l], cats[f])).toBeGreaterThanOrEqual(50);
      if (l > 0) expect(wakeMinimum(cats[l], cats[f])).toBeGreaterThanOrEqual(wakeMinimum(cats[l - 1], cats[f]));
      if (f > 0 && f <= l) expect(wakeMinimum(cats[l], cats[f - 1])).toBeGreaterThanOrEqual(wakeMinimum(cats[l], cats[f]));
    }
  });
  it('a departure behind a heavy is refused by the crew until the interval has passed (wake + pilotAssist)', async () => {
    const { placeOnRunway } = await import('./helpers');
    const sim = mkSim('ATL', { configName: 'West flow' }, { wakeSeparation: true });
    const heavy = placeOnRunway(sim, '27R', { callsign: 'DAL1', type: 'B77W' });
    expect(sim.commandText('DAL1 CLEARED TAKEOFF').ok).toBe(true);
    for (let i = 0; i < 100 && heavy.phase !== 'departure'; i++) sim.advance(1);
    const next = placeOnRunway(sim, '27R', { callsign: 'DAL2', type: 'B738' });
    const r = sim.commandText('DAL2 CLEARED TAKEOFF');
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/wake turbulence.*behind the heavy/i);
    const rollStart = sim.s.rwy['09L/27R'].lastDep['27R'].t;
    sim.advance(rollStart + 121 - sim.s.t);
    expect(sim.commandText('DAL2 CLEARED TAKEOFF').ok).toBe(true);
    expect(next.phase).toBe('lined_up');
    expect(sim.s.stats.wakeViolations).toBe(0);
  });
});

describe('TCAS-style resolution', () => {
  /** head-on at the same level, 9 NM apart */
  function headOn(safetyIntervention: boolean) {
    const sim = mkSim('ATL', {}, { safetyIntervention });
    const a = placeAirborne(sim, { callsign: 'DAL1', x: X0, y: Y0, alt: 6000, hdg: 90 });
    const b = placeAirborne(sim, { callsign: 'UAL2', airline: 'UAL', x: X0 + 9 * NM, y: Y0, alt: 6000, hdg: 270 });
    let minDv = Infinity, minLat = Infinity;
    for (let i = 0; i < 120; i++) {
      sim.advance(1);
      const lat = Math.hypot(a.x - b.x, a.y - b.y);
      if (lat < minLat) { minLat = lat; minDv = Math.abs(a.alt - b.alt); }
    }
    return { sim, a, b, minDv, minLat };
  }

  it('with safetyIntervention the crews climb / descend and report it', () => {
    const { sim, a, b, minDv } = headOn(true);
    const ra = eventsOf(sim, 'pilot_action').filter((e) => /TCAS resolution advisory/.test(e.text));
    expect(ra.length).toBeGreaterThanOrEqual(1);
    expect(ra[0].text).toMatch(/pilot safety action/);
    expect(sim.s.radio.filter((m) => /TCAS RA, (climbing|descending)/.test(m.text))).toHaveLength(2 * ra.length);
    expect(minDv).toBeGreaterThan(300); // vertical separation generated by the manoeuvre at the closest point
    expect(a.phase).not.toBe('crashed');
    expect(b.phase).not.toBe('crashed');
    expect(sim.s.stats.collisions).toBe(0);
    // the loss of separation itself is still charged to the controller
    expect(sim.s.stats.separationViolations).toBe(1);
  });

  it('without safetyIntervention there is no resolution: the aircraft stay level and collide', () => {
    const { sim, a, b, minDv } = headOn(false);
    expect(eventsOf(sim, 'pilot_action').filter((e) => /TCAS/.test(e.text))).toHaveLength(0);
    expect(sim.s.radio.filter((m) => /TCAS/.test(m.text))).toHaveLength(0);
    expect(minDv).toBe(0);
    expect(a.flags.raUntil).toBeUndefined();
    expect(sim.s.stats.separationViolations).toBe(1);
    expect(sim.s.stats.nearMisses).toBe(1);
    expect(a.phase).toBe('crashed');
    expect(b.phase).toBe('crashed');
    expect(sim.s.stats.collisions).toBe(1);
  });

  /** B overtakes A on the same track at the same level with ~40 kt of closure */
  function overtake(safetyIntervention: boolean) {
    const sim = mkSim('ATL', {}, { safetyIntervention });
    const a = placeAirborne(sim, { callsign: 'DAL1', x: X0 + 1500, y: Y0, alt: 6000, hdg: 90, ias: 200 });
    const b = placeAirborne(sim, { callsign: 'UAL2', airline: 'UAL', x: X0, y: Y0, alt: 6000, hdg: 90, ias: 240 });
    sim.advance(180);
    return { sim, a, b };
  }

  it('mid-air collision: both aircraft are marked crashed and remain in the aircraft list', () => {
    const { sim, a, b } = overtake(false);
    expect(a.phase).toBe('crashed');
    expect(b.phase).toBe('crashed');
    expect(sim.s.aircraft).toContain(a);
    expect(sim.s.aircraft).toContain(b);
    expect(sim.s.stats.collisions).toBe(1); // one accident involving two aircraft
    const ev = eventsOf(sim, 'collision');
    expect(ev).toHaveLength(2);
    expect(ev[0].text).toMatch(/ACCIDENT: DAL1 collided in mid-air with UAL2/);
    expect(ev[0].sev).toBe('critical');
    expect(sim.s.stats.nearMisses).toBe(1);
    expect(sim.s.over).toBe(false);
    // wrecks do not move, cannot be commanded, and stay in the list
    const pos = [a.x, a.y, b.x, b.y];
    sim.advance(900);
    expect([a.x, a.y, b.x, b.y]).toEqual(pos);
    expect(sim.s.aircraft).toContain(a);
    expect(sim.s.aircraft).toContain(b);
    expect(sim.commandText('DAL1 HEADING 180').message).toMatch(/no longer under your control/);
    expect(sim.s.stats.collisions).toBe(1);
  });

  it('with collisionEnds a mid-air collision ends the scenario', () => {
    const sim = mkSim('ATL', {}, { safetyIntervention: false, collisionEnds: true });
    placeAirborne(sim, { callsign: 'DAL1', x: X0 + 1500, y: Y0, alt: 6000, hdg: 90, ias: 200 });
    placeAirborne(sim, { callsign: 'UAL2', airline: 'UAL', x: X0, y: Y0, alt: 6000, hdg: 90, ias: 240 });
    sim.advance(180);
    expect(sim.s.over).toBe(true);
    expect(sim.s.overReason).toMatch(/Accident/);
    const t = sim.s.t;
    sim.advance(60);
    expect(sim.s.t).toBe(t); // the clock stops
    expect(sim.commandText('DAL1 HEADING 180').message).toMatch(/scenario has ended/i);
  });

  // ENGINE BUG: the TCAS-style safety net never fires for slow-closure geometries. In updateSeparation() the RA is only
  // issued from the *prediction* branch, which is skipped as soon as the pair is already inside the separation minimum
  // (`viol` true), and it needs a predicted miss distance < 0.8 NM at 20 s look-ahead. With 3 NM required separation that
  // is only possible for closure rates above ~400 kt (head-on); an overtake / shallow convergence goes from "violation"
  // straight to a mid-air collision with safetyIntervention enabled.
  // Repro: quiet ATL sim, safetyIntervention true, DAL1 at 6000 ft hdg 090 at 200 kt, UAL2 1500 m behind on the same
  // track and level at 240 kt; advance 180 s → both 'crashed', no "TCAS" event.
  // Suspected: separation.ts updateSeparation (RA logic sits in the `else` of `if (viol)`).
  it('with safetyIntervention a slow-closure collision course is also resolved', () => {
    const { sim, a, b } = overtake(true);
    expect(eventsOf(sim, 'pilot_action').filter((e) => /TCAS/.test(e.text)).length).toBeGreaterThanOrEqual(1);
    expect(a.phase).not.toBe('crashed');
    expect(b.phase).not.toBe('crashed');
    expect(sim.s.stats.collisions).toBe(0);
  });
});
