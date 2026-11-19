/**
 * Surface routing: Dijkstra over directed edges so that turn-angle limits (aircraft cannot
 * make hairpin turns) and "via taxiway" constraints can be honoured.
 */
import type { Airport } from './types';
import { angDiff } from './util';
import { otherEnd, segHdg } from './airport/query';

export interface RouteOpts {
  /** ordered taxiway designators the route must use */
  via?: string[];
  closed?: Set<number> | number[];
  /** node the aircraft is coming from (forbids an immediate U-turn) */
  prev?: number;
  /** extra terminal cost per goal node */
  goalCost?: (node: number) => number;
  maxTurn?: number;
  /** extra acceptance test for a goal node given the node it is reached from */
  goalOk?: (node: number, prev: number) => boolean;
}
export interface Route {
  nodes: number[];
  len: number;
  names: string[];
}

class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(k: number, v: number) {
    const a = this.a;
    a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function findRoute(ap: Airport, start: number, goals: number[] | number, opts: RouteOpts = {}): Route | null {
  const goalSet = new Set(typeof goals === 'number' ? [goals] : goals);
  if (!goalSet.size) return null;
  const via = (opts.via ?? []).map((v) => v.toUpperCase());
  const K = via.length + 1;
  const closed = opts.closed instanceof Set ? opts.closed : new Set(opts.closed ?? []);
  const maxTurn = opts.maxTurn ?? 125;
  const nE = ap.edges.length;
  // state = (directed edge index, via progress). directed edge d = eid*2 + (0: a->b, 1: b->a)
  const nStates = nE * 2 * K;
  const cost = new Float64Array(nStates).fill(Infinity);
  const from = new Int32Array(nStates).fill(-1);
  const heap = new Heap();

  const expand = (node: number, prevNode: number | undefined, k: number, base: number, fromState: number) => {
    const inHdg = prevNode !== undefined && prevNode >= 0 ? segHdg(ap, prevNode, node) : undefined;
    for (const eid of ap.adj[node]) {
      if (closed.has(eid)) continue;
      const e = ap.edges[eid];
      const v = otherEnd(e, node);
      if (v === prevNode) continue;
      if (e.kind === 'gate' && !goalSet.has(v) && node !== start) continue;
      if (e.kind === 'gate' && node === start && ap.nodes[v].kind === 'gate') continue;
      if (inHdg !== undefined && Math.abs(angDiff(inHdg, segHdg(ap, node, v))) > maxTurn) continue;
      let nk = k;
      let mult = e.kind === 'runway' ? 8 : e.kind === 'apron' ? 1.25 : 1;
      if (via.length) {
        const nm = e.name.toUpperCase();
        if (k > 0 && nm === via[k - 1]) nk = k;
        else if (k < via.length && nm === via[k]) nk = k + 1;
        else mult *= k === 0 || k === via.length || e.kind === 'gate' ? 4 : 7; // connectors not named in the clearance are allowed but penalised
      }
      let c = base + e.len * mult;
      if (ap.nodes[v].kind === 'rwy' && e.kind !== 'runway') c += 500; // discourage runway crossings
      const st = (eid * 2 + (e.a === node ? 0 : 1)) * K + nk;
      if (c < cost[st]) {
        cost[st] = c;
        from[st] = fromState;
        heap.push(c, st);
      }
    }
  };

  expand(start, opts.prev, 0, 0, -1);
  let best = -1, bestC = Infinity;
  while (heap.size) {
    const [c, st] = heap.pop();
    if (c > cost[st]) continue;
    if (c >= bestC) break;
    const k = st % K;
    const d = (st - k) / K;
    const e = ap.edges[d >> 1];
    const node = d & 1 ? e.a : e.b;
    const prevNode = d & 1 ? e.b : e.a;
    if (goalSet.has(node) && k === via.length && (!opts.goalOk || opts.goalOk(node, prevNode))) {
      const tc = c + (opts.goalCost ? opts.goalCost(node) : 0);
      if (tc < bestC) { bestC = tc; best = st; }
      if (!opts.goalCost) break;
      continue;
    }
    expand(node, prevNode, k, c, st);
  }
  if (best < 0) return null;
  const nodes: number[] = [];
  const names: string[] = [];
  let len = 0;
  for (let st = best; st >= 0; st = from[st]) {
    const d = Math.floor(st / K);
    const e = ap.edges[d >> 1];
    nodes.push(d & 1 ? e.a : e.b);
    len += e.len;
    if (e.name && e.kind !== 'runway' && names[names.length - 1] !== e.name) names.push(e.name);
    if (from[st] < 0) nodes.push(d & 1 ? e.b : e.a);
  }
  nodes.reverse();
  names.reverse();
  return { nodes, len, names };
}

/** cumulative distances along a node route */
export function routeCum(ap: Airport, route: number[]): number[] {
  const cum = [0];
  for (let i = 1; i < route.length; i++) {
    const a = ap.nodes[route[i - 1]], b = ap.nodes[route[i]];
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return cum;
}
