/** Topics 12 + 13: gate compatibility / occupancy and aircraft turnaround. */
import { describe, expect, it } from 'vitest';
import type { TurnStage } from '../src/sim/types';
import { gateOccupied, gateOptions, gateUser, spawnParked } from '../src/sim/traffic';
import { gateByName } from '../src/sim/airport/query';
import { sizeFits, typeOf } from '../src/sim/data/aircraft';
import { cmd, eventsOf, mkSim, ok, placeFinal, placeOnRoute, routeVia, until } from './helpers';

/** an arrival standing on taxiway L abeam the ramp, waiting for taxi instructions */
function vacated(sim: ReturnType<typeof mkSim>, type: string, callsign: string, x0 = -800) {
  const x1 = x0 === -800 ? -638 : x0 === -1300 ? -938 : -1300;
  return placeOnRoute(sim, routeVia(sim, [[x0, 10], [x1, 10]]), { kind: 'arrival', phase: 'vacated', type, callsign, airline: callsign.slice(0, 3), startS: 30 });
}

describe('gate compatibility', () => {
  const sim = mkSim('ATL', { configName: 'West flow' });
  const b77w = vacated(sim, 'B77W', 'BAW1');
  const a388 = vacated(sim, 'A388', 'UAE2', -1300);

  it('the test gates have the expected size classes', () => {
    expect(gateByName(sim.ap, 'B18')!.size).toBe('M');
    expect(gateByName(sim.ap, 'A7')!.size).toBe('L');
    expect(gateByName(sim.ap, 'E3')!.size).toBe('XL');
    expect(typeOf('B77W').size).toBe('XL');
    expect(typeOf('A388').size).toBe('XL');
  });

  it.each([['BAW1', 'Boeing 777-300ER'], ['UAE2', 'Airbus A380-800']])('%s (%s) is refused at an M gate and an L gate with a clear message', (cs, name) => {
    for (const gate of ['B18', 'A7']) {
      for (const text of [`${cs} TAXI GATE ${gate}`, `${cs} GATE ${gate}`]) {
        const r = sim.commandText(text);
        expect(r.ok, text).toBe(false);
        expect(r.message, text).toBe(`Gate ${gate} is too small for the ${name}.`);
      }
    }
    expect(b77w.gate).toBeUndefined();
    expect(a388.gate).toBeUndefined();
    expect(b77w.phase).toBe('vacated');
  });

  it('both are accepted at XL gates and park there', () => {
    ok(sim, 'BAW1 TAXI GATE E3');
    expect(b77w.phase).toBe('taxi_in');
    expect(b77w.gate).toBe('E3');
    until(sim, () => b77w.phase === 'parked', 900, 'B77W parked');
    ok(sim, 'UAE2 TAXI GATE F4');
    until(sim, () => a388.phase === 'parked', 1200, 'A388 parked');
    expect(a388.gate).toBe('F4');
    expect(sim.s.stats.collisions).toBe(0);
  });

  it('smaller aircraft may use larger gates; sizeFits is a total order S < M < L < XL', () => {
    const order = ['S', 'M', 'L', 'XL'] as const;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) expect(sizeFits(order[i], order[j])).toBe(i <= j);
    const e75 = vacated(sim, 'E75L', 'RPA3', -1830);
    expect(sim.commandText('RPA3 TAXI GATE E9').ok).toBe(true);
    expect(e75.kind).toBe('arrival');
  });

  it('spawnParked itself never puts an oversize aircraft on a small stand when choosing the flight', () => {
    const s2 = mkSim('ATL', { seed: 7 });
    for (const g of s2.ap.gates) {
      const ac = spawnParked(s2, g.name);
      if (ac) expect(sizeFits(typeOf(ac.type).size, g.size), `${ac.type} at ${g.name} (${g.size})`).toBe(true);
    }
    expect(s2.s.aircraft.length).toBeGreaterThan(100);
  });
});

