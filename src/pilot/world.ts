/**
 * World layout for a flight: where the airports sit, runway choice, routes, taxi paths,
 * pavement lookup, ILS geometry and wind.
 *
 * The world is a flat plane. The departure airport is at the origin; the destination is placed at
 * its real great-circle distance and initial bearing. Enroute waypoints are SYNTHETIC points on
 * the straight line between the two (they are not real published fixes), ILS frequencies are
 * synthetic, and headings are true (no magnetic variation).
 */
import type { Airport, Gate } from '../sim/types';
import { AIRPORT_DEFS, getAirport } from '../sim/airport';
import { holdsOf, runwayZoneAt, toraFrom, nearestNode, gateByName } from '../sim/airport/query';
import { findRoute } from '../sim/pathfind';
import { DEG, FT, KT, NM, alongCross, angDiff, clamp, dist, hdgOf, norm360, projSeg, vecOf } from '../sim/util';
import { ACDEF } from './aircraft';
import type { AcKind, IlsState, PilotConfig, PilotState, PlacedAirport, Pushback, RunwayRef, TaxiRoute, Wp } from './types';

/** real aerodrome reference points (public data, rounded). REG is fictional and placed for training hops. */
export const AP_GEO: Record<string, { lat: number; lon: number }> = {
  ATL: { lat: 33.6407, lon: -84.4277 },
  JFK: { lat: 40.6413, lon: -73.7781 },
  LAX: { lat: 33.9416, lon: -118.4085 },
  EGLL: { lat: 51.47, lon: -0.4543 },
  LGA: { lat: 40.7769, lon: -73.874 },
  REG: { lat: 34.72, lon: -83.3 }, // fictional field ~85 NM north-east of Atlanta
};

export function greatCircle(a: { lat: number; lon: number }, b: { lat: number; lon: number }): { nm: number; brg: number } {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * 6371000 * Math.asin(Math.sqrt(h));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { nm: d / NM, brg: norm360(Math.atan2(y, x) / DEG) };
}

export const routeDistanceNm = (depId: string, destId: string) => (depId === destId ? 0 : greatCircle(AP_GEO[depId], AP_GEO[destId]).nm);
export const pilotAirports = () => AIRPORT_DEFS.map((d) => ({ id: d.id, icao: d.icao, name: d.name, city: d.city, fictional: d.fictional }));

