/** Topics 7, 8, 10: takeoff / landing clearance enforcement and runway occupancy. */
import { describe, expect, it } from 'vitest';
import { endRef, runwayById, runwayZoneAt, rwyLateral } from '../src/sim/airport/query';
import { runwayOccupants, runwayHot } from '../src/sim/ground';
import { typeOf } from '../src/sim/data/aircraft';
import { NM } from '../src/sim/util';
import { atHoldShort, cmd, eventsOf, mkSim, ok, placeFinal, placeOnRunway, until } from './helpers';

const dThr = (sim: ReturnType<typeof mkSim>, ac: { x: number; y: number; rwy?: string }) => {
  const e = endRef(sim.ap, ac.rwy)!;
  return Math.hypot(ac.x - e.end.x, ac.y - e.end.y) / NM;
};

describe('takeoff clearance enforcement', () => {
  it('an aircraft holding short never enters the runway on its own (10 min)', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = atHoldShort(sim, 'B18', '27R', { callsign: 'DAL1426' });
    const { x, y } = ac;
    for (let i = 0; i < 600; i++) {
      sim.advance(1);
      expect(ac.phase).toBe('holding_short');
      expect(runwayZoneAt(sim.ap, ac.x, ac.y)).toBeUndefined();
    }
    expect([ac.x, ac.y]).toEqual([x, y]);
    expect(runwayOccupants(sim, runwayById(sim.ap, '09L/27R')!)).toHaveLength(0);
    expect(sim.s.stats.incursions).toBe(0);
    expect(sim.s.stats.departed).toBe(0);
  });

  it('a lined-up aircraft never rolls without a takeoff clearance (5 min)', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = atHoldShort(sim, 'B18', '27R', { callsign: 'DAL1426' });
    ok(sim, 'DAL1426 LINE UP WAIT 27R');
    until(sim, () => ac.phase === 'lined_up', 200, 'lined up');
    expect(ac.takeoffCleared).toBe(false);
    for (let i = 0; i < 300; i++) {
      sim.advance(1);
      expect(ac.phase).toBe('lined_up');
      expect(ac.gs).toBe(0);
    }
    expect(runwayZoneAt(sim.ap, ac.x, ac.y)?.id).toBe('09L/27R');
    // aligned with the runway
    const e = endRef(sim.ap, '27R')!;
    expect(Math.abs(ac.hdg - e.end.hdg)).toBeLessThan(1);
    expect(rwyLateral(e.rwy, ac.x, ac.y)).toBeLessThan(2);
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    until(sim, () => ac.phase === 'takeoff_roll', 20, 'rolling');
    until(sim, () => ac.phase === 'departure', 120, 'airborne');
  });

  it('TAKEOFF from the hold line implies line-up: the aircraft enters, aligns and rolls', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = atHoldShort(sim, 'B18', '27R', { callsign: 'DAL1426' });
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    expect(ac.phase).toBe('lining_up');
    until(sim, () => ac.phase === 'departure', 300, 'airborne');
    expect(sim.s.stats.departed).toBe(1);
    expect(sim.s.rwy['09L/27R'].lastDep['27R'].ac).toBe(ac.id);
  });

  it('CANCEL TAKEOFF before the roll begins: the aircraft lines up and waits', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = atHoldShort(sim, 'B18', '27R', { callsign: 'DAL1426' });
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    expect(ac.takeoffCleared).toBe(true);
    ok(sim, 'DAL1426 CANCEL TAKEOFF');
    expect(ac.takeoffCleared).toBe(false);
    until(sim, () => ac.phase === 'lined_up', 200, 'lined up');
    sim.advance(180);
    expect(ac.phase).toBe('lined_up');
    expect(ac.gs).toBe(0);
    expect(sim.s.stats.departed).toBe(0);
  });

  it('CANCEL TAKEOFF during the roll below V1: rejected takeoff, aircraft stops and vacates', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeOnRunway(sim, '27R', { callsign: 'DAL1426' });
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    until(sim, () => ac.phase === 'takeoff_roll' && ac.gs > 40, 60, 'rolling');
    const r = sim.commandText('DAL1426 CANCEL TAKEOFF');
    expect(r.ok).toBe(true);
    sim.advance(4);
    expect(ac.phase).toBe('landing_roll'); // decelerating on the runway
    expect(ac.takeoffCleared).toBe(false);
    expect(eventsOf(sim, 'pilot_action').some((e) => /DAL1426 rejected takeoff on runway 27R: takeoff clearance cancelled/.test(e.text))).toBe(true);
    expect(sim.s.radio.some((m) => m.from === 'pilot' && /rejecting takeoff/.test(m.text))).toBe(true);
    let maxGs = 0;
    until(sim, () => ac.phase === 'vacated', 300, 'stopped clear of the runway', () => { maxGs = Math.max(maxGs, ac.gs); expect(ac.alt).toBe(0); });
    expect(maxGs).toBeLessThan(typeOf(ac.type).vr - 12);
    expect(ac.gs).toBe(0);
    expect(ac.request?.type).toBe('taxi');
    expect(ac.request?.text).toMatch(/after rejected takeoff/);
    expect(sim.s.stats.departed).toBe(0);
    expect(ac.kind).toBe('departure');
    // it can be taxied back for another attempt
    expect(sim.commandText('DAL1426 TAXI 27R').ok).toBe(true);
  });

  it('past V1 the crew continues the takeoff', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeOnRunway(sim, '27R', { callsign: 'DAL1426' });
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    until(sim, () => ac.phase === 'takeoff_roll' && ac.ias > typeOf(ac.type).vr - 10, 60, 'fast');
    const r = sim.commandText('DAL1426 CANCEL TAKEOFF');
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/past V1/i);
    until(sim, () => ac.phase === 'departure', 30, 'airborne');
  });

  it('takeoff and line-up are refused when the runway is closed', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = atHoldShort(sim, 'B18', '27R', { callsign: 'DAL1426' });
    expect(sim.commandText('RWY 27R CLOSE').ok).toBe(true);
    expect(sim.s.rwy['09L/27R'].closed).toBe(true);
    for (const text of ['DAL1426 CLEARED TAKEOFF 27R', 'DAL1426 LINE UP WAIT 27R']) {
      const r = sim.commandText(text);
      expect(r.ok).toBe(false);
      expect(r.refused).toBe(true);
      expect(r.message).toMatch(/runway two seven right is closed/i);
    }
    sim.advance(60);
    expect(ac.phase).toBe('holding_short');
    expect(sim.commandText('RWY 27R OPEN').ok).toBe(true);
    expect(sim.commandText('DAL1426 CLEARED TAKEOFF 27R').ok).toBe(true);
  });

  it('takeoff is refused when the runway is occupied ahead', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeOnRunway(sim, '27R', { callsign: 'DAL1426' });
    const blocker = placeOnRunway(sim, '27R', { callsign: 'AAL5', airline: 'AAL', along: 1800, phase: 'vacated', kind: 'arrival' });
    const r = sim.commandText('DAL1426 CLEARED TAKEOFF 27R');
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/traffic on the runway \(AAL5\)/i);
    sim.advance(60);
    expect(ac.phase).toBe('lined_up');
    expect(ac.gs).toBe(0);
    expect(blocker.phase).toBe('vacated');
    // an aircraft behind the departure does not prevent the takeoff
    const s2 = mkSim('ATL', { configName: 'West flow' });
    placeOnRunway(s2, '27R', { callsign: 'DAL1', along: 600 });
    placeOnRunway(s2, '27R', { callsign: 'AAL5', airline: 'AAL', along: 60, phase: 'vacated', kind: 'arrival' });
    expect(s2.commandText('DAL1 CLEARED TAKEOFF 27R').ok).toBe(true);
  });

  it('takeoff / line-up are refused with landing traffic on short final (pilotAssist)', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = atHoldShort(sim, 'B18', '27R', { callsign: 'DAL1426' });
    placeFinal(sim, '27R', 1.5, { callsign: 'UAL9', landCleared: true });
    const r = sim.commandText('DAL1426 LINE UP WAIT 27R');
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/mile final \(UAL9\)/i);
    sim.advance(10);
    expect(ac.phase).toBe('holding_short');
  });

  it('if the crew does roll with an obstruction ahead they reject the takeoff below V1 (pilot safety action)', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeOnRunway(sim, '27R', { callsign: 'DAL1426' });
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    until(sim, () => ac.phase === 'takeoff_roll' && ac.gs > 30, 60, 'rolling');
    placeOnRunway(sim, '27R', { callsign: 'AAL5', airline: 'AAL', along: (ac.rwyDist ?? 0) + 1500, phase: 'vacated', kind: 'arrival' });
    until(sim, () => ac.phase !== 'takeoff_roll', 10, 'reaction');
    expect(ac.phase).toBe('landing_roll');
    expect(eventsOf(sim, 'pilot_action').some((e) => /rejected takeoff.*traffic on the runway/.test(e.text))).toBe(true);
    sim.advance(120);
    expect(sim.s.stats.collisions).toBe(0);
    expect(sim.s.stats.departed).toBe(0);
  });
});

