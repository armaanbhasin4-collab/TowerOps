/** Topics 16 + 17: fixed-step time acceleration, determinism and save/load consistency. */
import { describe, expect, it } from 'vitest';
import { DT, SAVE_VERSION, Sim, defaultConfig } from '../src/sim/sim';
import type { ScenarioConfig } from '../src/sim/types';
import { NM } from '../src/sim/util';
import { eventsOf, mkSim, placeAirborne } from './helpers';

const ALL_ON = { delivery: true, ground: true, tower: true, approach: true, departure: true };
function busyConfig(over: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return { ...defaultConfig('ATL', 'intermediate'), delegation: { ...ALL_ON }, ...over };
}
/** serialised state with object keys sorted, so that two equal states compare equal regardless of key insertion order */
function canon(sim: Sim): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify(sort(JSON.parse(sim.serialize())));
}
/** first position at which two strings differ, with some context (keeps assertion output readable) */
function firstDiff(a: string, b: string): string | undefined {
  if (a === b) return undefined;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `differs at char ${i}: …${a.slice(Math.max(0, i - 120), i + 80)}…  vs  …${b.slice(Math.max(0, i - 120), i + 80)}…`;
}

describe('fixed time step', () => {
  it('the step is 0.1 s; advance(n) runs exactly 10·n steps and the clock follows', () => {
    expect(DT).toBe(0.1);
    const sim = mkSim('ATL');
    expect(sim.s.step).toBe(0);
    sim.advance(1);
    expect(sim.s.step).toBe(10);
    expect(sim.s.t).toBe(1);
    sim.advance(0.1);
    expect(sim.s.step).toBe(11);
    expect(sim.s.t).toBe(1.1);
    sim.advance(0.3);
    expect(sim.s.step).toBe(14);
    sim.step();
    expect(sim.s.step).toBe(15);
    sim.advance(3600);
    expect(sim.s.step).toBe(36015);
    expect(sim.s.t).toBe(3601.5); // no floating-point drift in the clock
  });

  it('one large advance equals many small ones (time acceleration does not change the outcome)', () => {
    const a = new Sim(busyConfig()), b = new Sim(busyConfig()), c = new Sim(busyConfig());
    a.advance(420);
    for (let i = 0; i < 4200; i++) b.advance(0.1);
    // irregular "frame times" as produced by a game loop at 1×, 8× and 60× speed
    let left = 4200;
    const frames = [1, 2, 13, 100, 3, 600, 7];
    for (let i = 0; left > 0; i++) { const n = Math.min(left, frames[i % frames.length]); c.advance(n * DT); left -= n; }
    expect(a.s.step).toBe(4200);
    expect(b.s.step).toBe(4200);
    expect(c.s.step).toBe(4200);
    expect(firstDiff(a.serialize(), b.serialize())).toBeUndefined();
    expect(firstDiff(a.serialize(), c.serialize())).toBeUndefined();
    // the scenario is not trivial
    expect(a.s.aircraft.length).toBeGreaterThan(10);
    expect(a.s.radio.length).toBeGreaterThan(20);
  });

  it('separation checks run at any stepping granularity', () => {
    for (const chunk of [0.1, 0.3, 1, 5]) {
      const sim = mkSim('ATL');
      placeAirborne(sim, { callsign: 'DAL1', x: -10 * NM, y: 12 * NM, alt: 6000, hdg: 90 });
      placeAirborne(sim, { callsign: 'DAL2', x: -10 * NM, y: 14 * NM, alt: 6000, hdg: 90 });
      while (sim.s.t < 5 - 1e-9) sim.advance(chunk);
      expect(sim.s.stats.separationViolations, `chunk ${chunk}`).toBe(1);
      expect(eventsOf(sim, 'separation')[0].t, `chunk ${chunk}`).toBe(1); // detected at the first whole second, whatever the chunking
    }
  });

  it('the scenario time limit ends the run at the same instant regardless of chunking', () => {
    const a = new Sim(busyConfig({ duration: 120 })), b = new Sim(busyConfig({ duration: 120 }));
    a.advance(500);
    for (let i = 0; i < 500; i++) b.advance(1);
    expect(a.s.over).toBe(true);
    expect(a.s.overReason).toMatch(/time limit/i);
    expect(a.s.t).toBe(120);
    expect(firstDiff(a.serialize(), b.serialize())).toBeUndefined();
  });
});

