/** Topic 20: AI delegation obeys the clearance rules; with delegation off nothing moves without the player. */
import { describe, expect, it } from 'vitest';
import type { Aircraft, Position } from '../src/sim/types';
import { Sim, defaultConfig } from '../src/sim/sim';
import { endRef, runwayZoneAt } from '../src/sim/airport/query';
import { isAirborne } from '../src/sim/world';
import { alongCross } from '../src/sim/util';
import { suggest } from '../src/sim/delegation';
import { eventsOf, mkSim, pushedBack, readyDeparture, placeFinal } from './helpers';

const ALL: Record<Position, boolean> = { delivery: true, ground: true, tower: true, approach: true, departure: true };

/** why an aircraft is inside a runway zone without authorisation (undefined = it is entitled to be there) */
function unauthorisedOnRunway(sim: Sim, ac: Aircraft): string | undefined {
  if (isAirborne(ac) || ['parked', 'gone', 'crashed'].includes(ac.phase)) return undefined;
  // all protected areas containing the aircraft (runways may intersect)
  const zones = sim.ap.runways.filter((r) => {
    const [al, cr] = alongCross(ac.x, ac.y, r.ends[0].x, r.ends[0].y, r.ends[0].hdg);
    return Math.abs(cr) < sim.ap.holdDist - 12 && al > -60 && al < r.length + 60;
  });
  if (!zones.length) return undefined;
  if (!runwayZoneAt(sim.ap, ac.x, ac.y)) return 'zone helper disagrees with runwayZoneAt';
  const ownId = endRef(sim.ap, ac.rwy)?.rwy.id;
  const own = zones.some((z) => z.id === ownId);
  const zone = zones[0];
  switch (ac.phase) {
    case 'taxi_out':
    case 'taxi_in':
      for (const z of zones) {
        if (ac.crossCleared.includes(z.id)) continue;
        if (z.id === ownId && (ac.lineUpCleared || ac.takeoffCleared)) continue;
        if (endRef(sim.ap, ac.lastRwy)?.rwy.id === z.id) continue; // still clearing the runway it landed on
        return `${ac.callsign} taxiing inside ${z.id} without a crossing / line-up clearance`;
      }
      return undefined;
    case 'holding_short':
    case 'push_done':
    case 'pushback':
      return `${ac.callsign} ${ac.phase} inside ${zone.id}`;
    case 'lining_up':
    case 'lined_up':
      return own && (ac.lineUpCleared || ac.takeoffCleared) ? undefined : `${ac.callsign} ${ac.phase} on ${zone.id} without line-up clearance`;
    case 'takeoff_roll':
      return own ? undefined : `${ac.callsign} rolling on the wrong runway`;
    default:
      return undefined; // landing_roll / vacated / disabled: the landing itself is checked through the event log
  }
}

describe('AI delegation obeys the clearance rules', () => {
  it.each(['REG', 'LGA'])('%s, all positions delegated, 30 minutes: no unauthorised runway entry, no collisions', (airport) => {
    const sim = new Sim({ ...defaultConfig(airport, 'intermediate'), delegation: { ...ALL } });
    const violations = new Set<string>();
    const rolledWithoutClearance: string[] = [];
    const prevPhase = new Map<number, string>();
    const moved = new Set<number>();
    for (let t = 0; t < 1800; t++) {
      for (let k = 0; k < 2; k++) {
        const cleared = new Map(sim.s.aircraft.map((a) => [a.id, a.takeoffCleared]));
        sim.advance(0.5);
        for (const ac of sim.s.aircraft) {
          const v = unauthorisedOnRunway(sim, ac);
          if (v) violations.add(v);
          const was = prevPhase.get(ac.id);
          // every takeoff roll starts from a takeoff clearance held just before
          if (ac.phase === 'takeoff_roll' && was === 'lined_up' && !cleared.get(ac.id) && !ac.takeoffCleared) rolledWithoutClearance.push(ac.callsign);
          if (was && was !== ac.phase) moved.add(ac.id);
          prevPhase.set(ac.id, ac.phase);
        }
      }
    }
    expect([...violations]).toEqual([]);
    expect(rolledWithoutClearance).toEqual([]);
    expect(sim.s.stats.collisions).toBe(0);
    expect(eventsOf(sim, 'collision')).toEqual([]);
    // nobody landed without a clearance and nobody entered a runway uncleared
    expect(eventsOf(sim, 'incursion').filter((e) => /without (a landing )?clearance/.test(e.text)).map((e) => e.text)).toEqual([]);
    // the AI actually worked traffic through the normal command pipeline
    expect(sim.s.stats.landed + sim.s.stats.departed).toBeGreaterThanOrEqual(4);
    expect(moved.size).toBeGreaterThan(5);
    expect(sim.s.radio.filter((m) => m.from === 'atc').length).toBeGreaterThan(30);
    expect(sim.s.stats.commands).toBe(0); // none of it counted as player commands
  });

  it('AI transmissions go through the same validation / readback pipeline as the player', () => {
    const sim = mkSim('ATL', { configName: 'West flow', delegation: { ...ALL } });
    const ac = readyDeparture(sim, 'B18', { callsign: 'DAL1426' });
    let sawPendingAi = false;
    const phases = new Set<string>();
    for (let i = 0; i < 9000 && ac.phase !== 'departure'; i++) {
      sim.advance(0.1);
      phases.add(ac.phase);
      if (sim.s.pending.some((p) => p.by === 'ai' && p.ac === ac.id)) sawPendingAi = true;
      const v = unauthorisedOnRunway(sim, ac);
      expect(v).toBeUndefined();
    }
    expect(ac.phase).toBe('departure');
    expect(sawPendingAi).toBe(true);
    expect([...phases]).toEqual(expect.arrayContaining(['parked', 'pushback', 'push_done', 'taxi_out', 'lined_up', 'takeoff_roll']));
    const atc = sim.s.radio.filter((m) => m.from === 'atc' && m.callsign === 'DAL1426').map((m) => m.text).join(' | ');
    expect(atc).toMatch(/push/i);
    expect(atc).toMatch(/taxi/i);
    expect(atc).toMatch(/cleared for takeoff/i);
    expect(sim.s.stats.commands).toBe(0);
  });

  it('only the delegated positions act: ground alone pushes and taxies but never clears for takeoff', () => {
    const sim = mkSim('ATL', { configName: 'West flow', delegation: { delivery: true, ground: true, tower: false, approach: false, departure: false } });
    const ac = readyDeparture(sim, 'B18', { callsign: 'DAL1426' });
    sim.advance(1500);
    expect(ac.phase).toBe('holding_short');
    expect(ac.takeoffCleared).toBe(false);
    expect(ac.request?.type).toBe('takeoff');
    expect(suggest(sim, ac)?.pos).toBe('tower'); // the hint exists, but nobody is allowed to act on it
    sim.setDelegation('tower', true);
    sim.advance(120);
    expect(['lining_up', 'lined_up', 'takeoff_roll', 'departure']).toContain(ac.phase);
  });

  it('the AI tower does not clear a landing onto an occupied runway, nor a takeoff in front of short final', () => {
    const sim = mkSim('ATL', { configName: 'West flow', delegation: { ...ALL } });
    const dep = pushedBack(sim, 'B18', { callsign: 'DAL1' });
    sim.advance(600);
    // by now DAL1 has been taxied out by the AI; freeze the picture: put it lined up, an arrival on 1.5 NM final
    const arr = placeFinal(sim, dep.rwy!, 1.5, { callsign: 'UAL2' });
    for (let i = 0; i < 400 && arr.phase === 'final'; i++) sim.advance(0.1);
    expect(sim.s.stats.collisions).toBe(0);
    expect(eventsOf(sim, 'incursion')).toEqual([]);
  });
});