describe('gate occupancy', () => {
  it('taxi to an occupied gate is refused', () => {
    const sim = mkSim('ATL');
    const parked = spawnParked(sim, 'C12', { airline: 'SWA', type: 'B737', readyIn: 5000 })!;
    vacated(sim, 'B738', 'UAL1');
    expect(gateOccupied(sim, 'C12')).toBe(true);
    for (const text of ['UAL1 TAXI GATE C12', 'UAL1 GATE C12']) {
      const r = sim.commandText(text);
      expect(r.ok).toBe(false);
      expect(r.message).toBe(`Gate C12 is occupied by ${parked.callsign}.`);
    }
    expect(spawnParked(sim, 'C12', { airline: 'DAL', type: 'A320' })).toBeUndefined();
  });

  it('taxi to a gate reserved for another inbound aircraft is refused', () => {
    const sim = mkSim('ATL');
    const first = placeFinal(sim, '26R', 9, { callsign: 'DAL7', airline: 'DAL' });
    ok(sim, 'DAL7 GATE C12');
    expect(first.gate).toBe('C12');
    expect(gateUser(sim, 'C12')).toBe(first);
    expect(gateOccupied(sim, 'C12')).toBe(false); // reserved, not physically occupied
    vacated(sim, 'B738', 'UAL1');
    const r = sim.commandText('UAL1 TAXI GATE C12');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Gate C12 is assigned to DAL7.');
    // the holder of the reservation can of course use it, and may be re-assigned to free it
    ok(sim, 'DAL7 GATE C14');
    expect(gateUser(sim, 'C12')).toBeUndefined();
    expect(sim.commandText('UAL1 TAXI GATE C12').ok).toBe(true);
  });

  it('after parking the gate is occupied; gateOptions never offers occupied, reserved or undersized gates', () => {
    const sim = mkSim('ATL');
    const a = vacated(sim, 'B738', 'UAL1');
    const before = gateOptions(sim, a).map((g) => g.name);
    expect(before).toContain('C12');
    ok(sim, 'UAL1 TAXI GATE C12');
    // reserved while taxiing in
    const b = vacated(sim, 'B738', 'DAL2', -1300);
    expect(gateOptions(sim, b).map((g) => g.name)).not.toContain('C12');
    expect(gateOptions(sim, a).map((g) => g.name)).toContain('C12'); // still an option for its own holder
    until(sim, () => a.phase === 'parked', 900, 'parked');
    expect(a.gate).toBe('C12');
    expect(gateOccupied(sim, 'C12')).toBe(true);
    expect(gateUser(sim, 'C12')).toBe(a);
    expect(eventsOf(sim, 'gate').some((e) => e.text === 'UAL1 on stand C12')).toBe(true);
    // fill a few more stands and check the option list against every aircraft type
    for (const g of ['C10', 'C14', 'E3', 'E4', 'A7']) spawnParked(sim, g, { airline: 'DAL', type: g.startsWith('E') ? 'B77W' : 'B738', readyIn: 5000 });
    const taken = new Set(sim.s.aircraft.filter((x) => x.gate).map((x) => x.gate));
    expect(taken.size).toBe(6);
    for (const type of ['E75L', 'B738', 'B763', 'B77W', 'A388']) {
      const opts = gateOptions(sim, { type, airline: 'DAL', x: 0, y: 0 });
      expect(opts.length, type).toBeGreaterThan(0);
      for (const g of opts) {
        expect(taken.has(g.name), `${type}: ${g.name} is taken`).toBe(false);
        expect(sizeFits(typeOf(type).size, g.size), `${type}: ${g.name} too small`).toBe(true);
        expect(g.cargo ?? false, `${type}: ${g.name} is a cargo stand`).toBe(false);
      }
    }
    expect(gateOptions(sim, { type: 'B77W', airline: 'DAL', x: 0, y: 0 }).every((g) => g.size === 'XL')).toBe(true);
    // cargo operators only get cargo stands
    expect(gateOptions(sim, { type: 'B763', airline: 'FDX', x: 0, y: 0 }).every((g) => g.cargo)).toBe(true);
  });

  it('an aircraft never parks on a gate it was not assigned: without a gate it asks for one', () => {
    const sim = mkSim('ATL');
    const a = vacated(sim, 'B738', 'UAL1');
    const r = sim.command(a, [{ t: 'TAXI' }]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/assign a gate first/i);
    sim.advance(300);
    expect(a.phase).toBe('vacated');
    expect(sim.s.stats.parked).toBe(0);
    expect(cmd).toBeDefined();
  });
});

