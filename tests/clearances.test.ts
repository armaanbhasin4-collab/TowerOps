/** Topics 1 + 3: aircraft state machine, invalid transitions, pushback authorisation. */
import { describe, expect, it } from 'vitest';
import type { Aircraft, Phase } from '../src/sim/types';
import { spawnArrival, spawnParked, gateUser, gateOccupied } from '../src/sim/traffic';
import { endRef, gateByName, runwayZoneAt } from '../src/sim/airport/query';
import { NM, vecOf } from '../src/sim/util';
import { Sim } from '../src/sim/sim';
import { cmd, eventsOf, mkSim, ok, placeFinal, pushedBack, readyDeparture, until } from './helpers';

/** record every distinct phase an aircraft passes through */
function phaseRecorder(ac: Aircraft) {
  const seen: Phase[] = [ac.phase];
  return { seen, tick: () => { if (seen[seen.length - 1] !== ac.phase) seen.push(ac.phase); } };
}
const rejected = (sim: Sim, text: string, re: RegExp) => {
  const r = sim.commandText(text);
  expect(r.ok, `"${text}" should be rejected`).toBe(false);
  expect(r.refused ?? false, `"${text}" should fail validation, not be a pilot refusal`).toBe(false);
  expect(r.message ?? '').toMatch(re);
};

describe('departure state machine', () => {
  const sim = mkSim('ATL', { configName: 'West flow' });
  const ac = readyDeparture(sim, 'B18', { callsign: 'DAL1426' });
  const rec = phaseRecorder(ac);
  const run = (cond: () => boolean, max: number, label: string) => until(sim, cond, max, label, rec.tick);

  it('parked → pushback → push_done → taxi_out → holding_short → lining_up → lined_up → takeoff_roll → departure', () => {
    expect(ac.phase).toBe('parked');
    expect(ac.request?.type).toBe('clearance');
    ok(sim, 'DAL1426 CLEARED AS FILED');
    ok(sim, 'DAL1426 PUSHBACK APPROVED');
    rec.tick();
    run(() => ac.phase === 'push_done', 300, 'push_done');
    expect(ac.request?.type).toBe('taxi');
    ok(sim, 'DAL1426 TAXI 27R');
    rec.tick();
    run(() => ac.phase === 'holding_short', 1200, 'holding_short');
    expect(ac.request?.type).toBe('takeoff');
    ok(sim, 'DAL1426 LINE UP WAIT 27R');
    rec.tick();
    run(() => ac.phase === 'lined_up', 200, 'lined_up');
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    run(() => ac.phase === 'departure', 200, 'airborne');
    expect(rec.seen).toEqual(['parked', 'pushback', 'push_done', 'taxi_out', 'holding_short', 'lining_up', 'lined_up', 'takeoff_roll', 'departure']);
  });

  it('logs pushback and takeoff events and counts the departure', () => {
    expect(eventsOf(sim, 'pushback').some((e) => e.text.includes('DAL1426'))).toBe(true);
    expect(eventsOf(sim, 'takeoff').some((e) => e.text.includes('DAL1426') && e.text.includes('27R'))).toBe(true);
    expect(sim.s.stats.departed).toBe(1);
    expect(ac.airborneAt).toBeGreaterThan(0);
  });

  it('leaves the simulation ("gone") after climbing out of the airspace', () => {
    ok(sim, `DAL1426 CLIMB 14000, DIRECT ${ac.depFix}`);
    run(() => ac.phase === 'gone', 1500, 'gone');
    expect(rec.seen[rec.seen.length - 1]).toBe('gone');
    expect(sim.s.stats.improperExits).toBe(0);
  });
});