const WX: Record<PilotConfig['weather'], { kt: number; off: number; vis: number; base: number; aloft: number }> = {
  clear: { kt: 5, off: 20, vis: 40000, base: 99999, aloft: 25 },
  breezy: { kt: 14, off: 25, vis: 30000, base: 99999, aloft: 45 },
  crosswind: { kt: 15, off: 70, vis: 25000, base: 99999, aloft: 40 },
  overcast: { kt: 9, off: 30, vis: 12000, base: 1800, aloft: 50 },
  lowvis: { kt: 6, off: 20, vis: 2400, base: 500, aloft: 35 },
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const freqOf = (key: string, lo: number, hi: number) => Math.round((lo + ((hash(key) % 1000) / 1000) * (hi - lo)) * 20) / 20;

export function placeAirports(cfg: PilotConfig): PlacedAirport[] {
  const ids = cfg.kind === 'route' && cfg.destId !== cfg.depId ? [cfg.depId, cfg.destId] : [cfg.depId];
  const wx = WX[cfg.weather];
  return ids.map((id, i) => {
    const ap = getAirport({ airportId: id });
    const geo = AP_GEO[id] ?? AP_GEO.ATL;
    let ox = 0, oy = 0;
    if (i === 1) {
      const g = greatCircle(AP_GEO[ids[0]], geo);
      const [ux, uy] = vecOf(g.brg);
      ox = ux * g.nm * NM;
      oy = uy * g.nm * NM;
    }
    // surface wind: roughly aligned with the longest runway, offset by the weather preset
    const longest = [...ap.runways].sort((a, b) => b.length - a.length)[0];
    const base = longest.ends[(hash(id + cfg.seed) & 1) as 0 | 1].hdg;
    const sign = hash(id + 'x' + cfg.seed) & 2 ? 1 : -1;
    return {
      ap, ox, oy, elev: ap.elevation * FT, lat: geo.lat, lon: geo.lon,
      qnh: 1003 + (hash(id + 'q' + cfg.seed) % 24),
      wind: { dir: Math.round(norm360(base + sign * wx.off) / 10) * 10, kt: wx.kt },
      freq: {
        atis: freqOf(id + 'atis', 126, 128.9), clearance: freqOf(id + 'cd', 118.05, 121.4), ground: freqOf(id + 'gnd', 121.6, 121.95),
        tower: freqOf(id + 'twr', 118.1, 120.9), departure: freqOf(id + 'dep', 124, 125.9), approach: freqOf(id + 'app', 119, 120.95),
      },
    };
  });
}

export function makeEnv(cfg: PilotConfig, dep: PlacedAirport) {
  const wx = WX[cfg.weather];
  return { hour: cfg.hour, vis: wx.vis, cloudBase: wx.base, windAloft: { dir: norm360(dep.wind.dir + 30), kt: wx.aloft }, tempC: 15 };
}

/** index of the airport nearest to a world point */
export function nearestAirport(p: PilotState, x: number, y: number): number {
  if (p.airports.length < 2) return 0;
  const a = p.airports[0], b = p.airports[1];
  return (x - a.ox) ** 2 + (y - a.oy) ** 2 <= (x - b.ox) ** 2 + (y - b.oy) ** 2 ? 0 : 1;
}

/** ground elevation in metres: each airport's own elevation, blended in the middle of the route */
export function groundElev(p: PilotState, x: number, y: number): number {
  const a = p.airports[0];
  if (p.airports.length < 2) return a.elev;
  const b = p.airports[1];
  const dx = b.ox - a.ox, dy = b.oy - a.oy;
  const f = clamp(((x - a.ox) * dx + (y - a.oy) * dy) / (dx * dx + dy * dy), 0, 1);
  const t = clamp((f - 0.4) / 0.2, 0, 1);
  return a.elev + (b.elev - a.elev) * t * t * (3 - 2 * t);
}

/** wind vector (m/s, the direction the air moves TOWARD) at a position and height */
export function windAt(p: PilotState, x: number, y: number, z: number): { dir: number; kt: number; vx: number; vy: number } {
  const pa = p.airports[nearestAirport(p, x, y)];
  const agl = Math.max(0, z - pa.elev);
  const f = clamp(agl / 9000, 0, 1);
  // boundary layer: wind falls off near the surface
  const sfc = pa.wind.kt * clamp(0.75 + agl / 400, 0.75, 1);
  const kt = sfc + (p.env.windAloft.kt - sfc) * f;
  const dir = norm360(pa.wind.dir + angDiff(pa.wind.dir, p.env.windAloft.dir) * f);
  const [ux, uy] = vecOf(dir + 180);
  return { dir, kt, vx: ux * kt * KT, vy: uy * kt * KT };
}

export function runwayRef(airports: PlacedAirport[], apIdx: number, rwyId: string, endIdx: 0 | 1, kind: AcKind): RunwayRef {
  const pa = airports[apIdx];
  const r = pa.ap.runways.find((x) => x.id === rwyId)!;
  const e = r.ends[endIdx];
  return {
    apIdx, rwyId, endIdx, name: e.name, hdg: e.hdg, thrX: e.x + pa.ox, thrY: e.y + pa.oy, length: r.length, width: r.width, elev: pa.elev,
    ilsFreq: Math.round((108.1 + (hash(pa.ap.icao + e.name) % 40) * 0.2) * 100) / 100,
    aim: kind === 'jet' ? 300 : Math.min(150, r.length * 0.1),
  };
}

/** choose the runway end with the best headwind that is long enough */
export function pickRunway(airports: PlacedAirport[], apIdx: number, kind: AcKind): RunwayRef {
  const pa = airports[apIdx];
  const need = kind === 'jet' ? 1900 : 500;
  let best: { id: string; idx: 0 | 1; score: number } | null = null;
  for (const r of pa.ap.runways) {
    for (const idx of [0, 1] as const) {
      const head = Math.cos(angDiff(r.ends[idx].hdg, pa.wind.dir) * DEG) * pa.wind.kt;
      const score = head * 100 + r.length * 0.01 + (r.length >= need ? 5000 : 0) + (r.ends[idx].ils ? 20 : 0);
      if (!best || score > best.score) best = { id: r.id, idx, score };
    }
  }
  return runwayRef(airports, apIdx, best!.id, best!.idx, kind);
}

/** point on a runway's extended centreline: `back` metres before the threshold, `right` metres to the right of the landing direction */
export function rwyPoint(r: RunwayRef, back: number, right = 0): [number, number] {
  const [ux, uy] = vecOf(r.hdg);
  return [r.thrX - ux * back + uy * right, r.thrY - uy * back - ux * right];
}

export function cruiseAltFor(kind: AcKind, nm: number, brg: number, fieldFt: number): number {
  const east = brg < 180;
  if (kind === 'c172') {
    if (nm < 15) return Math.ceil((fieldFt + 1500) / 500) * 500;
    const base = nm < 60 ? (east ? 3500 : 4500) : east ? 5500 : 6500;
    return base + (fieldFt > base - 2000 ? 2000 : 0);
  }
  if (nm < 40) return 6000;
  if (nm < 110) return east ? 13000 : 14000;
  if (nm < 250) return east ? 23000 : 24000;
  if (nm < 500) return east ? 31000 : 32000;
  return east ? 35000 : 36000;
}

/** approach waypoints (base, final fix, runway) for a landing runway, arriving from (fx, fy) */
export function approachWps(kind: AcKind, r: RunwayRef, fx: number, fy: number): Wp[] {
  const jet = kind === 'jet';
  const elevFt = r.elev / FT;
  const [along, cross] = alongCross(fx, fy, r.thrX, r.thrY, r.hdg);
  const side = cross >= 0 ? 1 : -1;
  const fin = (jet ? 10 : 3) * NM, baseBack = (jet ? 16 : 5) * NM, lat = (jet ? 6 : 2) * NM;
  const out: Wp[] = [];
  const round = (ft: number) => Math.round(ft / 100) * 100;
  // arriving from the departure side of the runway: fly a downwind first
  if (along > -baseBack * 0.6) {
    const [dx, dy] = rwyPoint(r, jet ? -2 * NM : 0, side * lat);
    out.push({ name: 'DOWNWIND', x: dx, y: dy, alt: round(elevFt + (jet ? 6000 : 1500)), spd: jet ? 220 : 90, kind: 'arrival' });
  }
  const [bx, by] = rwyPoint(r, baseBack, side * lat);
  out.push({ name: 'BASE', x: bx, y: by, alt: round(elevFt + (jet ? 4000 : 1500)), spd: jet ? 200 : 85, kind: 'base' });
  const [px, py] = rwyPoint(r, fin);
  out.push({ name: `F${r.name}`, x: px, y: py, alt: round(elevFt + (jet ? 3000 : 1000)), spd: jet ? 180 : 75, kind: 'final' });
  const [tx, ty] = rwyPoint(r, 0);
  out.push({ name: `RW${r.name}`, x: tx, y: ty, alt: Math.round(elevFt), kind: 'rwy' });
  return out;
}

/** left-hand traffic pattern for circuit training */
export function patternWps(kind: AcKind, r: RunwayRef): Wp[] {
  const jet = kind === 'jet';
  const elevFt = r.elev / FT;
  const pa = Math.round((elevFt + (jet ? 1500 : 1000)) / 100) * 100;
  const lat = -(jet ? 3 : 1) * NM; // left of the runway
  const up = r.length + (jet ? 2.5 : 0.7) * NM, base = (jet ? 5 : 1.3) * NM;
  const gp = (back: number) => elevFt + (Math.tan(3 * DEG) * (back + r.aim)) / FT;
  const mk = (name: string, back: number, right: number, alt: number, kindW: Wp['kind'], spd?: number): Wp => { const [x, y] = rwyPoint(r, back, right); return { name, x, y, alt: Math.round(alt / 50) * 50, kind: kindW, spd }; };
  return [
    mk('UPWIND', -up, 0, pa, 'pattern', jet ? 180 : 75),
    mk('XWIND', -up, lat, pa, 'pattern', jet ? 200 : 85),
    mk('DOWNWIND', 0, lat, pa, 'pattern', jet ? 190 : 85),
    mk('BASE', base, lat, Math.min(pa, gp(base) + (jet ? -250 : 250)), 'base', jet ? 170 : 75),
    mk(`F${r.name}`, base, 0, gp(base) - (jet ? 250 : 0), 'final', jet ? 150 : 70),
    mk(`RW${r.name}`, 0, 0, elevFt, 'rwy'),
  ];
}

export function buildRoute(cfg: PilotConfig, airports: PlacedAirport[], dep: RunwayRef, arr: RunwayRef): { route: Wp[]; cruise: number } {
  const kind = cfg.aircraft;
  const jet = kind === 'jet';
  if (cfg.kind === 'pattern') return { route: patternWps(kind, arr), cruise: patternWps(kind, arr)[0].alt! };
  if (cfg.kind === 'approach') {
    const fin = (jet ? 10 : 4) * NM;
    const [x, y] = rwyPoint(arr, fin * 0.45);
    const altAt = (back: number) => Math.round((arr.elev + Math.tan(3 * DEG) * (back + arr.aim)) / FT / 10) * 10;
    return { route: [{ name: `F${arr.name}`, x, y, alt: altAt(fin * 0.45), kind: 'final', spd: jet ? 160 : 70 }, { name: `RW${arr.name}`, x: arr.thrX, y: arr.thrY, alt: Math.round(arr.elev / FT), kind: 'rwy' }], cruise: altAt(fin) };
  }
  const a = airports[0], b = airports[1];
  const g = greatCircle(a, b);
  const cruise = cruiseAltFor(kind, g.nm, g.brg, Math.max(a.ap.elevation, b.ap.elevation));
  const route: Wp[] = [];
  // departure fix straight ahead of the runway
  const [dx, dy] = rwyPoint(dep, -(dep.length + (jet ? 5 : 1.5) * NM));
  route.push({ name: 'DEP', x: dx, y: dy, alt: Math.min(cruise, Math.round((dep.elev / FT + (jet ? 4000 : 1000)) / 100) * 100), kind: 'dep', spd: jet ? 250 : 76 });
  const app = approachWps(kind, arr, a.ox, a.oy);
  const first = app[0];
  const total = dist(dx, dy, first.x, first.y);
  const step = (jet ? 120 : 20) * NM;
  const n = Math.floor(total / step);
  for (let i = 1; i <= n; i++) {
    const f = (i * step) / total;
    if (total - i * step < step * 0.4) break;
    route.push({ name: `WP${String(i).padStart(2, '0')}`, x: dx + (first.x - dx) * f, y: dy + (first.y - dy) * f, alt: cruise, kind: 'enroute' });
  }
  route.push(...app);
  return { route, cruise };
}

// ───────────────────────────── surface ─────────────────────────────

const ORDER = ['S', 'M', 'L', 'XL'];
export function pickGate(ap: Airport, kind: AcKind, seed: number, avoid?: string): Gate {
  const min = kind === 'jet' ? 1 : 0;
  let c = ap.gates.filter((g) => !g.cargo && ORDER.indexOf(g.size) >= min && g.name !== avoid);
  if (kind === 'c172') { const ga = c.filter((g) => g.ga || g.size === 'S'); if (ga.length) c = ga; }
  else { const std = c.filter((g) => !g.ga && g.size !== 'XL'); if (std.length) c = std; }
  if (!c.length) c = ap.gates;
  return c[hash(ap.icao + kind + seed) % c.length];
}

const toWorld = (pa: PlacedAirport, id: number): [number, number] => [pa.ap.nodes[id].x + pa.ox, pa.ap.nodes[id].y + pa.oy];

/** taxi route from the stand to the departure runway, plus the pushback path for aircraft that need one */
export function planTaxiOut(p: PilotState): { taxi: TaxiRoute; push: Pushback | null; gateHdg: number; gatePos: [number, number] } | null {
  const pa = p.airports[p.depRwy.apIdx];
  const ap = pa.ap;
  const gate = gateByName(ap, p.depGate);
  if (!gate) return null;
  const def = ACDEF[p.cfg.aircraft];
  const need = p.cfg.aircraft === 'jet' ? Math.min(2000, p.depRwy.length * 0.8) : Math.min(700, p.depRwy.length * 0.5);
  const rwy = ap.runways.find((r) => r.id === p.depRwy.rwyId)!;
  let holds = holdsOf(ap, rwy.id).filter((h) => toraFrom(h, p.depRwy.endIdx) >= need);
  if (!holds.length) holds = holdsOf(ap, rwy.id);
  if (!holds.length) return null;
  const info = new Map(holds.map((h) => [h.hold, h]));
  const route = findRoute(ap, gate.lane, holds.map((h) => h.hold), { prev: gate.node, goalCost: (n) => (rwy.length - toraFrom(info.get(n)!, p.depRwy.endIdx)) * 4 });
  if (!route) return null;
  const hold = info.get(route.nodes[route.nodes.length - 1])!;
  const gatePos = toWorld(pa, gate.node), lane = toWorld(pa, gate.lane);
  const pts: [number, number][] = [];
  let push: Pushback | null = null;
  const next = route.nodes.length > 1 ? toWorld(pa, route.nodes[1]) : lane;
  if (p.cfg.aircraft === 'jet') {
    // tail goes away from the first taxi direction so the nose ends up pointing along the route
    const want = hdgOf(lane[0] - next[0], lane[1] - next[1]);
    let dir = want, bestD = 60;
    for (const eid of ap.adj[gate.lane]) {
      const e = ap.edges[eid];
      const v = e.a === gate.lane ? e.b : e.a;
      if (v === gate.node || e.kind === 'gate') continue;
      const w = toWorld(pa, v);
      const d = Math.abs(angDiff(want, hdgOf(w[0] - lane[0], w[1] - lane[1])));
      if (d < bestD) { bestD = d; dir = hdgOf(w[0] - lane[0], w[1] - lane[1]); }
    }
    const L = def.length + 12;
    const [ux, uy] = vecOf(dir);
    const end: [number, number] = [lane[0] + ux * L, lane[1] + uy * L];
    const path = [gatePos, lane, end];
    push = { pts: path, s: 0, len: dist(gatePos[0], gatePos[1], lane[0], lane[1]) + L, done: false };
    pts.push(end, lane);
  } else {
    pts.push(gatePos, lane);
  }
  for (let i = 1; i < route.nodes.length; i++) pts.push(toWorld(pa, route.nodes[i]));
  const holdPt = toWorld(pa, hold.hold);
  for (let i = 1; i < hold.path.length; i++) pts.push(toWorld(pa, hold.path[i]));
  // lead the line onto the runway heading
  const [ux, uy] = vecOf(p.depRwy.hdg);
  const last = pts[pts.length - 1];
  pts.push([last[0] + ux * 120, last[1] + uy * 120]);
  const crosses = [...new Set(route.nodes.map((n) => ap.nodes[n]).filter((n) => n.kind === 'rwy' && n.rwy && n.rwy !== rwy.id).map((n) => n.rwy!))];
  return { taxi: { pts, names: route.names.filter(Boolean), hold: holdPt, crosses }, push, gateHdg: gate.hdg, gatePos };
}

/** route from the aircraft's present position (after vacating) to the arrival stand */
export function planTaxiIn(p: PilotState): TaxiRoute | null {
  const pa = p.airports[p.arrRwy.apIdx];
  const ap = pa.ap;
  const gate = gateByName(ap, p.arrGate);
  if (!gate) return null;
  const lx = p.ac.x - pa.ox, ly = p.ac.y - pa.oy;
  const [fx, fy] = vecOf(p.ac.hdg);
  let route: ReturnType<typeof findRoute> = null;
  const sf = surfaceAt(p, p.ac.x, p.ac.y);
  if (sf.kind === 'runway' && sf.rwy) {
    // still on the runway: continue along the centreline and leave at the first exit that does not need a sharp turn back
    const rw = ap.runways.find((r) => r.id === sf.rwy)!;
    const fwd = Math.abs(angDiff(p.ac.hdg, rw.ends[0].hdg)) < 90;
    const order = fwd ? rw.nodes : [...rw.nodes].reverse();
    const rh = fwd ? rw.ends[0].hdg : rw.ends[1].hdg;
    const minAhead = 20 + (p.ac.gs * p.ac.gs) / 3;
    for (let i = 0; i < order.length && !route; i++) {
      const n = ap.nodes[order[i]];
      if ((n.x - lx) * fx + (n.y - ly) * fy < minAhead) continue;
      const r = findRoute(ap, order[i], gate.node, { prev: i > 0 ? order[i - 1] : undefined });
      if (!r || r.nodes.length < 2) continue;
      // skip along the runway to where the route actually turns off
      let k = 1;
      while (k < r.nodes.length - 1 && ap.nodes[r.nodes[k]].kind === 'rwy' && ap.nodes[r.nodes[k]].rwy === rw.id) k++;
      const a0 = ap.nodes[r.nodes[k - 1]], a1 = ap.nodes[r.nodes[k]];
      if (Math.abs(angDiff(rh, hdgOf(a1.x - a0.x, a1.y - a0.y))) <= 100) route = r;
    }
  }
  if (!route) {
    // prefer a node ahead of the aircraft that is not on a runway
    const start = nearestNode(ap, lx + fx * 40, ly + fy * 40, (n) => n.kind === 'twy' || n.kind === 'hold' || n.kind === 'apron') ?? nearestNode(ap, lx, ly, (n) => n.kind !== 'gate');
    if (!start) return null;
    route = findRoute(ap, start.id, gate.node);
  }
  if (!route) return null;
  const pts: [number, number][] = [[p.ac.x, p.ac.y], ...route.nodes.map((n) => toWorld(pa, n))];
  const crosses = [...new Set(route.nodes.map((n) => ap.nodes[n]).filter((n) => n.kind === 'rwy' && n.rwy).map((n) => n.rwy!))];
  return { pts, names: route.names.filter(Boolean), crosses };
}

interface Pave { segs: Float64Array; half: Float32Array; n: number }
const paveCache = new WeakMap<Airport, Pave>();
function paveOf(ap: Airport): Pave {
  let c = paveCache.get(ap);
  if (!c) {
    const es = ap.edges.filter((e) => e.kind !== 'runway');
    c = { segs: new Float64Array(es.length * 4), half: new Float32Array(es.length), n: es.length };
    es.forEach((e, i) => {
      const a = ap.nodes[e.a], b = ap.nodes[e.b];
      c!.segs.set([a.x, a.y, b.x, b.y], i * 4);
      c!.half[i] = e.kind === 'taxiway' ? 17 : e.kind === 'apron' ? 26 : 24;
    });
    paveCache.set(ap, c);
  }
  return c;
}
function inPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** what kind of surface is under a world point, and which runway (if any) */
export function surfaceAt(p: PilotState, x: number, y: number): { kind: 'runway' | 'taxiway' | 'apron' | 'grass'; rwy?: string } {
  const pa = p.airports[nearestAirport(p, x, y)];
  const ap = pa.ap;
  const lx = x - pa.ox, ly = y - pa.oy;
  if (Math.abs(lx) > 12000 || Math.abs(ly) > 12000) return { kind: 'grass' };
  for (const r of ap.runways) {
    const [ux, uy] = vecOf(r.ends[0].hdg);
    const al = (lx - r.ends[0].x) * ux + (ly - r.ends[0].y) * uy;
    const cr = Math.abs((lx - r.ends[0].x) * uy - (ly - r.ends[0].y) * ux);
    if (al > -75 && al < r.length + 75 && cr < r.width / 2 + 4) return { kind: 'runway', rwy: r.id };
  }
  const pv = paveOf(ap);
  for (let i = 0; i < pv.n; i++) {
    const o = i * 4, h = pv.half[i];
    const ax = pv.segs[o], ay = pv.segs[o + 1], bx = pv.segs[o + 2], by = pv.segs[o + 3];
    if (lx < Math.min(ax, bx) - h || lx > Math.max(ax, bx) + h || ly < Math.min(ay, by) - h || ly > Math.max(ay, by) + h) continue;
    if (projSeg(lx, ly, ax, ay, bx, by)[1] < h) return { kind: 'taxiway' };
  }
  for (const poly of ap.aprons) if (inPoly(lx, ly, poly)) return { kind: 'apron' };
  for (const g of ap.gates) { const n = ap.nodes[g.node]; if ((n.x - lx) ** 2 + (n.y - ly) ** 2 < 55 * 55) return { kind: 'apron' }; }
  return { kind: 'grass' };
}

/** runway whose protected strip (inside the holding positions) contains the point */
export function runwayStripAt(p: PilotState, x: number, y: number): string | undefined {
  const pa = p.airports[nearestAirport(p, x, y)];
  return runwayZoneAt(pa.ap, x - pa.ox, y - pa.oy)?.id;
}

/** ILS deviations for the tuned frequency (only the planned departure/arrival runways radiate) */
export function ilsFor(p: PilotState): IlsState {
  const none: IlsState = { valid: false, loc: 0, gs: 0, gsValid: false, dme: 0, crs: p.radios.nav.crs };
  if (!p.sys.avionics) return none;
  const r = [p.arrRwy, p.depRwy].find((q) => Math.abs(q.ilsFreq - p.radios.nav.act) < 0.011);
  if (!r) return none;
  const [along, cross] = alongCross(p.ac.x, p.ac.y, r.thrX, r.thrY, r.hdg);
  const back = -along; // distance before the threshold
  if (back > 25 * NM || back < -r.length) return none;
  // localiser: full scale (2 dots) = 2.5° measured from the far end of the runway
  const locAng = Math.atan2(-cross, back + r.length) / DEG;
  if (Math.abs(locAng) > 35) return none;
  const loc = clamp((locAng / 2.5) * 2, -2.5, 2.5);
  const h = p.ac.z - r.elev;
  const gsAng = Math.atan2(h, back + r.aim) / DEG;
  const gsValid = back > -r.aim && back < 15 * NM && Math.abs(locAng) < 8;
  const gs = clamp(((3 - gsAng) / 0.7) * 2, -2.5, 2.5);
  return { valid: true, loc, gs, gsValid, dme: Math.max(0, back) / NM, crs: r.hdg };
}

/** height of the 3° glidepath (m MSL) at the aircraft's position for the landing runway */
export function glidepathAlt(p: PilotState): number {
  const r = p.arrRwy;
  const [along] = alongCross(p.ac.x, p.ac.y, r.thrX, r.thrY, r.hdg);
  return r.elev + Math.max(0, -along + r.aim) * Math.tan(3 * DEG);
}

/** track miles to the landing threshold along the remaining route, NM */
export function distToGo(p: PilotState): number {
  const r = p.arrRwy;
  if (p.leg >= p.route.length || onFinal(p)) return dist(p.ac.x, p.ac.y, r.thrX, r.thrY) / NM;
  let d = dist(p.ac.x, p.ac.y, p.route[p.leg].x, p.route[p.leg].y);
  for (let i = p.leg; i + 1 < p.route.length; i++) d += dist(p.route[i].x, p.route[i].y, p.route[i + 1].x, p.route[i + 1].y);
  const lastW = p.route[p.route.length - 1];
  if (lastW.kind !== 'rwy') d += dist(lastW.x, lastW.y, r.thrX, r.thrY);
  return d / NM;
}

/** true when the aircraft is inside the final-approach corridor and pointing at the runway */
export function onFinal(p: PilotState): boolean {
  const r = p.arrRwy;
  if (p.ac.onGround) return false;
  const [along, cross] = alongCross(p.ac.x, p.ac.y, r.thrX, r.thrY, r.hdg);
  return along < r.length * 0.6 && along > -22 * NM && Math.abs(cross) < Math.max(400, -along * 0.12) && Math.abs(angDiff(p.ac.gtrk, r.hdg)) < 50;
}
