/**
 * Procedural (fictional) airport generator used by the Custom Airport Builder and the
 * built-in regional airport. Produces an AirportDef that goes through the same builder as the
 * real-world layouts, so every runway and gate is connected to a routable taxiway network.
 */
import type { CustomAirportParams, SizeClass, TrafficMixEntry } from '../types';
import type { AirportDef, GateDef, RunwayDef, TaxiwayDef } from './build';
import { AIRCRAFT_TYPES } from '../data/aircraft';
import { angDiff, norm360 } from '../util';

const FLEETS: Record<string, { types: string[]; routes: string[]; weight: number }> = {
  DAL: { types: ['A321', 'B738', 'A320', 'BCS3', 'B752', 'B763', 'A333', 'A359'], routes: ['ATL', 'DTW', 'MSP', 'SLC', 'JFK', 'LAX', 'SEA', 'BOS', 'CDG', 'AMS'], weight: 10 },
  AAL: { types: ['A321', 'B738', 'A319', 'B772', 'B788', 'B789'], routes: ['DFW', 'CLT', 'MIA', 'ORD', 'PHX', 'PHL', 'LHR'], weight: 9 },
  UAL: { types: ['B738', 'B38M', 'A320', 'A319', 'B772', 'B789', 'B78X'], routes: ['ORD', 'DEN', 'IAH', 'EWR', 'SFO', 'IAD', 'FRA'], weight: 9 },
  SWA: { types: ['B737', 'B738', 'B38M'], routes: ['MDW', 'DAL', 'HOU', 'BWI', 'DEN', 'LAS', 'PHX', 'OAK'], weight: 8 },
  JBU: { types: ['A320', 'A321', 'BCS3', 'E190'], routes: ['JFK', 'BOS', 'FLL', 'MCO'], weight: 4 },
  ASA: { types: ['B738', 'B38M', 'E75L'], routes: ['SEA', 'PDX', 'ANC', 'SAN'], weight: 4 },
  NKS: { types: ['A320', 'A321', 'A319'], routes: ['FLL', 'LAS', 'DTW', 'MCO'], weight: 3 },
  FFT: { types: ['A320', 'A321'], routes: ['DEN', 'LAS', 'MCO'], weight: 3 },
  BAW: { types: ['B772', 'B77W', 'B789', 'A359', 'A388'], routes: ['LHR'], weight: 2 },
  DLH: { types: ['A333', 'A359', 'B748'], routes: ['FRA', 'MUC'], weight: 2 },
  AFR: { types: ['A359', 'B772', 'B77W'], routes: ['CDG'], weight: 2 },
  KLM: { types: ['A333', 'B789', 'B78X', 'B772'], routes: ['AMS'], weight: 2 },
  UAE: { types: ['A388', 'B77W'], routes: ['DXB'], weight: 1.5 },
  QTR: { types: ['A359', 'B77W'], routes: ['DOH'], weight: 1.5 },
  THY: { types: ['B77W', 'A359', 'A333'], routes: ['IST'], weight: 1.5 },
  SIA: { types: ['A359', 'A388', 'B77W'], routes: ['SIN'], weight: 1.2 },
  EDV: { types: ['CRJ9', 'CRJ7'], routes: ['ATL', 'DTW', 'MSP', 'JFK'], weight: 4 },
  RPA: { types: ['E170', 'E75L'], routes: ['ORD', 'DCA', 'PHL', 'EWR'], weight: 4 },
  SKW: { types: ['E75L', 'CRJ7', 'CRJ9'], routes: ['DEN', 'SLC', 'ORD', 'SFO'], weight: 4 },
  UPS: { types: ['B763', 'B752', 'B748'], routes: ['SDF', 'ONT', 'PHL'], weight: 1.5 },
  FDX: { types: ['B763', 'B752', 'B772'], routes: ['MEM', 'IND', 'OAK'], weight: 1.5 },
  GA: { types: ['C208', 'C56X', 'PC12'], routes: ['TYS', 'CHA', 'AGS', 'GSP', 'BHM'], weight: 3 },
};
export const CUSTOM_AIRLINES = Object.keys(FLEETS);
const RANK: Record<SizeClass, number> = { S: 0, M: 1, L: 2, XL: 3 };