describe('determinism', () => {
  const script: [number, string][] = [
    [30, 'RWY 10 CLOSE'],
    [45, 'CONFIG EAST'],
    [200, 'RWY 10 OPEN'],
  ];
  function run(seed: number, withCommands = true, manual = false) {
    const sim = new Sim(busyConfig({ seed, delegation: manual ? { delivery: false, ground: false, tower: false, approach: false, departure: false } : { ...ALL_ON } }));
    const results: string[] = [];
    for (let t = 0; t < 400; t++) {
      sim.advance(1);
      if (!withCommands) continue;
      for (const [at, text] of script) if (at === sim.s.t) results.push(JSON.stringify(sim.commandText(text)));
      // player commands addressed to whatever aircraft exist, chosen deterministically
      if (sim.s.t % 60 === 0) {
        const arr = sim.s.aircraft.find((a) => a.phase === 'inbound' && !a.flags.pending);
        if (arr) results.push(JSON.stringify(sim.commandText(`${arr.callsign} DESCEND ${6000 + (sim.s.t / 60 % 3) * 1000}, SPEED 220`)));
        const dep = sim.s.aircraft.find((a) => a.phase === 'parked' && a.request?.type === 'clearance');
        if (dep) results.push(JSON.stringify(sim.commandText(`${dep.callsign} CLEARED AS FILED`)));
      }
    }
    return { sim, results };
  }

  it('same seed + same commands → identical state', () => {
    const a = run(4242), b = run(4242);
    expect(a.results).toEqual(b.results);
    expect(a.results.length).toBeGreaterThan(5);
    expect(firstDiff(a.sim.serialize(), b.sim.serialize())).toBeUndefined();
  });

  it('same seed, manual control (radio realism active) → identical state', () => {
    const a = run(77, true, true), b = run(77, true, true);
    expect(firstDiff(a.sim.serialize(), b.sim.serialize())).toBeUndefined();
  });

  it('different seeds → different traffic', () => {
    const a = run(1, false), b = run(2, false);
    expect(a.sim.serialize()).not.toBe(b.sim.serialize());
    expect(a.sim.s.aircraft.map((x) => x.callsign)).not.toEqual(b.sim.s.aircraft.map((x) => x.callsign));
  });

  it('commands change the outcome (the comparison above is not vacuous)', () => {
    const a = run(4242, true), b = run(4242, false);
    expect(a.sim.serialize()).not.toBe(b.sim.serialize());
  });

  it('constructing or running one sim does not influence another (no shared mutable state)', () => {
    const ref = run(4242);
    const a = new Sim(busyConfig({ seed: 4242 }));
    const noise = new Sim(busyConfig({ seed: 9 }));
    const results: string[] = [];
    for (let t = 0; t < 400; t++) {
      noise.advance(3);
      a.advance(1);
      for (const [at, text] of script) if (at === a.s.t) results.push(JSON.stringify(a.commandText(text)));
      if (a.s.t % 60 === 0) {
        const arr = a.s.aircraft.find((x) => x.phase === 'inbound' && !x.flags.pending);
        if (arr) results.push(JSON.stringify(a.commandText(`${arr.callsign} DESCEND ${6000 + (a.s.t / 60 % 3) * 1000}, SPEED 220`)));
        const dep = a.s.aircraft.find((x) => x.phase === 'parked' && x.request?.type === 'clearance');
        if (dep) results.push(JSON.stringify(a.commandText(`${dep.callsign} CLEARED AS FILED`)));
      }
    }
    expect(firstDiff(ref.sim.serialize(), a.serialize())).toBeUndefined();
  });
});

