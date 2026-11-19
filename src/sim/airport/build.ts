/**
 * Airport builder: turns a declarative layout (runway thresholds, named taxiway centrelines,
 * gate positions) into a routable surface graph.
 *
 *  1. every taxiway polyline and runway centreline is split at all mutual intersections
 *     (planarisation) so that crossings become shared graph nodes;
 *  2. hold-short nodes are inserted on every taxiway edge where it crosses the runway
 *     holding-position distance;
 *  3. gates are attached to the nearest taxilane with a lead-in edge.
 *
 * Simulation logic never references specific runway/taxiway identifiers – it only uses the
 * resulting graph – so new airports only need a new definition object.
 */
import type { Airport, Fix, GEdge, GNode, Gate, Runway, RunwayConfig, SizeClass, TrafficMixEntry, EdgeKind } from '../types';
import { NM, dist, hdgOf, projSeg, segIntersect, vecOf, norm360 } from '../util';

export interface TaxiwayDef {
  name: string;
  pts: [number, number][];
  kind?: 'taxiway' | 'apron';
}
export interface GateDef {
  name: string;
  terminal: string;
  x: number;
  y: number;
  size: SizeClass;
  airlines?: string[];
  cargo?: boolean;
  ga?: boolean;
}
export interface RunwayDef {
  a: { name: string; x: number; y: number };
  b: { name: string; x: number; y: number };
  width?: number;
  /** ILS availability for end a / end b (default both true) */
  ils?: [boolean, boolean];
}
export interface AirportDef {
  id: string;
  icao: string;
  iata: string;
  name: string;
  city: string;
  facility: string;
  elevation: number;
  fictional: boolean;
  dataNote: string;
  runways: RunwayDef[];
  taxiways: TaxiwayDef[];
  terminals: { name: string; poly: [number, number][] }[];
  aprons?: [number, number][][];
  gates: GateDef[];
  fixes?: Fix[];
  /** names for auto-generated arrival (NE,SE,SW,NW) and departure (N,E,S,W) fixes */
  fixNames?: { arr: string[]; dep: string[] };
  configs: RunwayConfig[];
  mix: TrafficMixEntry[];
  baseRate: number;
  towerPos: [number, number];
  airspaceRadiusNm?: number;
  ceiling?: number;
  holdDist?: number;
}

/** project lat/lon to local metres around a reference point (equirectangular) */
export function projector(lat0: number, lon0: number) {
  const mLat = 111195;
  const mLon = 111195 * Math.cos((lat0 * Math.PI) / 180);
  return (lat: number, lon: number): [number, number] => [
    Math.round((lon - lon0) * mLon),
    Math.round((lat - lat0) * mLat),
  ];
}

interface Seg {
  ax: number; ay: number; bx: number; by: number;
  name: string; kind: EdgeKind; rwy?: string;
  cuts: number[];
}

const SNAP = 3; // m

