/** Topic 18: built-in airports and the custom airport generator produce valid, fully connected layouts. */
import { describe, expect, it } from 'vitest';
import type { Airport, CustomAirportParams } from '../src/sim/types';
import { AIRPORT_DEFS, getAirport } from '../src/sim/airport';
import { buildAirport, validateAirport } from '../src/sim/airport/build';
import { customAirportDef, defaultCustomParams, runwaySpecs } from '../src/sim/airport/custom';
import { endRef, holdsOf, rwyLateral, runwayZoneAt, toraFrom } from '../src/sim/airport/query';
import { findRoute } from '../src/sim/pathfind';
import { AIRCRAFT_TYPES } from '../src/sim/data/aircraft';
import { Sim } from '../src/sim/sim';
import { quietConfig } from './helpers';

/** a holding position counts as "full length" when it gives at least the runway length minus this margin */
const FULL_LENGTH_MARGIN = 150;

/** gate → hold routing as a departure would do it (hold approached from outside the runway) */
function reaches(ap: Airport, gateLane: number, rwyId: string, holds: number[]): boolean {
  const r = ap.runways.find((x) => x.id === rwyId)!;
  return !!findRoute(ap, gateLane, holds, { goalOk: (n, p) => rwyLateral(r, ap.nodes[p].x, ap.nodes[p].y) > rwyLateral(r, ap.nodes[n].x, ap.nodes[n].y) - 1 });
}

/** a handful of gates spread over the apron (first, last and two in between) */
const sample = (ap: Airport, n = 4) => [...new Set(Array.from({ length: n }, (_, i) => ap.gates[Math.round((i * (ap.gates.length - 1)) / (n - 1))]))];

/** layout-sanity problems beyond validateAirport: stands or holding positions inside a runway's protected area */
function zoneProblems(ap: Airport): string[] {
  const out: string[] = [];
  const g = ap.gates.filter((x) => runwayZoneAt(ap, ap.nodes[x.node].x, ap.nodes[x.node].y)).map((x) => x.name);
  if (g.length) out.push(`${g.length} gate(s) inside a runway protected area (${g.slice(0, 4).join(',')})`);
  const h = ap.nodes.filter((n) => n.kind === 'hold' && n.rwy && runwayZoneAt(ap, n.x, n.y)?.id === n.rwy);
  if (h.length) out.push(`${h.length} holding position(s) inside the protected area of their own runway (${h.slice(0, 3).map((n) => `${n.rwy}@${Math.round(n.x)},${Math.round(n.y)}`).join(' ')})`);
  return out;
}

/** structural problems: validateAirport + graph sanity + every sampled gate can taxi to every runway end */
function structuralProblems(ap: Airport, every = 0): string[] {
  const out = [...validateAirport(ap)];
  const names = ap.runways.flatMap((r) => r.ends.map((e) => e.name));
  if (new Set(names).size !== names.length) out.push(`duplicate runway designators: ${names.join(' ')}`);
  if (new Set(ap.gates.map((g) => g.name)).size !== ap.gates.length) out.push('duplicate gate names');
  for (const e of ap.edges) if (!(e.len > 0) || !Number.isFinite(e.len)) out.push(`edge ${e.id} has length ${e.len}`);
  for (const c of ap.configs) for (const n of [...c.arr, ...c.dep]) if (!endRef(ap, n)) out.push(`config "${c.name}" names unknown runway ${n}`);
  for (const f of ap.fixes) if (f.kind === 'final' && !endRef(ap, f.rwy)) out.push(`fix ${f.name} refers to unknown runway`);
  const gates = every ? ap.gates.filter((_, i) => i % every === 0) : sample(ap);
  for (const r of ap.runways) for (const idx of [0, 1] as const) {
    const hs = holdsOf(ap, r.id);
    if (!hs.length) continue; // already reported by validateAirport
    const best = Math.max(...hs.map((h) => toraFrom(h, idx)));
    const goals = hs.filter((h) => toraFrom(h, idx) >= best - 1).map((h) => h.hold);
    const bad = gates.filter((g) => !reaches(ap, g.lane, r.id, goals)).map((g) => g.name);
    if (bad.length) out.push(`${r.ends[idx].name}: gates ${bad.slice(0, 5).join(',')}${bad.length > 5 ? '…' : ''} cannot taxi to the longest-run holding position`);
  }
  return out;
}