export function defaultCustomParams(): CustomAirportParams {
  return {
    name: 'Custom Field',
    runways: [
      { length: 3000, hdg: 90, offset: 0, along: 0 },
      { length: 2700, hdg: 90, offset: 0, along: 0 },
    ],
    layout: 'parallel', terminals: 3, gatesPerTerminal: 12, taxiComplexity: 0.5, size: 1,
    categories: ['S', 'M', 'L'], airlines: ['DAL', 'AAL', 'UAL', 'SWA', 'EDV'],
  };
}

/** generate runway specs for a count + layout choice */
export function runwaySpecs(count: number, layout: CustomAirportParams['layout'], baseLen = 2900, baseHdg = 90): CustomAirportParams['runways'] {
  const out: CustomAirportParams['runways'] = [];
  for (let i = 0; i < count; i++) {
    const cross = layout === 'intersecting' ? i % 2 === 1 : layout === 'mixed' ? i >= Math.max(1, Math.ceil(count * 0.6)) : false;
    out.push({ length: Math.max(1200, baseLen - (i % 3) * 250), hdg: norm360(baseHdg + (cross ? (i % 4 === 1 ? 60 : 110) : 0)), offset: 0, along: 0 });
  }
  return out;
}

const rwyNum = (h: number) => { const n = Math.round(norm360(h) / 10) % 36; return n === 0 ? 36 : n; };
const pad = (n: number) => String(n).padStart(2, '0');