describe('turnaround', () => {
  function watch(over = {}) {
    const sim = mkSim('ATL', over);
    const ac = spawnParked(sim, 'B18', { airline: 'DAL', type: 'A321', callsign: 'DAL1426', dest: 'LGA', readyIn: 1e6 })!; // full turnaround from the start
    const inbound = ac.callsign;
    const stages: TurnStage[] = [];
    const at: Record<string, number> = {};
    let progressOk = true, last = 0, readyAt = -1;
    for (let i = 0; i < 1500 && readyAt < 0; i++) {
      sim.advance(1);
      const st = ac.turn!.stage;
      if (stages[stages.length - 1] !== st) { stages.push(st); at[st] = sim.s.t; }
      if (ac.turn!.progress < last - 1e-9) progressOk = false;
      last = ac.turn!.progress;
      if (st === 'ready') readyAt = sim.s.t;
      else {
        // until the turnaround is complete it is still the inbound flight and cannot be cleared anywhere
        expect(ac.kind).toBe('arrival');
        expect(ac.callsign).toBe(inbound);
        expect(ac.request).toBeUndefined();
        expect(ac.phase).toBe('parked');
      }
    }
    return { sim, ac, inbound, stages, at, progressOk, readyAt };
  }

  it('deboarding → unloading → servicing → boarding → ready, then a new departure flight asks for clearance', () => {
    const { sim, ac, inbound, stages, at, progressOk, readyAt } = watch();
    expect(stages).toEqual(['deboarding', 'unloading', 'servicing', 'boarding', 'ready']);
    expect(progressOk).toBe(true);
    // medium jet: 440 s × 0.85..1.25
    expect(readyAt).toBeGreaterThan(370);
    expect(readyAt).toBeLessThan(560);
    // stage proportions: 20 % / 15 % / 33 % / 32 %
    expect((at.unloading - 0) / readyAt).toBeCloseTo(0.2, 1);
    expect((at.servicing - 0) / readyAt).toBeCloseTo(0.35, 1);
    expect((at.boarding - 0) / readyAt).toBeCloseTo(0.68, 1);
    expect(ac.kind).toBe('departure');
    expect(ac.callsign).toBe('DAL1426');
    expect(ac.callsign).not.toBe(inbound);
    expect(ac.dest).toBe('LGA');
    expect(ac.origin).toBe('ATL');
    expect(ac.nextLeg).toBeUndefined();
    expect(ac.depCleared).toBe(false);
    expect(ac.gate).toBe('B18');
    sim.advance(1);
    expect(ac.request?.type).toBe('clearance');
    expect(ac.request?.text).toMatch(/Clearance.*IFR to/);
    expect(sim.commandText('DAL1426 CLEARED AS FILED').ok).toBe(true);
    expect(sim.commandText(`${inbound} CLEARED AS FILED`).ok).toBe(false); // old callsign no longer exists
  });

  it('snow adds a de-icing stage before the aircraft is ready', () => {
    const dry = watch();
    const snow = watch({ customWeather: { windDir: 270, windKt: 5, gustKt: 0, precip: 'snow', surface: 'snow', tempC: -3, dewC: -5, visSM: 3 } });
    expect(snow.stages).toEqual(['deboarding', 'unloading', 'servicing', 'boarding', 'deicing', 'ready']);
    const deiceTime = snow.readyAt - snow.at.deicing;
    expect(deiceTime).toBeGreaterThanOrEqual(150);
    expect(deiceTime).toBeLessThanOrEqual(242);
    expect(eventsOf(snow.sim, 'weather').some((e) => /de-icing at gate B18/.test(e.text))).toBe(true);
    expect(eventsOf(dry.sim, 'weather').some((e) => /de-icing/.test(e.text))).toBe(false);
    expect(snow.ac.kind).toBe('departure');
    expect(snow.ac.flags.deiced).toBe(1);
  });

  it('wide-bodies take longer to turn around than narrow-bodies', () => {
    const sim = mkSim('ATL');
    const small = spawnParked(sim, 'B18', { airline: 'DAL', type: 'A321', readyIn: 1e6 })!;
    const big = spawnParked(sim, 'E3', { airline: 'DAL', type: 'A359', readyIn: 1e6 })!;
    let tSmall = -1, tBig = -1;
    for (let i = 0; i < 1500 && (tSmall < 0 || tBig < 0); i++) {
      sim.advance(1);
      if (tSmall < 0 && small.turn?.stage === 'ready') tSmall = sim.s.t;
      if (tBig < 0 && big.turn?.stage === 'ready') tBig = sim.s.t;
    }
    expect(tSmall).toBeGreaterThan(0);
    expect(tBig).toBeGreaterThan(tSmall);
  });

  it('a real arrival that parks goes through the same turnaround and becomes its next leg', () => {
    const sim = mkSim('ATL');
    const ac = vacated(sim, 'B738', 'UAL1');
    const next = ac.nextLeg!.callsign;
    ok(sim, 'UAL1 TAXI GATE B18');
    until(sim, () => ac.phase === 'parked', 600, 'parked');
    expect(ac.turn?.stage).toBe('deboarding');
    const seen = new Set<string>();
    until(sim, () => ac.kind === 'departure', 800, 'turned around', () => seen.add(ac.turn!.stage));
    expect([...seen]).toEqual(expect.arrayContaining(['deboarding', 'unloading', 'servicing', 'boarding']));
    expect(ac.callsign).toBe(next);
    sim.advance(2);
    expect(ac.request?.type).toBe('clearance');
    expect(ac.landCleared).toBe(false);
    expect(ac.rwy).toBeUndefined();
    // and it can leave again through the normal clearance chain
    cmd(sim, ac, { t: 'DEP_CLEARANCE' }, { t: 'PUSHBACK' });
    expect(ac.phase).toBe('pushback');
  });
});