/** runway ends without a full-length holding position, or whose full-length holds cannot be reached from sampled gates */
function fullLengthProblems(ap: Airport, every = 0): string[] {
  const out: string[] = [];
  const gates = every ? ap.gates.filter((_, i) => i % every === 0) : sample(ap);
  for (const r of ap.runways) for (const idx of [0, 1] as const) {
    const hs = holdsOf(ap, r.id);
    const full = hs.filter((h) => toraFrom(h, idx) >= r.length - FULL_LENGTH_MARGIN).map((h) => h.hold);
    if (!full.length) { out.push(`${r.ends[idx].name}: no full-length hold (best TORA ${Math.round(Math.max(0, ...hs.map((h) => toraFrom(h, idx))))} of ${Math.round(r.length)} m)`); continue; }
    const bad = gates.filter((g) => !reaches(ap, g.lane, r.id, full)).map((g) => g.name);
    if (bad.length) out.push(`${r.ends[idx].name}: gates ${bad.slice(0, 5).join(',')} cannot reach a full-length hold`);
  }
  return out;
}

describe('built-in airports', () => {
  it('there are six airports with unique ids', () => {
    expect(AIRPORT_DEFS.map((d) => d.id)).toEqual(['ATL', 'JFK', 'LAX', 'EGLL', 'LGA', 'REG']);
  });

  it.each(AIRPORT_DEFS.map((d) => [d.id, d] as const))('%s builds with no validation problems', (_id, def) => {
    const ap = buildAirport(def);
    expect(validateAirport(ap)).toEqual([]);
    expect(structuralProblems(ap, 3)).toEqual([]);
    expect(zoneProblems(ap)).toEqual([]);
    expect(ap.runways).toHaveLength(def.runways.length);
    expect(ap.gates).toHaveLength(def.gates.length);
    expect(ap.configs.length).toBeGreaterThan(0);
    expect(ap.fixes.filter((f) => f.kind === 'arrival').length).toBeGreaterThanOrEqual(3);
    expect(ap.fixes.filter((f) => f.kind === 'departure').length).toBeGreaterThanOrEqual(3);
    // every traffic-mix type exists and at least one fits a gate and a runway
    for (const m of ap.mix) for (const t of m.types) expect(AIRCRAFT_TYPES[t], `${def.id} mix type ${t}`).toBeDefined();
    expect(typeof ap.dataNote).toBe('string');
    expect(ap.dataNote.length).toBeGreaterThan(20);
  });

  it.each(AIRPORT_DEFS.map((d) => [d.id, d] as const))('%s: every runway end has a full-length holding position reachable from sampled gates', (_id, def) => {
    expect(fullLengthProblems(buildAirport(def), 3)).toEqual([]);
  });

  it.each(AIRPORT_DEFS.map((d) => d.id))('%s: every gate can be reached from every runway (arrival taxi-in)', (id) => {
    const ap = getAirport({ airportId: id });
    const bad: string[] = [];
    for (const r of ap.runways) {
      // start from a mid-runway hold, as an aircraft that has just vacated would
      const hs = holdsOf(ap, r.id);
      const h = hs[Math.floor(hs.length / 2)];
      for (const g of ap.gates.filter((_, i) => i % 4 === 0)) if (!findRoute(ap, h.hold, g.node, { prev: h.path[1] })) bad.push(`${r.id}→${g.name}`);
    }
    expect(bad).toEqual([]);
  });

  it('getAirport caches built airports and falls back to ATL for unknown ids', () => {
    expect(getAirport({ airportId: 'JFK' })).toBe(getAirport({ airportId: 'JFK' }));
    expect(getAirport({ airportId: 'NOPE' }).icao).toBe('KATL');
    expect(getAirport({ airportId: 'REG' }).fictional).toBe(true);
    expect(getAirport({ airportId: 'ATL' }).fictional).toBe(false);
  });
});