describe('save / load', () => {
  it('serialize → deserialize → serialize is the identity', () => {
    const sim = new Sim(busyConfig());
    sim.advance(333.3);
    const json = sim.serialize();
    const copy = Sim.deserialize(json);
    expect(copy.serialize()).toBe(json);
    expect(copy.s).not.toBe(sim.s); // a real copy, not an alias
    expect(copy.s.t).toBe(sim.s.t);
    expect(copy.s.step).toBe(sim.s.step);
    expect(copy.s.aircraft.length).toBe(sim.s.aircraft.length);
    expect(copy.ap.icao).toBe('KATL');
    expect(JSON.parse(json).version).toBe(SAVE_VERSION);
  });

  it('Infinity survives the round trip (no emergencies scheduled)', () => {
    const sim = mkSim('ATL');
    expect(sim.s.nextEmergency).toBe(Infinity);
    const copy = Sim.deserialize(sim.serialize());
    expect(copy.s.nextEmergency).toBe(Infinity);
    expect(sim.serialize()).not.toMatch(/null/);
  });

  it('an incompatible or corrupt save is rejected', () => {
    const sim = mkSim('ATL');
    const data = JSON.parse(sim.serialize());
    data.version = SAVE_VERSION + 1;
    expect(() => Sim.deserialize(JSON.stringify(data))).toThrow(/Incompatible save version/);
    data.version = 1;
    expect(() => Sim.deserialize(JSON.stringify(data))).toThrow(/Incompatible save version \(1\)/);
    delete data.version;
    expect(() => Sim.deserialize(JSON.stringify(data))).toThrow(/Incompatible save version/);
    expect(() => Sim.deserialize('null')).toThrow(/Incompatible save version/);
    expect(() => Sim.deserialize('{not json')).toThrow();
  });

  it('a restored quiet scenario continues identically (manual control, scripted traffic)', () => {
    const sim = mkSim('ATL', { configName: 'West flow' });
    placeAirborne(sim, { callsign: 'DAL1', x: -10 * NM, y: 12 * NM, alt: 6000, hdg: 90 });
    sim.commandText('DAL1 HEADING 180, DESCEND 3000');
    sim.advance(1); // saved while the readback is still pending
    expect(sim.s.pending).toHaveLength(1);
    const copy = Sim.deserialize(sim.serialize());
    sim.advance(300);
    copy.advance(300);
    expect(copy.s.aircraft[0].tgtAlt).toBe(3000);
    expect(firstDiff(canon(sim), canon(copy))).toBeUndefined();
  });

  it('commands work on a restored sim', () => {
    const sim = mkSim('ATL');
    placeAirborne(sim, { callsign: 'DAL1', x: -10 * NM, y: 12 * NM, alt: 6000, hdg: 90 });
    const copy = Sim.deserialize(sim.serialize());
    expect(copy.commandText('DAL1 DESCEND 4000').ok).toBe(true);
    copy.advance(5);
    expect(copy.s.aircraft[0].tgtAlt).toBe(4000);
    expect(sim.s.aircraft[0].tgtAlt).toBe(6000); // the original is untouched
  });

  /** save mid-scenario with random traffic, then run original and restored copy side by side */
  function divergence(saveAt: number, delegation: ScenarioConfig['delegation'], runFor = 300) {
    const sim = new Sim(busyConfig({ delegation }));
    sim.advance(saveAt);
    const copy = Sim.deserialize(sim.serialize());
    for (let t = 0; t < runFor; t += 10) {
      sim.advance(10);
      copy.advance(10);
      const d = firstDiff(canon(sim), canon(copy));
      if (d) return `after ${t + 10} s: ${d}`;
    }
    return undefined;
  }

  it('random traffic, no delegation: restored copy stays identical for 5 minutes', () => {
    expect(divergence(240, { delivery: false, ground: false, tower: false, approach: false, departure: false })).toBeUndefined();
  });

  it('random traffic with AI delegation: restored copy stays identical for 5 minutes (saved at a whole 2 s tick)', () => {
    expect(divergence(600, { ...ALL_ON })).toBeUndefined();
  });

  it('random traffic with AI delegation: identical when saved at an arbitrary step', () => {
    expect(divergence(601.3, { ...ALL_ON })).toBeUndefined();
  });

  it('partial delegation (ground + tower only): restored copy stays identical', () => {
    expect(divergence(480, { delivery: true, ground: true, tower: true, approach: false, departure: false })).toBeUndefined();
  });

  // ENGINE BUG: save/load loses engine state that lives outside SimState in module-level WeakMaps keyed on the state
  // object: separation.ts `seen` (which violations / incursions / deadlocks have already been logged), weather.ts `flags`
  // (tailwind advisory latch) and delegation.ts `meters` (AI arrival metering lastEta/lastWake and per-aircraft lastTx
  // back-off). A restored sim therefore (a) logs and penalises every ongoing violation a second time and (b) lets the AI
  // controllers take different decisions than the original run. Sim.limits (ground give-way limits, recomputed every
  // 5 steps) is likewise not restored. Repro (a): two level aircraft 2 NM apart, advance 30 s (1 violation), save, load,
  // advance 30 s → copy has separationViolations 2 / safetyPenalty 14, original 1 / 7.
  // Fix direction: keep these maps inside SimState (or rebuild them in the Sim constructor when `saved` is given).
  it('an ongoing loss of separation is not counted a second time after loading', () => {
    const sim = mkSim('ATL');
    placeAirborne(sim, { callsign: 'DAL1', x: -10 * NM, y: 12 * NM, alt: 6000, hdg: 90 });
    placeAirborne(sim, { callsign: 'DAL2', x: -10 * NM, y: 14 * NM, alt: 6000, hdg: 90 });
    sim.advance(30);
    expect(sim.s.stats.separationViolations).toBe(1);
    const copy = Sim.deserialize(sim.serialize());
    sim.advance(30);
    copy.advance(30);
    expect(sim.s.stats.separationViolations).toBe(1);
    expect(copy.s.stats.separationViolations).toBe(1);
    expect(firstDiff(canon(sim), canon(copy))).toBeUndefined();
  });

  it.each([300, 1500])('AI delegation, saved at t=%i s: original and restored copy agree for 10 minutes', (saveAt) => {
    expect(divergence(saveAt, { ...ALL_ON }, 600)).toBeUndefined();
  });

  // ENGINE BUG (same root cause as above – delegation.ts `meters` WeakMap is not part of the saved state):
  // defaultConfig('ATL','intermediate'), seed 12345, all positions delegated. Saved at t=900 the copy diverges after
  // ~160 s (the restored AI vectors an arrival the original AI was still holding for a landing slot); saved at t=1200 it
  // diverges within 10 s.
  it.each([900, 1200])('AI delegation, saved at t=%i s: original and restored copy agree for 10 minutes', (saveAt) => {
    expect(divergence(saveAt, { ...ALL_ON }, 600)).toBeUndefined();
  });
});
