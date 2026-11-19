/** Read-only geometric queries on a built Airport. */
import type { Airport, GEdge, GNode, Gate, Runway, RunwayEnd } from '../types';
import { alongCross, angDiff, dist, hdgOf, projSeg } from '../util';

export interface EndRef {
  rwy: Runway;
  end: RunwayEnd;
  opp: RunwayEnd;
  idx: 0 | 1;
}

const endCache = new WeakMap<Airport, Map<string, EndRef>>();
/** normalise "8L" -> "08L" style names so typed commands are forgiving */
export function normRwyName(ap: Airport, name: string): string | undefined {
  const n = name.toUpperCase().replace(/^RWY/, '');
  const m = endMap(ap);
  if (m.has(n)) return n;
  if (m.has('0' + n)) return '0' + n;
  if (n.startsWith('0') && m.has(n.slice(1))) return n.slice(1);
  return undefined;
}
function endMap(ap: Airport) {
  let m = endCache.get(ap);
  if (!m) {
    m = new Map();
    for (const r of ap.runways) {
      m.set(r.ends[0].name, { rwy: r, end: r.ends[0], opp: r.ends[1], idx: 0 });
      m.set(r.ends[1].name, { rwy: r, end: r.ends[1], opp: r.ends[0], idx: 1 });
    }
    endCache.set(ap, m);
  }
  return m;
}
export const endRef = (ap: Airport, name: string | undefined): EndRef | undefined => (name ? endMap(ap).get(name) : undefined);
export const allEnds = (ap: Airport): EndRef[] => [...endMap(ap).values()];
export const runwayById = (ap: Airport, id: string) => ap.runways.find((r) => r.id === id);

const gateCache = new WeakMap<Airport, Map<string, Gate>>();
export function gateByName(ap: Airport, name: string | undefined): Gate | undefined {
  if (!name) return undefined;
  let m = gateCache.get(ap);
  if (!m) {
    m = new Map(ap.gates.map((g) => [g.name, g]));
    gateCache.set(ap, m);
  }
  return m.get(name.toUpperCase());
}

export const otherEnd = (e: GEdge, n: number) => (e.a === n ? e.b : e.a);
export function edgeBetween(ap: Airport, a: number, b: number): GEdge | undefined {
  for (const eid of ap.adj[a]) {
    const e = ap.edges[eid];
    if (e.a === b || e.b === b) return e;
  }
  return undefined;
}

/** lateral distance from a point to a runway strip (capsule distance to centreline segment) */
export function rwyLateral(r: Runway, x: number, y: number): number {
  return projSeg(x, y, r.ends[0].x, r.ends[0].y, r.ends[1].x, r.ends[1].y)[1];
}

/** id of the runway whose protected area contains the point, if any */
export function runwayZoneAt(ap: Airport, x: number, y: number): Runway | undefined {
  for (const r of ap.runways) {
    const [al, cr] = alongCross(x, y, r.ends[0].x, r.ends[0].y, r.ends[0].hdg);
    if (Math.abs(cr) < ap.holdDist - 12 && al > -60 && al < r.length + 60) return r;
  }
  return undefined;
}

export interface HoldInfo {
  hold: number;
  rwy: Runway;
  /** runway centreline node this holding position leads onto */
  entry: number;
  /** path of node ids from hold to entry (inclusive) */
  path: number[];
  /** distance of entry node from ends[0] threshold */
  along: number;
}
const holdCache = new WeakMap<Airport, Map<number, HoldInfo>>();
export function holdInfo(ap: Airport, hold: number): HoldInfo | undefined {
  let m = holdCache.get(ap);
  if (!m) {
    m = new Map();
    for (const n of ap.nodes) {
      if (n.kind !== 'hold' || !n.rwy) continue;
      const r = runwayById(ap, n.rwy)!;
      // walk inward: always step to the neighbour with the smallest lateral distance
      const path = [n.id];
      let cur = n.id;
      let guard = 0;
      const onRwy = (id: number) => ap.nodes[id].kind === 'rwy' && rwyLateral(r, ap.nodes[id].x, ap.nodes[id].y) < 4;
      while (!onRwy(cur)) {
        let best = -1, bestL = rwyLateral(r, ap.nodes[cur].x, ap.nodes[cur].y);
        for (const eid of ap.adj[cur]) {
          const e = ap.edges[eid];
          if (e.kind === 'gate') continue;
          const v = otherEnd(e, cur);
          const l = rwyLateral(r, ap.nodes[v].x, ap.nodes[v].y);
          if (l < bestL - 0.5) { bestL = l; best = v; }
        }
        if (best < 0 || guard++ > 20) break;
        cur = best;
        path.push(cur);
      }
      const en = ap.nodes[cur];
      if (onRwy(cur)) {
        m.set(n.id, { hold: n.id, rwy: r, entry: cur, path, along: dist(en.x, en.y, r.ends[0].x, r.ends[0].y) });
      }
    }
    holdCache.set(ap, m);
  }
  return m.get(hold);
}
export function holdsOf(ap: Airport, rwyId: string): HoldInfo[] {
  const out: HoldInfo[] = [];
  for (const n of ap.nodes) if (n.kind === 'hold' && n.rwy === rwyId) { const h = holdInfo(ap, n.id); if (h) out.push(h); }
  return out;
}

/** takeoff run available from a holding position's entry point for a given runway end */
export function toraFrom(h: HoldInfo, endIdx: 0 | 1): number {
  return endIdx === 0 ? h.rwy.length - h.along : h.along;
}

export function nearestNode(ap: Airport, x: number, y: number, pred?: (n: GNode) => boolean): GNode | undefined {
  let best: GNode | undefined, bd = 1e12;
  for (const n of ap.nodes) {
    if (pred && !pred(n)) continue;
    const d = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

/** crosswind / headwind components (kt) for a runway end; headwind negative = tailwind */
export function windComponents(endHdg: number, windDir: number, windKt: number): { head: number; cross: number } {
  const a = (angDiff(endHdg, windDir) * Math.PI) / 180;
  return { head: Math.cos(a) * windKt, cross: Math.abs(Math.sin(a) * windKt) };
}

export const segHdg = (ap: Airport, a: number, b: number) => hdgOf(ap.nodes[b].x - ap.nodes[a].x, ap.nodes[b].y - ap.nodes[a].y);