export function buildAirport(def: AirportDef): Airport {
  const holdDist = def.holdDist ?? 90;
  const segs: Seg[] = [];
  const runways: Runway[] = [];

  for (const r of def.runways) {
    const id = `${r.a.name}/${r.b.name}`;
    const h = hdgOf(r.b.x - r.a.x, r.b.y - r.a.y);
    const ils = r.ils ?? [true, true];
    runways.push({
      id,
      ends: [
        { name: r.a.name, x: r.a.x, y: r.a.y, hdg: h, ils: ils[0] },
        { name: r.b.name, x: r.b.x, y: r.b.y, hdg: norm360(h + 180), ils: ils[1] },
      ],
      length: dist(r.a.x, r.a.y, r.b.x, r.b.y),
      width: r.width ?? 45,
      nodes: [],
    });
    segs.push({ ax: r.a.x, ay: r.a.y, bx: r.b.x, by: r.b.y, name: id, kind: 'runway', rwy: id, cuts: [0, 1] });
  }
  for (const t of def.taxiways) {
    for (let i = 0; i + 1 < t.pts.length; i++) {
      const [ax, ay] = t.pts[i];
      const [bx, by] = t.pts[i + 1];
      if (dist(ax, ay, bx, by) < 1) continue;
      segs.push({ ax, ay, bx, by, name: t.name, kind: t.kind ?? 'taxiway', cuts: [0, 1] });
    }
  }

  // 1. planarise
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const o = segs[j];
      // quick bbox reject
      if (Math.max(s.ax, s.bx) + SNAP < Math.min(o.ax, o.bx) || Math.min(s.ax, s.bx) - SNAP > Math.max(o.ax, o.bx)) continue;
      if (Math.max(s.ay, s.by) + SNAP < Math.min(o.ay, o.by) || Math.min(s.ay, s.by) - SNAP > Math.max(o.ay, o.by)) continue;
      const hit = segIntersect(s.ax, s.ay, s.bx, s.by, o.ax, o.ay, o.bx, o.by);
      if (hit) {
        s.cuts.push(hit[0]);
        o.cuts.push(hit[1]);
      }
      // near-touching endpoints (T junctions that are not numerically exact)
      for (const [px, py] of [[o.ax, o.ay], [o.bx, o.by]] as const) {
        const [t, d] = projSeg(px, py, s.ax, s.ay, s.bx, s.by);
        if (d < SNAP) s.cuts.push(t);
      }
      for (const [px, py] of [[s.ax, s.ay], [s.bx, s.by]] as const) {
        const [t, d] = projSeg(px, py, o.ax, o.ay, o.bx, o.by);
        if (d < SNAP) o.cuts.push(t);
      }
    }
  }

  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const grid = new Map<string, number[]>();
  const cell = (v: number) => Math.floor(v / 8);
  const nodeAt = (x: number, y: number): number => {
    const cx = cell(x), cy = cell(y);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const list = grid.get(`${cx + i},${cy + j}`);
        if (list) for (const id of list) if (dist(nodes[id].x, nodes[id].y, x, y) <= SNAP) return id;
      }
    const id = nodes.length;
    nodes.push({ id, x, y, kind: 'twy' });
    const k = `${cx},${cy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(id);
    return id;
  };
  const edgeKey = new Set<string>();
  const addEdge = (a: number, b: number, name: string, kind: EdgeKind) => {
    if (a === b) return;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeKey.has(k)) return;
    edgeKey.add(k);
    edges.push({ id: edges.length, a, b, name, kind, len: dist(nodes[a].x, nodes[a].y, nodes[b].x, nodes[b].y) });
  };

  for (const s of segs) {
    const cuts = [...new Set(s.cuts.map((c) => Math.round(c * 1e6) / 1e6))].sort((p, q) => p - q);
    let prev = -1;
    for (const c of cuts) {
      const id = nodeAt(s.ax + (s.bx - s.ax) * c, s.ay + (s.by - s.ay) * c);
      if (s.rwy) {
        nodes[id].kind = 'rwy';
        nodes[id].rwy = s.rwy;
      }
      if (prev >= 0 && prev !== id) addEdge(prev, id, s.name, s.kind);
      prev = id;
    }
  }

  // 2. hold-short nodes
  const removed = new Set<number>();
  const adjOf = () => {
    const adj: number[][] = nodes.map(() => []);
    for (const e of edges) {
      if (removed.has(e.id)) continue;
      adj[e.a].push(e.id);
      adj[e.b].push(e.id);
    }
    return adj;
  };
  for (const r of runways) {
    const [e0, e1] = r.ends;
    const lat = (n: GNode) => projSeg(n.x, n.y, e0.x, e0.y, e1.x, e1.y)[1];
    let adj = adjOf();
    const queue = nodes.filter((n) => n.kind === 'rwy' && lat(n) < SNAP + 1).map((n) => n.id);
    const seen = new Set(queue);
    while (queue.length) {
      const u = queue.pop()!;
      for (const eid of [...adj[u]]) {
        const e = edges[eid];
        if (removed.has(eid) || e.kind === 'runway') continue;
        const v = e.a === u ? e.b : e.a;
        if (seen.has(v)) continue;
        const lu = lat(nodes[u]);
        const lv = lat(nodes[v]);
        if (lv < holdDist) {
          seen.add(v);
          if (nodes[v].kind !== 'rwy') queue.push(v);
          continue;
        }
        // split edge at the hold line
        const f = (holdDist - lu) / (lv - lu);
        const hx = nodes[u].x + (nodes[v].x - nodes[u].x) * f;
        const hy = nodes[u].y + (nodes[v].y - nodes[u].y) * f;
        let h: number;
        if (dist(hx, hy, nodes[v].x, nodes[v].y) < 6 && nodes[v].kind === 'twy' ) {
          // junction sits right at the hold line: use it as the holding position
          h = v;
        } else {
          h = nodes.length;
          nodes.push({ id: h, x: hx, y: hy, kind: 'hold', rwy: r.id });
          removed.add(eid);
          const k = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`;
          edgeKey.delete(k);
          addEdge(u, h, e.name, e.kind);
          addEdge(h, v, e.name, e.kind);
          adj = adjOf();
        }
        nodes[h].kind = 'hold';
        nodes[h].rwy = r.id;
        seen.add(h);
      }
    }
  }
  // compact edges
  let live = edges.filter((e) => !removed.has(e.id));
  live.forEach((e, i) => (e.id = i));

  // 3. gates
  const gates: Gate[] = [];
  for (const g of def.gates) {
    let best = -1, bestD = 1e9, bestT = 0;
    for (const e of live) {
      if (e.kind === 'runway' || e.kind === 'gate') continue;
      const A = nodes[e.a], B = nodes[e.b];
      const [t, d] = projSeg(g.x, g.y, A.x, A.y, B.x, B.y);
      const dd = d + (e.kind === 'apron' ? 0 : 60); // prefer taxilanes
      if (dd < bestD) { bestD = dd; best = e.id; bestT = t; }
    }
    if (best < 0) continue;
    const e = live[best];
    const A = nodes[e.a], B = nodes[e.b];
    let lane: number;
    if (bestT * e.len < 5 && A.kind === 'twy') lane = A.id;
    else if ((1 - bestT) * e.len < 5 && B.kind === 'twy') lane = B.id;
    else {
      lane = nodes.length;
      nodes.push({ id: lane, x: A.x + (B.x - A.x) * bestT, y: A.y + (B.y - A.y) * bestT, kind: 'twy' });
      const oldB = e.b;
      e.b = lane;
      e.len = dist(A.x, A.y, nodes[lane].x, nodes[lane].y);
      live.push({ id: live.length, a: lane, b: oldB, name: e.name, kind: e.kind, len: dist(nodes[lane].x, nodes[lane].y, B.x, B.y) });
    }
    const gn = nodes.length;
    nodes.push({ id: gn, x: g.x, y: g.y, kind: 'gate', gate: g.name });
    live.push({ id: live.length, a: lane, b: gn, name: '', kind: 'gate', len: dist(nodes[lane].x, nodes[lane].y, g.x, g.y) });
    gates.push({
      name: g.name, terminal: g.terminal, node: gn, lane,
      hdg: hdgOf(g.x - nodes[lane].x, g.y - nodes[lane].y),
      size: g.size, airlines: g.airlines, cargo: g.cargo, ga: g.ga,
    });
  }

  const adj: number[][] = nodes.map(() => []);
  for (const e of live) {
    adj[e.a].push(e.id);
    adj[e.b].push(e.id);
  }
  for (const r of runways) {
    const [e0] = r.ends;
    r.nodes = nodes
      .filter((n) => n.kind === 'rwy' && projSeg(n.x, n.y, r.ends[0].x, r.ends[0].y, r.ends[1].x, r.ends[1].y)[1] < SNAP + 1)
      .sort((p, q) => dist(p.x, p.y, e0.x, e0.y) - dist(q.x, q.y, e0.x, e0.y))
      .map((n) => n.id);
  }

  const radius = (def.airspaceRadiusNm ?? 30) * NM;
  const fixes: Fix[] = def.fixes ? [...def.fixes] : [];
  if (!def.fixes) {
    const an = def.fixNames?.arr ?? ['NORTE', 'SOUTE', 'SOUWE', 'NORWE'];
    const dn = def.fixNames?.dep ?? ['NORDE', 'EASDE', 'SOUDE', 'WESDE'];
    [45, 135, 225, 315].forEach((b, i) => {
      const [ux, uy] = vecOf(b);
      fixes.push({ name: an[i], x: ux * radius * 0.7, y: uy * radius * 0.7, kind: 'arrival' });
    });
    [0, 90, 180, 270].forEach((b, i) => {
      const [ux, uy] = vecOf(b);
      fixes.push({ name: dn[i], x: ux * radius * 0.97, y: uy * radius * 0.97, kind: 'departure' });
    });
  }
  // final-approach fixes 12 NM out on each extended centreline
  for (const r of runways)
    for (const e of r.ends) {
      const [ux, uy] = vecOf(e.hdg);
      fixes.push({ name: `F${e.name}`, x: e.x - ux * 12 * NM, y: e.y - uy * 12 * NM, kind: 'final', rwy: e.name });
      // base-leg fixes either side of the final (16 NM out, 5.5 NM abeam: a 40° intercept joins the final ~10 NM out)
      for (const sgn of [1, -1]) {
        const px = -uy * sgn, py = ux * sgn;
        const side = Math.abs(px) > Math.abs(py) ? (px > 0 ? 'E' : 'W') : py > 0 ? 'N' : 'S';
        fixes.push({ name: `B${e.name}${side}`, x: e.x - ux * 16 * NM + px * 5.5 * NM, y: e.y - uy * 16 * NM + py * 5.5 * NM, kind: 'nav', rwy: e.name });
      }
    }

  return {
    id: def.id, icao: def.icao, iata: def.iata, name: def.name, city: def.city, facility: def.facility,
    elevation: def.elevation, fictional: def.fictional, dataNote: def.dataNote,
    runways, nodes, edges: live, adj, gates,
    terminals: def.terminals.map((t) => ({
      ...t,
      label: [t.poly.reduce((s, p) => s + p[0], 0) / t.poly.length, t.poly.reduce((s, p) => s + p[1], 0) / t.poly.length] as [number, number],
    })),
    aprons: def.aprons ?? [],
    fixes, configs: def.configs, mix: def.mix,
    airspaceRadius: radius, ceiling: def.ceiling ?? 14000, holdDist,
    towerPos: def.towerPos, baseRate: def.baseRate,
  };
}

/** Structural validation used by tests and the custom-airport builder. */
export function validateAirport(ap: Airport): string[] {
  const problems: string[] = [];
  if (!ap.gates.length) problems.push('no gates');
  // reachability from first gate ignoring direction constraints
  const seen = new Set<number>();
  const start = ap.gates[0]?.node ?? 0;
  const stack = [start];
  seen.add(start);
  while (stack.length) {
    const u = stack.pop()!;
    for (const eid of ap.adj[u]) {
      const e = ap.edges[eid];
      const v = e.a === u ? e.b : e.a;
      if (!seen.has(v)) { seen.add(v); stack.push(v); }
    }
  }
  for (const g of ap.gates) if (!seen.has(g.node)) problems.push(`gate ${g.name} is not connected`);
  for (const r of ap.runways) {
    if (r.nodes.length < 2) problems.push(`runway ${r.id} has no taxiway connections`);
    else if (!r.nodes.some((n) => seen.has(n))) problems.push(`runway ${r.id} is not connected to the gates`);
    const holds = ap.nodes.filter((n) => n.kind === 'hold' && n.rwy === r.id);
    if (!holds.length) problems.push(`runway ${r.id} has no holding positions`);
  }
  return problems;
}