describe('arrival state machine', () => {
  const sim = mkSim('ATL', { configName: 'West flow' });
  const ac = spawnArrival(sim, { airline: 'UAL', type: 'B738', callsign: 'UAL892', fix: 'LOGEN', distNm: 20, alt: 5000 })!;
  const rec = phaseRecorder(ac);
  const run = (cond: () => boolean, max: number, label: string) => until(sim, cond, max, label, rec.tick);

  it('inbound → approach → final → landing_roll → vacated → taxi_in → parked', () => {
    expect(ac.phase).toBe('inbound');
    // put the aircraft on a 30° intercept for 26R, 13 NM out, 2 NM north of the centreline
    const e = endRef(sim.ap, '26R')!;
    const [ux, uy] = vecOf(e.end.hdg);
    ac.x = e.end.x - ux * 13 * NM; ac.y = e.end.y - uy * 13 * NM + 2 * NM;
    ac.alt = ac.tgtAlt = 3000; ac.ias = 190; ac.hdg = ac.tgtHdg = 240; ac.latMode = 'hdg';
    ok(sim, 'UAL892 CLEARED ILS 26R');
    rec.tick();
    expect(ac.phase).toBe('approach');
    run(() => ac.phase === 'final', 300, 'established');
    expect(ac.established).toBe(true);
    expect(ac.request?.type).toBe('landing');
    ok(sim, 'UAL892 CLEARED LAND 26R');
    run(() => ac.phase === 'landing_roll', 600, 'touchdown');
    run(() => ac.phase === 'vacated', 300, 'vacated');
    expect(ac.request?.type).toBe('taxi_in');
    ok(sim, 'UAL892 TAXI GATE C12');
    rec.tick();
    until(sim, () => ac.phase === 'parked', 1500, 'parked', () => {
      rec.tick();
      if (ac.request?.type === 'crossing' && !ac.flags.pending) sim.commandText('UAL892 CROSS 26L');
    });
    expect(rec.seen).toEqual(['inbound', 'approach', 'final', 'landing_roll', 'vacated', 'taxi_in', 'parked']);
    expect(ac.gate).toBe('C12');
    const g = gateByName(sim.ap, 'C12')!;
    expect(Math.hypot(ac.x - sim.ap.nodes[g.node].x, ac.y - sim.ap.nodes[g.node].y)).toBeLessThan(2);
    expect(sim.s.stats.landed).toBe(1);
    expect(sim.s.stats.parked).toBe(1);
  });

  it('go-around: final → go_around → inbound', () => {
    const b = placeFinal(sim, '27L', 5, { callsign: 'SWA77', airline: 'SWA' });
    const r = phaseRecorder(b);
    ok(sim, 'SWA77 GO AROUND');
    r.tick();
    until(sim, () => b.phase === 'inbound', 200, 'back to inbound', r.tick);
    expect(r.seen).toEqual(['final', 'go_around', 'inbound']);
    expect(b.apprCleared).toBe(false);
    expect(b.goArounds).toBe(1);
    expect(b.request?.type).toBe('approach');
  });
});