describe('landing clearance enforcement', () => {
  it('an established aircraft without a landing clearance goes around by itself at about 1 NM', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeFinal(sim, '27L', 6, { callsign: 'UAL892' });
    sim.advance(2);
    expect(ac.request?.type ?? 'landing').toBe('landing');
    let minD = Infinity, minAlt = Infinity;
    until(sim, () => ac.phase === 'go_around', 400, 'go-around', () => { if (ac.phase === 'final') { minD = Math.min(minD, dThr(sim, ac)); minAlt = Math.min(minAlt, ac.alt); } });
    expect(minD).toBeGreaterThan(0.9);
    expect(minD).toBeLessThan(1.1);
    expect(minAlt).toBeGreaterThan(250); // never descended to the runway
    expect(ac.goArounds).toBe(1);
    expect(sim.s.stats.goArounds).toBe(1);
    expect(sim.s.stats.pilotGoArounds).toBe(1);
    const ev = eventsOf(sim, 'go_around');
    expect(ev).toHaveLength(1);
    expect(ev[0].text).toMatch(/UAL892 going around – no landing clearance/);
    expect(ev[0].sev).toBe('warning'); // pilot-initiated
    expect(sim.s.radio.some((m) => m.from === 'pilot' && /going around, no landing clearance/.test(m.text))).toBe(true);
    until(sim, () => ac.phase === 'inbound', 200, 'missed approach complete', () => expect(ac.alt).toBeGreaterThan(250));
    expect(ac.request?.type).toBe('approach');
    expect(sim.s.stats.landed).toBe(0);
    expect(sim.s.stats.incursions).toBe(0);
    expect(ac.landedAt).toBeUndefined();
  });

  it('with a landing clearance it lands – on the assigned runway only', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeFinal(sim, '27L', 6, { callsign: 'UAL892' });
    ok(sim, 'UAL892 CLEARED LAND 27L');
    expect(ac.request).toBeUndefined();
    until(sim, () => ac.phase === 'landing_roll', 400, 'touchdown');
    const e = endRef(sim.ap, '27L')!;
    expect(runwayZoneAt(sim.ap, ac.x, ac.y)?.id).toBe('09R/27L');
    expect(rwyLateral(e.rwy, ac.x, ac.y)).toBeLessThan(1);
    expect(ac.rwyDist).toBeGreaterThan(100); // touchdown zone, past the threshold
    expect(ac.rwyDist).toBeLessThan(700);
    expect(ac.goArounds).toBe(0);
    expect(sim.s.stats.landed).toBe(1);
    expect(sim.s.rwy['09R/27L'].lastArr['27L'].ac).toBe(ac.id);
    for (const r of sim.ap.runways) if (r.id !== '09R/27L') { expect(sim.s.rwy[r.id].lastArr).toEqual({}); expect(sim.s.rwy[r.id].movements).toBe(0); }
    expect(eventsOf(sim, 'landing').map((x) => x.text)).toEqual(['UAL892 landed runway 27L']);
    expect(sim.s.stats.incursions).toBe(0);
    until(sim, () => ac.phase === 'vacated', 200, 'vacated');
    expect(runwayZoneAt(sim.ap, ac.x, ac.y)).toBeUndefined();
  });

  it('a landing clearance cannot be given for a different runway than the approach', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeFinal(sim, '27L', 6, { callsign: 'UAL892' });
    const r = sim.commandText('UAL892 CLEARED LAND 26R');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/on the approach to runway 27L, not 26R/);
    expect(ac.landCleared).toBe(false);
  });

  it('goes around when the runway is occupied, even with a landing clearance', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeFinal(sim, '27L', 4, { callsign: 'UAL892', landCleared: true });
    placeOnRunway(sim, '27L', { callsign: 'DAL7' }); // lined up and waiting on the same runway
    let minD = Infinity;
    until(sim, () => ac.phase === 'go_around', 300, 'go-around', () => { if (ac.phase === 'final') minD = Math.min(minD, dThr(sim, ac)); });
    expect(minD).toBeLessThan(0.5);
    expect(minD).toBeGreaterThan(0.2);
    expect(eventsOf(sim, 'go_around')[0].text).toMatch(/traffic on the runway/);
    expect(sim.s.stats.pilotGoArounds).toBe(1);
    expect(sim.s.stats.landed).toBe(0);
    expect(sim.s.stats.collisions).toBe(0);
    // the controller was warned beforehand
    expect(eventsOf(sim, 'incursion')).toHaveLength(0);
  });

  it('goes around when the runway has been closed', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeFinal(sim, '27L', 4, { callsign: 'UAL892', landCleared: true });
    sim.setRunwayClosed('27L', true, 'test');
    until(sim, () => ac.phase === 'go_around', 300, 'go-around');
    expect(eventsOf(sim, 'go_around')[0].text).toMatch(/runway closed/);
    expect(sim.s.stats.landed).toBe(0);
  });

  it('GO AROUND from the controller is not counted as a pilot go-around', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeFinal(sim, '27L', 4, { callsign: 'UAL892', landCleared: true });
    ok(sim, 'UAL892 GO AROUND');
    expect(ac.phase).toBe('go_around');
    expect(ac.landCleared).toBe(false);
    expect(sim.s.stats.goArounds).toBe(1);
    expect(sim.s.stats.pilotGoArounds).toBe(0);
    expect(ac.tgtAlt).toBe(3000);
    sim.advance(60);
    expect(ac.alt).toBeGreaterThan(1500);
  });

  it('a vector cancels the approach and landing clearances', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = placeFinal(sim, '27L', 8, { callsign: 'UAL892', landCleared: true });
    ok(sim, 'UAL892 HEADING 360');
    expect(ac.phase).toBe('inbound');
    expect(ac.apprCleared).toBe(false);
    expect(ac.landCleared).toBe(false);
    sim.advance(400);
    expect(sim.s.stats.landed).toBe(0);
  });
});