describe('with delegation off (default) nothing happens without the player', () => {
  const sim = new Sim(defaultConfig('ATL', 'intermediate'));
  const start = new Map(sim.s.aircraft.filter((a) => a.phase === 'parked').map((a) => [a.id, { x: a.x, y: a.y, gate: a.gate }]));
  const requests = new Set<string>();
  let maxGroundGs = 0;
  const badPhases = new Set<string>();
  for (let t = 0; t < 900; t++) {
    sim.advance(1);
    for (const a of sim.s.aircraft) {
      if (a.request) requests.add(a.request.type);
      if (!isAirborne(a) && a.phase !== 'gone') {
        maxGroundGs = Math.max(maxGroundGs, a.gs);
        if (a.phase !== 'parked') badPhases.add(`${a.callsign}:${a.phase}`);
      }
    }
  }

  it('the default configuration has no delegation and plenty of traffic', () => {
    expect(Object.values(sim.s.cfg.delegation)).toEqual([false, false, false, false, false]);
    expect(start.size).toBeGreaterThan(5);
    expect(sim.s.aircraft.filter(isAirborne).length).toBeGreaterThan(1);
    expect(sim.s.t).toBe(900);
  });

  it('nothing moves on the ground for 15 minutes: every parked aircraft is still on its stand', () => {
    expect([...badPhases]).toEqual([]);
    expect(maxGroundGs).toBe(0);
    for (const [id, p] of start) {
      const a = sim.s.aircraft.find((x) => x.id === id)!;
      expect(a, `aircraft ${id} still exists`).toBeDefined();
      expect(a.phase).toBe('parked');
      expect({ x: a.x, y: a.y, gate: a.gate }).toEqual(p);
      expect(a.pushApproved).toBe(false);
      expect(a.depCleared).toBe(false);
    }
    expect(eventsOf(sim, 'pushback')).toEqual([]);
    expect(eventsOf(sim, 'takeoff')).toEqual([]);
    expect(sim.s.stats.departed).toBe(0);
  });

  it('aircraft that became ready ask for their clearance and keep waiting', () => {
    const ready = sim.s.aircraft.filter((a) => a.phase === 'parked' && a.kind === 'departure' && a.turn?.stage === 'ready');
    expect(ready.length).toBeGreaterThan(0);
    for (const a of ready) expect(a.request?.type).toBe('clearance');
    expect(requests.has('clearance')).toBe(true);
    expect(requests.has('pushback')).toBe(false); // nobody got as far as a pushback request
    expect(sim.s.radio.some((m) => m.from === 'pilot' && /still waiting for clearance/.test(m.text))).toBe(true);
  });

  it('no aircraft lands: arrivals without a clearance hold (or would go around)', () => {
    expect(sim.s.stats.landed).toBe(0);
    expect(eventsOf(sim, 'landing')).toEqual([]);
    const arrivals = sim.s.aircraft.filter((a) => a.kind === 'arrival' && isAirborne(a));
    expect(arrivals.length).toBeGreaterThan(1);
    for (const a of arrivals) {
      expect(a.apprCleared).toBe(false);
      expect(a.landCleared).toBe(false);
      expect(['inbound', 'go_around']).toContain(a.phase);
      expect(a.alt).toBeGreaterThan(3000); // nobody descended on their own either
    }
    expect(arrivals.some((a) => a.latMode === 'hold')).toBe(true);
    expect(sim.s.radio.filter((m) => m.from === 'atc')).toEqual([]); // no clearance was ever transmitted
    expect(sim.s.stats.collisions).toBe(0);
    expect(sim.s.stats.incursions).toBe(0);
  });
});