describe('invalid transitions are rejected with a useful message', () => {
  const sim = mkSim('ATL', { configName: 'West flow' });
  const parked = readyDeparture(sim, 'B18', { callsign: 'DAL1' });
  const turning = spawnParked(sim, 'B20', { airline: 'DAL', type: 'B738', callsign: 'DAL2', readyIn: 5000 })!;
  const inbound = spawnArrival(sim, { airline: 'UAL', type: 'B738', callsign: 'UAL3', fix: 'LOGEN', distNm: 20, alt: 8000 })!;
  const fin = placeFinal(sim, '27L', 8, { callsign: 'SWA4', airline: 'SWA' });

  it('parked aircraft: TAKEOFF, LINE UP, TAXI, CROSS, airborne instructions', () => {
    rejected(sim, 'DAL1 CLEARED TAKEOFF 27R', /not at the runway \(parked\)/i);
    rejected(sim, 'DAL1 LINE UP WAIT 27R', /not at the runway/i);
    rejected(sim, 'DAL1 TAXI 27R', /still on stand.*pushback first/i);
    rejected(sim, 'DAL1 CROSS 26L', /not taxiing/i);
    rejected(sim, 'DAL1 HEADING 240', /on the ground/i);
    rejected(sim, 'DAL1 CLEARED ILS 27L', /not an airborne arrival/i);
    rejected(sim, 'DAL1 CLEARED LAND', /not an airborne arrival/i);
    rejected(sim, 'DAL1 GO AROUND', /not on approach/i);
    rejected(sim, 'DAL1 HOLD POSITION', /not moving on the surface/i);
    rejected(sim, 'DAL1 CONTACT DEPARTURE', /not an airborne departure/i);
    rejected(sim, 'DAL1 TOW', /stationary on a taxiway/i);
    expect(parked.phase).toBe('parked');
  });
  it('pushback before the departure clearance, and before the turnaround is complete', () => {
    rejected(sim, 'DAL1 PUSHBACK APPROVED', /needs its departure clearance before pushback/i);
    expect(turning.callsign).not.toBe('DAL2'); // still the inbound flight number until ready
    const r = sim.command(turning, [{ t: 'PUSHBACK' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/has not finished its turnaround/i);
    const r2 = sim.command(turning, [{ t: 'DEP_CLEARANCE' }]);
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/not ready for a departure clearance/i);
  });
  it('a duplicate departure clearance / pushback approval is rejected', () => {
    ok(sim, 'DAL1 CLEARED AS FILED');
    rejected(sim, 'DAL1 CLEARED AS FILED', /already has its departure clearance/i);
    ok(sim, 'DAL1 PUSHBACK APPROVED');
    rejected(sim, 'DAL1 PUSHBACK APPROVED', /not parked at a gate/i);
    rejected(sim, 'DAL1 TAXI 27R', /still pushing back/i);
    rejected(sim, 'DAL1 CLEARED TAKEOFF', /not at the runway \(pushback\)/i);
  });
  it('TAKEOFF / LINE UP while still far from the runway', () => {
    until(sim, () => parked.phase === 'push_done', 300, 'pushed');
    rejected(sim, 'DAL1 CLEARED TAKEOFF 27R', /not at the runway/i);
    ok(sim, 'DAL1 TAXI 27R');
    rejected(sim, 'DAL1 CLEARED TAKEOFF 27R', /has not reached the runway 27R holding point yet/i);
    rejected(sim, 'DAL1 LINE UP WAIT 26L', /taxiing to runway 27R, not 26L/i);
    rejected(sim, 'DAL1 TAXI GATE B18', /is a departure/i);
    rejected(sim, 'DAL1 CANCEL TAKEOFF', /no takeoff clearance to cancel/i);
    rejected(sim, 'DAL1 CONTINUE TAXI', /was not told to hold position/i);
  });
  it('inbound arrival: LAND before approach clearance, GO AROUND, ground instructions', () => {
    rejected(sim, 'UAL3 CLEARED LAND 26R', /has not been cleared for an approach yet/i);
    rejected(sim, 'UAL3 GO AROUND', /not on approach/i);
    rejected(sim, 'UAL3 TAXI GATE C12', /cannot taxi now \(inbound\)/i);
    rejected(sim, 'UAL3 PUSHBACK APPROVED', /not parked at a gate/i);
    rejected(sim, 'UAL3 CLEARED TAKEOFF', /not a departure/i);
    rejected(sim, 'UAL3 LINE UP WAIT', /not a departure/i);
    rejected(sim, 'UAL3 CONTACT CENTER', /not an airborne departure/i);
    rejected(sim, 'UAL3 HOLD POSITION', /airborne/i);
    expect(inbound.phase).toBe('inbound');
    expect(inbound.landCleared).toBe(false);
  });
  it('established arrival: landing clearance for the wrong runway, duplicate clearance, runway change', () => {
    rejected(sim, 'SWA4 CLEARED LAND 26R', /on the approach to runway 27L, not 26R/i);
    rejected(sim, 'SWA4 EXPECT 26R', /already on approach/i);
    ok(sim, 'SWA4 CLEARED LAND 27L');
    expect(fin.landCleared).toBe(true);
    rejected(sim, 'SWA4 CLEARED LAND 27L', /already cleared to land/i);
  });
  it('approach + landing clearance may be combined in one transmission', () => {
    ok(sim, 'UAL3 CLEARED ILS 26R, CLEARED LAND 26R');
    expect(inbound.phase).toBe('approach');
    expect(inbound.landCleared).toBe(true);
  });
  it('aircraft that left the simulation or were handed off cannot be commanded', () => {
    const s2 = mkSim('ATL');
    const a = placeFinal(s2, '27L', 6, { callsign: 'AAL9', airline: 'AAL' });
    a.handedOff = true;
    expect(s2.commandText('AAL9 GO AROUND').message).toMatch(/handed off/i);
    a.handedOff = false;
    a.phase = 'crashed';
    expect(s2.commandText('AAL9 GO AROUND').message).toMatch(/no longer under your control/i);
    a.phase = 'disabled';
    expect(s2.commandText('AAL9 GO AROUND').message).toMatch(/disabled/i);
  });
});

describe('pushback authorisation', () => {
  it('without approval the aircraft stays on stand indefinitely (15 min), re-requesting but never moving', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = readyDeparture(sim, 'B18', { callsign: 'DAL1426' });
    cmd(sim, ac, { t: 'DEP_CLEARANCE' });
    const { x, y, hdg } = ac;
    let requested = false;
    for (let i = 0; i < 900; i++) {
      sim.advance(1);
      requested ||= ac.request?.type === 'pushback';
      expect(ac.phase).toBe('parked');
      expect(ac.gs).toBe(0);
    }
    expect(requested).toBe(true);
    expect([ac.x, ac.y, ac.hdg]).toEqual([x, y, hdg]);
    expect(ac.pushApproved).toBe(false);
    expect(ac.gate).toBe('B18');
    expect(gateOccupied(sim, 'B18')).toBe(true);
    expect(eventsOf(sim, 'pushback')).toHaveLength(0);
    // the crew keeps reminding the controller on the radio
    expect(sim.s.radio.some((m) => m.from === 'pilot' && /still ready for pushback/.test(m.text))).toBe(true);
  });

  it('an aircraft that never receives its departure clearance never asks for pushback', () => {
    const sim = mkSim('ATL');
    const ac = readyDeparture(sim, 'B18');
    for (let i = 0; i < 600; i++) { sim.advance(1); expect(ac.request?.type ?? 'clearance').toBe('clearance'); }
    expect(ac.phase).toBe('parked');
  });

  it('moves tail-first once approved and frees the gate afterwards', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    const ac = readyDeparture(sim, 'B18', { callsign: 'DAL1426' });
    cmd(sim, ac, { t: 'DEP_CLEARANCE' });
    const g = gateByName(sim.ap, 'B18')!;
    const start = { x: ac.x, y: ac.y };
    const r = sim.commandText('DAL1426 PUSHBACK APPROVED');
    expect(r.ok).toBe(true);
    // nothing happens until the readback
    expect(ac.phase).toBe('parked');
    sim.advance(4);
    expect(ac.phase).toBe('pushback');
    expect(ac.reverse).toBe(true);
    expect(ac.pushApproved).toBe(true);
    let moved = 0, backwards = 0, maxGs = 0;
    while (ac.phase === 'pushback' && sim.s.t < 400) {
      const px = ac.x, py = ac.y;
      sim.advance(0.1);
      const dx = ac.x - px, dy = ac.y - py;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) {
        moved++;
        const [ux, uy] = vecOf(ac.hdg);
        if (dx * ux + dy * uy < 0) backwards++;
      }
      maxGs = Math.max(maxGs, ac.gs);
    }
    expect(ac.phase).toBe('push_done');
    expect(moved).toBeGreaterThan(100);
    expect(backwards / moved).toBeGreaterThan(0.97); // the tail leads throughout the push
    expect(maxGs).toBeLessThan(5); // tug speed
    expect(Math.hypot(ac.x - start.x, ac.y - start.y)).toBeGreaterThan(40);
    expect(runwayZoneAt(sim.ap, ac.x, ac.y)).toBeUndefined();
    // off the stand: gate released
    expect(ac.gate).toBeUndefined();
    expect(ac.reverse).toBe(false);
    expect(gateUser(sim, 'B18')).toBeUndefined();
    expect(gateOccupied(sim, 'B18')).toBe(false);
    expect(Math.hypot(ac.x - sim.ap.nodes[g.node].x, ac.y - sim.ap.nodes[g.node].y)).toBeGreaterThan(40);
    // another aircraft can now be assigned the stand
    const arr = placeFinal(sim, '26R', 8, { callsign: 'UAL5' });
    expect(sim.commandText('UAL5 GATE B18').ok).toBe(true);
  });

  it('the gate stays occupied while the aircraft is still on it at the start of the push', () => {
    const sim = mkSim('ATL');
    const ac = readyDeparture(sim, 'B18', { callsign: 'DAL1426' });
    cmd(sim, ac, { t: 'DEP_CLEARANCE' }, { t: 'PUSHBACK' });
    expect(ac.phase).toBe('pushback');
    expect(gateOccupied(sim, 'B18')).toBe(true);
    const arr = placeFinal(sim, '26R', 8, { callsign: 'UAL5' });
    const r = sim.commandText('UAL5 GATE B18');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/gate B18 is occupied by DAL1426/i);
    expect(arr.gate).toBeUndefined();
  });

  it('after pushback the aircraft waits for taxi instructions (10 min) without moving', () => {
    const sim = mkSim('ATL');
    const ac = pushedBack(sim, 'B18');
    const { x, y } = ac;
    for (let i = 0; i < 600; i++) { sim.advance(1); expect(ac.phase).toBe('push_done'); }
    expect([ac.x, ac.y]).toEqual([x, y]);
    expect(ac.request?.type).toBe('taxi');
  });
});