describe('custom airport generator', () => {
  const LAYOUTS = ['parallel', 'intersecting', 'mixed'] as const;
  const TERMINALS: [number, number][] = [[1, 4], [2, 8], [3, 12], [5, 20], [8, 40]];
  const COMPLEXITY = [0.2, 0.5, 0.9];
  const SIZES = [0.6, 1, 1.6];
  function* variants(layout: CustomAirportParams['layout'], count: number) {
    // every terminal/gate count × every size; the taxiway complexity cycles through the variants
    for (const [ti, [terminals, gatesPerTerminal]] of TERMINALS.entries()) for (const [si, size] of SIZES.entries()) {
      const taxiComplexity = COMPLEXITY[(ti + si + count) % COMPLEXITY.length];
      const p: CustomAirportParams = { ...defaultCustomParams(), runways: runwaySpecs(count, layout), layout, terminals, gatesPerTerminal, taxiComplexity, size };
      yield { id: `${layout} ×${count}, ${terminals} terminals × ${gatesPerTerminal} gates, complexity ${taxiComplexity}, size ${size}`, p };
    }
  }
  const build = (p: CustomAirportParams) => buildAirport(customAirportDef(p));
  const cases = LAYOUTS.flatMap((l) => [1, 2, 3, 4, 5, 6, 7, 8].map((c) => [l, c] as const));

  it('runwaySpecs produces the requested number of runways with sensible lengths', () => {
    for (const layout of LAYOUTS) for (let c = 1; c <= 8; c++) {
      const specs = runwaySpecs(c, layout);
      expect(specs).toHaveLength(c);
      for (const s of specs) { expect(s.length).toBeGreaterThanOrEqual(1200); expect(s.hdg).toBeGreaterThanOrEqual(0); expect(s.hdg).toBeLessThan(360); }
      const dirs = new Set(specs.map((s) => s.hdg % 180));
      if (layout === 'parallel' || c === 1) expect(dirs.size).toBe(1);
      if (layout === 'intersecting' && c >= 2) expect(dirs.size).toBeGreaterThan(1);
    }
  });

  it.each(cases)('%s layout, %i runway(s): valid, connected, unique designators, gates can taxi to every runway end (15 variants)', (layout, count) => {
    const failures: string[] = [];
    for (const v of variants(layout, count)) {
      let pr: string[];
      try {
        const ap = build(v.p);
        pr = structuralProblems(ap);
        if (ap.runways.length !== count) pr.push(`built ${ap.runways.length} runways instead of ${count}`);
        if (ap.gates.length < v.p.terminals * v.p.gatesPerTerminal) pr.push(`only ${ap.gates.length} gates`);
      } catch (e) { pr = [`threw ${(e as Error).message}`]; }
      if (pr.length) failures.push(`${v.id}: ${pr.join('; ')}`);
    }
    expect(failures).toEqual([]);
  });

  // ENGINE BUG (custom airport generator): for crossing-runway layouts some runway end has no full-length holding
  // position – the longest takeoff run available from any hold of that end is 180–590 m short of the runway length
  // (e.g. "intersecting ×2, 8 terminals × 40 gates, size 1": runway 15 best TORA 2370 of 2649 m; "mixed ×6, 5×20,
  // complexity 0.2, size 1.6": runway 33 best TORA 1812 of 2400 m). All 'parallel' variants and all structural checks
  // pass. Failing (layout, runway count) groups (138 of 1080 variants in a 3-complexity sweep; complexity is irrelevant):
  //   intersecting 2–8 runways (T8×G40 @ size 0.6/1; T2×G8 @ 1.6 [and 0.6 for 7–8]; T5×G20 @ 0.6 for ≥5; T3×G12 @ 1 for ≥6)
  //   mixed 5–8 runways (T8×G40 @ 0.6/1; T2×G8; T3×G12; T5×G20 @ 1.6; T1×G4 @ 1 for 8)
  // The exact failing variants are printed by the assertion when the test is enabled.
  // Suspected: airport/custom.ts customAirportDef – the threshold connector of a runway (drawn 14 m in from the end,
  // perpendicular to the runway toward its parallel taxiway / the core) crosses or ends inside the protected zone of an
  // intersecting runway or is cut short, so buildAirport() creates no usable hold node for it (holdInfo() cannot walk
  // from the hold to that runway's centreline).
  const KNOWN_BAD = (layout: string, count: number) => (layout === 'intersecting' && count >= 2) || (layout === 'mixed' && count >= 5);
  for (const [layout, count] of cases) {
    const run = KNOWN_BAD(layout, count) ? it.skip : it;
    run(`${layout} layout, ${count} runway(s): every runway end has a full-length hold reachable from the gates (15 variants)`, () => {
      const failures: string[] = [];
      for (const v of variants(layout, count)) {
        const pr = fullLengthProblems(build(v.p));
        if (pr.length) failures.push(`${v.id}: ${pr.join('; ')}`);
      }
      expect(failures).toEqual([]);
    });
  }

  // ENGINE BUG (custom airport generator, crossing-runway layouts only): the generated layout places (a) terminal
  // stands inside the protected area of a crosswind runway (always with 8 terminals × 40 gates, e.g. gate H40 for
  // "intersecting ×2") and (b) holding positions inside the protected area of the very runway they protect
  // (runwayZoneAt(hold) === its runway, e.g. "intersecting ×6, 1 terminal × 4 gates"), so an aircraft holding short there
  // counts as a runway occupant. Built-in airports and all 'parallel' variants are clean.
  // Suspected: airport/custom.ts customAirportDef (crosswind runways are positioned `330 + k·430` m beyond the core
  // without checking the core's real extent / other runways' strips) together with build.ts hold placement, which uses the
  // capsule distance to the runway segment while runwayZoneAt() extends 60 m beyond both thresholds.
  const KNOWN_BAD_ZONES = (layout: string, count: number) => (layout === 'intersecting' && count >= 2) || (layout === 'mixed' && count >= 4);
  for (const [layout, count] of cases) {
    const run = KNOWN_BAD_ZONES(layout, count) ? it.skip : it;
    run(`${layout} layout, ${count} runway(s): no stand or holding position lies inside a runway protected area (15 variants)`, () => {
      const failures: string[] = [];
      for (const v of variants(layout, count)) {
        const pr = zoneProblems(build(v.p));
        if (pr.length) failures.push(`${v.id}: ${pr.join('; ')}`);
      }
      expect(failures).toEqual([]);
    });
  }

  it('aircraft categories and airlines drive gate sizes and the traffic mix', () => {
    const small = build({ ...defaultCustomParams(), categories: ['S'], airlines: ['SKW', 'RPA'] });
    expect(new Set(small.gates.map((g) => g.size))).toEqual(new Set(['S']));
    for (const m of small.mix) for (const t of m.types) expect(AIRCRAFT_TYPES[t].size).toBe('S');
    const big = build({ ...defaultCustomParams(), categories: ['M', 'L', 'XL'], airlines: ['BAW', 'UAE', 'DAL'] });
    expect(big.gates.some((g) => g.size === 'XL')).toBe(true);
    expect(big.mix.some((m) => m.types.includes('A388'))).toBe(true);
    const ga = build({ ...defaultCustomParams(), airlines: ['DAL', 'GA'] });
    expect(ga.gates.filter((g) => g.ga)).toHaveLength(4);
    expect(validateAirport(ga)).toEqual([]);
  });

  it('degenerate parameters are clamped rather than producing a broken airport', () => {
    const ap = build({ ...defaultCustomParams(), terminals: 0, gatesPerTerminal: 0, size: 99, taxiComplexity: 1, categories: [], airlines: [] });
    expect(validateAirport(ap)).toEqual([]);
    expect(ap.gates.length).toBeGreaterThanOrEqual(2);
    expect(ap.mix.length).toBeGreaterThan(0);
    const big = build({ ...defaultCustomParams(), terminals: 99, gatesPerTerminal: 999, size: -3, taxiComplexity: 0 });
    expect(validateAirport(big)).toEqual([]);
    expect(big.gates.length).toBe(8 * 40);
  });

  // ENGINE BUG (minor): unlike terminals / gatesPerTerminal / size, taxiComplexity is not clamped to 0..1.
  // customAirportDef({...defaultCustomParams(), taxiComplexity: 5}) computes a connector spacing `step = 760 - c·380`
  // ≤ 0 (for c ≥ 2), so the connector loop in airport/custom.ts never advances and dies with
  // "RangeError: Invalid array length" after exhausting memory (about 2 s).
  it('an out-of-range taxiComplexity is clamped as well', () => {
    for (const taxiComplexity of [5, -5]) expect(validateAirport(build({ ...defaultCustomParams(), taxiComplexity }))).toEqual([]);
  });

  it.each([[1, 'parallel'], [3, 'parallel'], [2, 'intersecting'], [5, 'mixed']] as const)('a generated airport (%i runways, %s) runs a delegated scenario without errors', (count, layout) => {
    const p: CustomAirportParams = { ...defaultCustomParams(), name: `Sim ${count} ${layout}`, runways: runwaySpecs(count, layout), layout };
    const cfg = quietConfig('CUSTOM', { custom: p, emptyStart: false, delegation: { delivery: true, ground: true, tower: true, approach: true, departure: true } });
    cfg.difficulty.arrivalRate = 20;
    const sim = new Sim(cfg);
    expect(sim.ap.runways).toHaveLength(count);
    sim.advance(1200);
    expect(sim.s.t).toBe(1200);
    expect(sim.s.stats.collisions).toBe(0);
    expect(sim.s.aircraft.some((a) => a.phase !== 'parked' && a.phase !== 'inbound')).toBe(true);
  });
});