describe('runway occupancy', () => {
  it('runwayZoneAt / runwayOccupants report aircraft lined up or rolling, and nothing else', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const r27r = runwayById(sim.ap, '09L/27R')!;
    const r26l = runwayById(sim.ap, '08R/26L')!;
    expect(runwayOccupants(sim, r27r)).toEqual([]);
    const lined = placeOnRunway(sim, '27R', { callsign: 'DAL1' });
    const fin = placeFinal(sim, '27R', 5, { callsign: 'UAL2' }); // airborne: not an occupant
    expect(runwayZoneAt(sim.ap, lined.x, lined.y)?.id).toBe('09L/27R');
    expect(runwayOccupants(sim, r27r)).toEqual([lined]);
    expect(runwayOccupants(sim, r27r, lined)).toEqual([]);
    expect(runwayOccupants(sim, r26l)).toEqual([]);
    expect(runwayHot(sim, r27r)).toBeUndefined(); // lined up without takeoff clearance, final still 5 NM out
    ok(sim, 'DAL1 CLEARED TAKEOFF 27R');
    expect(runwayHot(sim, r27r)).toBe(lined);
    until(sim, () => lined.phase === 'takeoff_roll', 20, 'rolling');
    expect(runwayOccupants(sim, r27r)).toEqual([lined]);
    expect(runwayHot(sim, r27r)).toBe(lined);
    until(sim, () => lined.phase === 'departure', 120, 'airborne');
    sim.advance(1);
    expect(runwayOccupants(sim, r27r)).toEqual([]);
    expect(fin.phase).not.toBe('landing_roll');
  });

  it('zone geometry: hold lines are outside, the centreline is inside, both ends included', () => {
    const sim = mkSim('ATL');
    for (const r of sim.ap.runways) {
      for (const n of r.nodes) expect(runwayZoneAt(sim.ap, sim.ap.nodes[n].x, sim.ap.nodes[n].y)?.id).toBe(r.id);
      for (const n of sim.ap.nodes) if (n.kind === 'hold' && n.rwy === r.id) expect(runwayZoneAt(sim.ap, n.x, n.y)?.id).not.toBe(r.id);
    }
  });

  it('a holding-short aircraft is not an occupant; a lining-up aircraft becomes one', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = atHoldShort(sim, 'B18', '27R', { callsign: 'DAL1426' });
    const r = runwayById(sim.ap, '09L/27R')!;
    expect(runwayOccupants(sim, r)).toEqual([]);
    ok(sim, 'DAL1426 LINE UP WAIT 27R');
    until(sim, () => runwayOccupants(sim, r).includes(ac), 60, 'entered the runway');
    expect(ac.phase).toBe('lining_up');
    expect(ac.lineUpCleared).toBe(true);
    expect(sim.s.stats.incursions).toBe(0);
  });

  it('a runway incursion is raised when an aircraft is rolling with another on the runway ahead', () => {
    const sim = mkSim('ATL', { configName: 'West flow' }, { pilotAssist: false });
    const roller = placeOnRunway(sim, '27R', { callsign: 'DAL1', type: 'B77W', along: 900, phase: 'takeoff_roll', gs: 149, takeoffCleared: true }); // above V1: committed
    const other = placeOnRunway(sim, '27R', { callsign: 'AAL2', airline: 'AAL', along: 2600, phase: 'vacated', kind: 'arrival' });
    sim.advance(1);
    expect(sim.s.stats.incursions).toBe(1);
    const ev = eventsOf(sim, 'incursion');
    expect(ev).toHaveLength(1);
    expect(ev[0].sev).toBe('critical');
    expect(ev[0].text).toMatch(/RUNWAY INCURSION 09L\/27R: DAL1 departing with AAL2 on the runway/);
    expect(ev[0].ac).toEqual([roller.id, other.id]);
    expect(sim.s.alerts.some((a) => a.kind === 'runway' && a.level === 'critical' && a.ac.includes(roller.id) && a.ac.includes(other.id))).toBe(true);
    expect(sim.s.stats.safetyPenalty).toBeGreaterThanOrEqual(14);
    sim.advance(5);
    expect(sim.s.stats.incursions).toBe(1); // one event per occurrence, not one per second
  });

  it('a landing roll-out with another aircraft on the runway ahead is also an incursion', () => {
    const sim = mkSim('ATL', { configName: 'West flow' }, { pilotAssist: false });
    const lander = placeOnRunway(sim, '27L', { callsign: 'UAL1', airline: 'UAL', along: 400, phase: 'landing_roll', gs: 120, kind: 'arrival' });
    lander.landCleared = true;
    placeOnRunway(sim, '27L', { callsign: 'AAL2', airline: 'AAL', along: 2200, phase: 'vacated', kind: 'arrival' });
    sim.advance(1);
    expect(sim.s.stats.incursions).toBe(1);
    expect(eventsOf(sim, 'incursion')[0].text).toMatch(/UAL1 landing with AAL2 on the runway/);
  });

  it('no incursion for an aircraft behind the roller or on another runway', () => {
    const sim = mkSim('ATL', { configName: 'West flow' }, { pilotAssist: false });
    placeOnRunway(sim, '27R', { callsign: 'DAL1', along: 1500, phase: 'takeoff_roll', gs: 142, takeoffCleared: true });
    placeOnRunway(sim, '27R', { callsign: 'AAL2', airline: 'AAL', along: 60 }); // lined up behind
    placeOnRunway(sim, '26L', { callsign: 'AAL3', airline: 'AAL', along: 1500 });
    sim.advance(3);
    expect(sim.s.stats.incursions).toBe(0);
    expect(cmd).toBeDefined();
  });
});