export function customAirportDef(p: CustomAirportParams, over: Partial<AirportDef> = {}): AirportDef {
  const sc = Math.min(1.6, Math.max(0.6, p.size));
  const primaryHdg = p.runways[0]?.hdg ?? 90;
  const T: TaxiwayDef[] = [];
  const tw = (name: string, pts: [number, number][], kind: 'taxiway' | 'apron' = 'taxiway') => T.push({ name, pts, kind });

  // ── terminal core (local frame: primary runways run east–west) ──
  const cats = p.categories.length ? p.categories : (['M'] as SizeClass[]);
  const maxCat = cats.reduce((m, c) => (RANK[c] > RANK[m] ? c : m), 'S' as SizeClass);
  const nTerm = Math.max(1, Math.min(8, Math.round(p.terminals)));
  const gpt = Math.max(2, Math.min(40, Math.round(p.gatesPerTerminal)));
  const termWide = (i: number) => RANK[maxCat] >= 2 && i >= nTerm - Math.max(1, Math.round(nTerm * 0.34));
  const perFace = Math.ceil(gpt / 2);
  const pierLen = Math.max(...Array.from({ length: nTerm }, (_, i) => perFace * (termWide(i) ? 75 : 42))) + 40;
  const coreH = pierLen + 150;
  const gates: GateDef[] = [];
  const terminals: { name: string; poly: [number, number][] }[] = [];
  const xs: number[] = [];
  let x = 0;
  for (let i = 0; i < nTerm; i++) {
    const gap = i === 0 ? 0 : termWide(i) || termWide(i - 1) ? 420 * Math.max(1, sc * 0.9) : 300 * Math.max(1, sc * 0.9);
    x += gap;
    xs.push(x);
  }
  const shift = (xs[0] + xs[xs.length - 1]) / 2;
  for (let i = 0; i < xs.length; i++) xs[i] -= shift;
  const yTop = coreH / 2, yBot = -coreH / 2;
  const laneXs: number[] = [];
  const twoLane = p.taxiComplexity > 0.65;
  for (let i = 0; i <= nTerm; i++) {
    const left = i === 0 ? xs[0] - (termWide(0) ? 190 : 150) : xs[i - 1];
    const right = i === nTerm ? xs[nTerm - 1] + (termWide(nTerm - 1) ? 190 : 150) : xs[i];
    const mid = i === 0 ? left : i === nTerm ? right : (left + right) / 2;
    const name = `R${i + 1}`;
    if (i > 0 && i < nTerm && twoLane) {
      tw(name, [[mid - 38, yBot - 60], [mid - 38, yTop + 60]], 'apron');
      tw(name, [[mid + 38, yBot - 60], [mid + 38, yTop + 60]], 'apron');
      tw(name, [[mid - 38, 0], [mid + 38, 0]], 'apron');
    } else tw(name, [[mid, yBot - 60], [mid, yTop + 60]], 'apron');
    laneXs.push(mid);
  }
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const gaWanted = p.airlines.includes('GA');
  for (let i = 0; i < nTerm; i++) {
    const wide = termWide(i);
    const step = wide ? 75 : 42;
    const tn = nTerm === 1 ? 'A' : letters[i];
    const half = (perFace * step) / 2;
    terminals.push({ name: `Terminal ${tn}`, poly: [[xs[i] - 14, -half - 15], [xs[i] + 14, -half - 15], [xs[i] + 14, half + 15], [xs[i] - 14, half + 15]] });
    for (let g = 0; g < gpt; g++) {
      const face = g % 2 === 0 ? -1 : 1;
      const row = Math.floor(g / 2);
      const lane = face < 0 ? laneXs[i] + (twoLane && i > 0 ? 38 : 0) : laneXs[i + 1] - (twoLane && i < nTerm - 1 ? 38 : 0);
      const depthMax = Math.abs(lane - xs[i]) - (wide ? 100 : 54);
      const gx = xs[i] + face * Math.max(wide ? 60 : 44, depthMax);
      let size: SizeClass = wide ? (maxCat === 'XL' && row % 3 === 1 ? 'XL' : 'L') : cats.includes('M') || RANK[maxCat] >= 1 ? 'M' : 'S';
      if (!wide && cats.includes('S') && !cats.includes('M') && maxCat !== 'S') size = 'M';
      gates.push({ name: `${tn}${g + 1}`, terminal: tn, x: gx, y: -half + step / 2 + row * step, size });
    }
  }
  const coreL = laneXs[0] - 60, coreR = laneXs[laneXs.length - 1] + 60;

  // ── runways ──
  const prim = p.runways.filter((r) => Math.abs(angDiff(primaryHdg, r.hdg)) < 25 || Math.abs(angDiff(primaryHdg, r.hdg)) > 155);
  const cross = p.runways.filter((r) => !prim.includes(r));
  const runways: RunwayDef[] = [];
  interface PR { y: number; x0: number; x1: number; side: 1 | -1; idx: number }
  const prs: PR[] = [];
  const yA = yTop + 60, yB = yBot - 60;
  let nN = 0, nS = 0;
  prim.forEach((r, i) => {
    const side: 1 | -1 = i % 2 === 0 ? 1 : -1;
    const k = side === 1 ? nN++ : nS++;
    const y = side === 1 ? yA + 190 + k * 420 * Math.max(0.9, sc) : yB - 190 - k * 420 * Math.max(0.9, sc);
    const stagger = (i % 2 === 0 ? 1 : -1) * Math.min(250, i * 60);
    prs.push({ y, x0: -r.length / 2 + stagger + r.along, x1: r.length / 2 + stagger + r.along, side, idx: i });
  });
  const allX0 = Math.min(coreL, ...prs.map((r) => r.x0)), allX1 = Math.max(coreR, ...prs.map((r) => r.x1));
  // core taxiways
  tw('A', [[allX0, yA], [allX1, yA]]);
  tw('B', [[allX0, yB], [allX1, yB]]);
  // ring links at the ends
  tw('C', [[allX0, yB], [allX0, yA]]);
  tw('D', [[allX1, yB], [allX1, yA]]);
  const step = 760 - p.taxiComplexity * 380;
  let cn = 1;
  const sorted = [...prs].sort((a, b) => Math.abs(a.y) - Math.abs(b.y));
  for (const r of sorted) {
    const inner = r.side === 1 ? yA : yB;
    const k = Math.round((Math.abs(r.y - inner) - 190) / (420 * Math.max(0.9, sc)));
    const from = k === 0 ? inner : r.y - r.side * 210 * Math.max(0.9, sc);
    const pname = r.side === 1 ? `N${k}` : `S${k}`;
    if (k > 0) tw(pname, [[Math.min(r.x0, allX0), from], [Math.max(r.x1, allX1), from]]);
    const xsConn: number[] = [r.x0 + 14, r.x1 - 14];
    for (let cx = r.x0 + step; cx < r.x1 - step * 0.6; cx += step) xsConn.push(cx);
    for (const cx of xsConn) {
      // connectors of outer runways run all the way to the core taxiway, crossing inner runways
      tw(`${pname === 'N0' || pname === 'S0' ? (r.side === 1 ? 'E' : 'F') : pname}${cn++}`, [[cx, inner], [cx, r.y]]);
    }
    if (p.taxiComplexity > 0.35) {
      const dy = Math.abs(r.y - from);
      const span = r.x1 - r.x0;
      for (const [fx, dir] of [[0.42, -1], [0.58, 1]] as const) {
        const hx = r.x0 + span * fx;
        const tx = hx + dir * dy * 1.73;
        if (!xsConn.some((c) => (c - hx) * (c - tx) < 0 || Math.abs(c - hx) < 40 || Math.abs(c - tx) < 40))
          tw(`H${cn++}`, [[hx, r.y], [tx, from]]);
      }
    }
  }
  // local → world rotation (primary heading)
  const rot = ((primaryHdg - 90) * Math.PI) / 180;
  const R = (px: number, py: number): [number, number] => [Math.round(px * Math.cos(rot) + py * Math.sin(rot)), Math.round(-px * Math.sin(rot) + py * Math.cos(rot))];
  const rwyLocal: { ax: number; ay: number; bx: number; by: number; hdg: number }[] = prs.map((r) => ({ ax: r.x0, ay: r.y, bx: r.x1, by: r.y, hdg: primaryHdg }));

  // crosswind runways: beyond the core on alternating sides, crossing the primary complex
  cross.forEach((r, i) => {
    const side = i % 2 === 0 ? 1 : -1;
    const k = Math.floor(i / 2);
    const cx = side * (Math.max(Math.abs(coreL), Math.abs(coreR)) + 330 + k * 430);
    const rel = (angDiff(primaryHdg, r.hdg) * Math.PI) / 180; // angle from local east, clockwise
    const ux = Math.cos(rel), uy = -Math.sin(rel);
    const cy = r.along * 0.5;
    const ax = cx - (ux * r.length) / 2, ay = cy - (uy * r.length) / 2;
    const bx = cx + (ux * r.length) / 2, by = cy + (uy * r.length) / 2;
    rwyLocal.push({ ax, ay, bx, by, hdg: r.hdg });
    // parallel taxiway on the core side
    const nx = -uy, ny = ux;
    const sgn = nx * -cx + ny * -cy > 0 ? 1 : -1;
    const ox = nx * sgn * 180, oy = ny * sgn * 180;
    const name = `K${i + 1}`;
    tw(name, [[ax + ox, ay + oy], [bx + ox, by + oy]]);
    const n = Math.max(2, Math.round(r.length / step));
    for (let j = 0; j <= n; j++) {
      const f = j === 0 ? 14 / r.length : j === n ? 1 - 14 / r.length : j / n;
      const px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
      tw(`${name}${j + 1}`, [[px, py], [px + ox, py + oy]]);
    }
    // guarantee a link from the crosswind parallel into the core ring
    const mx = cx + ox, my = cy + oy;
    tw(`${name}L`, [[mx, my], [side > 0 ? allX1 : allX0, Math.max(yB, Math.min(yA, my))]]);
  });

  // runway designators
  const groups = new Map<number, number[]>();
  rwyLocal.forEach((r, i) => {
    const n = rwyNum(r.hdg) > 18 ? rwyNum(r.hdg) - 18 : rwyNum(r.hdg);
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n)!.push(i);
  });
  const names: [string, string][] = [];
  for (const [n, idxs] of groups) {
    // order left→right looking along the low-numbered heading
    const h = (n * 10 * Math.PI) / 180;
    const rightOf = (i: number) => { const r = rwyLocal[i]; const [wx, wy] = R((r.ax + r.bx) / 2, (r.ay + r.by) / 2); return wx * Math.cos(h) - wy * Math.sin(h); };
    idxs.sort((a, b) => rightOf(a) - rightOf(b));
    for (let c = 0; c * 3 < idxs.length || c * 2 < idxs.length; c++) {
      const chunk = idxs.length === 3 ? idxs : idxs.slice(c * 2, c * 2 + 2);
      if (!chunk.length) break;
      const lo = ((n - 1 + c) % 36) + 1, hi = ((lo + 17) % 36) + 1;
      const sfx = chunk.length === 1 ? [['', '']] : chunk.length === 2 ? [['L', 'R'], ['R', 'L']] : [['L', 'R'], ['C', 'C'], ['R', 'L']];
      chunk.forEach((ri, j) => (names[ri] = [`${pad(lo)}${sfx[j][0]}`, `${pad(hi)}${sfx[j][1]}`]));
      if (idxs.length === 3) break;
    }
  }
  rwyLocal.forEach((r, i) => {
    const [ax, ay] = R(r.ax, r.ay), [bx, by] = R(r.bx, r.by);
    const lowFirst = rwyNum(r.hdg) <= 18;
    // a→b must point along the low designator
    const hd = norm360((Math.atan2(bx - ax, by - ay) * 180) / Math.PI);
    const alongLow = Math.abs(angDiff(hd, +names[i][0].slice(0, 2) * 10)) < 90;
    void lowFirst;
    runways.push(alongLow
      ? { a: { name: names[i][0], x: ax, y: ay }, b: { name: names[i][1], x: bx, y: by } }
      : { a: { name: names[i][0], x: bx, y: by }, b: { name: names[i][1], x: ax, y: ay } });
  });

  // GA apron
  if (gaWanted) {
    const gx = allX0 + 260;
    tw('GA', [[gx - 120, yB - 0.01], [gx - 120, yB + 110], [gx + 120, yB + 110], [gx + 120, yB]], 'apron');
    for (let i = 0; i < 4; i++) gates.push({ name: `GA${i + 1}`, terminal: 'GA', x: gx - 90 + i * 60, y: yB + 160, size: 'S', ga: true, airlines: ['GA'] });
    terminals.push({ name: 'General Aviation', poly: [[gx - 120, yB + 195], [gx + 120, yB + 195], [gx + 120, yB + 215], [gx - 120, yB + 215]] });
  }

  const airlines = p.airlines.length ? p.airlines : ['DAL', 'AAL', 'UAL'];
  const mix: TrafficMixEntry[] = [];
  for (const a of airlines) {
    const f = FLEETS[a];
    if (!f) continue;
    const types = f.types.filter((t) => AIRCRAFT_TYPES[t] && (a === 'GA' || (cats.includes(AIRCRAFT_TYPES[t].size) || RANK[AIRCRAFT_TYPES[t].size] < RANK[maxCat] && cats.some((c) => RANK[c] >= RANK[AIRCRAFT_TYPES[t].size]))));
    if (types.length && !(FLEETS[a] && (a === 'UPS' || a === 'FDX'))) mix.push({ airline: a, weight: f.weight, types, routes: f.routes });
  }
  if (!mix.length) mix.push({ airline: 'SKW', weight: 1, types: ['E75L', 'CRJ7'], routes: FLEETS.SKW.routes });

  const rotPts = (pts: [number, number][]) => pts.map(([px, py]) => R(px, py));
  const lowEnds = runways.map((r) => r.a.name), highEnds = runways.map((r) => r.b.name);
  const half = Math.ceil(runways.length / 2);
  return {
    id: 'CUSTOM', icao: 'XCST', iata: 'XCS', name: `${p.name} (fictional)`, city: p.name, facility: p.name.split(' ')[0] || 'Custom',
    elevation: 600, fictional: true,
    dataNote: 'Fictional airport generated by the Custom Airport Builder. Not a real-world layout.',
    runways,
    taxiways: T.map((t) => ({ ...t, pts: rotPts(t.pts) })),
    terminals: terminals.map((t) => ({ ...t, poly: rotPts(t.poly) })),
    aprons: [rotPts([[coreL - 30, yBot - 20], [coreR + 30, yBot - 20], [coreR + 30, yTop + 20], [coreL - 30, yTop + 20]])],
    gates: gates.map((g) => { const [gx, gy] = R(g.x, g.y); return { ...g, x: gx, y: gy }; }),
    configs: runways.length === 1
      ? [{ name: `Runway ${lowEnds[0]}`, arr: [lowEnds[0]], dep: [lowEnds[0]] }, { name: `Runway ${highEnds[0]}`, arr: [highEnds[0]], dep: [highEnds[0]] }]
      : [
        { name: 'Flow A', arr: lowEnds.slice(0, half), dep: lowEnds.slice(half).length ? lowEnds.slice(half) : lowEnds },
        { name: 'Flow B', arr: highEnds.slice(0, half), dep: highEnds.slice(half).length ? highEnds.slice(half) : highEnds },
      ],
    mix,
    baseRate: Math.min(100, 18 + runways.length * 14 + Math.min(40, gates.length * 0.3)),
    towerPos: R(coreL - 40, yTop - 40),
    airspaceRadiusNm: runways.length <= 1 && gates.length < 20 ? 24 : 30,
    ...over,
  };
}
