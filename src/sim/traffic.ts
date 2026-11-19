/**
 * Traffic generation: flight identities (airline, type, callsign, registration, route),
 * arrival spawning at the airspace boundary, initial gate population and schedule bookkeeping.
 * All flights are fictional-but-plausible ("simulated") unless another source is attached.
 */
import type { Aircraft, Gate, TrafficMixEntry } from './types';
import { NM, dist, hdgOf, norm360, pick, pickWeighted, rand, randInt, randRange, vecOf } from './util';
import { typeOf, sizeFits, AIRCRAFT_TYPES } from './data/aircraft';
import { airlineOf } from './data/airlines';
import { gateByName } from './airport/query';
import { World, csay, isActive, isAirborne, logEvent, radioPilot, setRequest } from './world';
import { beginTurnaround, turnaroundDuration } from './ground';
import { sayAlt } from './phraseology';

export function blankAircraft(w: World, init: Partial<Aircraft> & Pick<Aircraft, 'callsign' | 'airline' | 'type'>): Aircraft {
  const s = w.s;
  const t = typeOf(init.type);
  const ac: Aircraft = {
    id: s.nextId++,
    reg: genReg(w, init.airline),
    source: 'simulated',
    kind: 'arrival',
    origin: '', dest: '',
    sched: s.t, est: s.t, delay: 0,
    phase: 'inbound',
    x: 0, y: 0, alt: 0, hdg: 0, ias: 0, gs: 0, vs: 0, track: 0,
    latMode: 'hdg', tgtHdg: 0, turnDir: 0, tgtAlt: 0, tgtSpd: 0,
    apprCleared: false, landCleared: false, established: false, goArounds: 0,
    depCleared: false, pushApproved: false, lineUpCleared: false, takeoffCleared: false,
    crossCleared: [], handedOff: false,
    route: [], routeS: 0, routeStop: 0, reverse: false, holdPos: false, taxiNames: [],
    fuel: t.fuelBurnKgMin * 120, fuelMin: 120,
    lastContact: s.t, checkedIn: false, spawnT: s.t, trail: [], flags: {},
    ...init,
  };
  s.aircraft.push(ac);
  return ac;
}

const REG_PREFIX: Record<string, [string, string]> = {
  BAW: ['G-', 'LLLL'], VIR: ['G-', 'LLLL'], DLH: ['D-A', 'LLL'], AFR: ['F-G', 'LLL'], KLM: ['PH-', 'LLL'],
  UAE: ['A6-', 'LLL'], QTR: ['A7-', 'LLL'], THY: ['TC-', 'LLL'], SIA: ['9V-', 'LLL'], ACA: ['C-F', 'LLL'],
  KAL: ['HL', 'DDDD'], JAL: ['JA', 'DDDL'], QFA: ['VH-', 'LLL'], EIN: ['EI-', 'LLL'], IBE: ['EC-', 'LLL'],
};
const US_SUFFIX: Record<string, string> = { DAL: 'DL', AAL: 'AA', UAL: 'UA', SWA: 'WN', JBU: 'JB', ASA: 'AS', NKS: 'NK', FFT: 'FR', UPS: 'UP', FDX: 'FE', EDV: 'PQ', RPA: 'YX', SKW: 'SY' };
function genReg(w: World, airline: string): string {
  const L = () => String.fromCharCode(65 + randInt(w.s, 0, 25));
  const D = () => String(randInt(w.s, 0, 9));
  const p = REG_PREFIX[airline];
  if (p) return p[0] + p[1].split('').map((c) => (c === 'L' ? L() : D())).join('');
  return `N${randInt(w.s, 100, 999)}${US_SUFFIX[airline] ?? L() + L()}`;
}

export function genCallsign(w: World, airline: string): string {
  const s = w.s;
  for (let i = 0; i < 50; i++) {
    let cs: string;
    if (airline === 'GA') cs = `N${randInt(s, 100, 999)}${String.fromCharCode(65 + randInt(s, 0, 25))}${String.fromCharCode(65 + randInt(s, 0, 25))}`;
    else {
      const intl = !!REG_PREFIX[airline];
      const n = intl ? randInt(s, 1, 399) : airline === 'UPS' || airline === 'FDX' ? randInt(s, 100, 2999) : randInt(s, 100, 2899);
      cs = `${airline}${n}`;
    }
    if (!s.usedCallsigns.includes(cs)) {
      s.usedCallsigns.push(cs);
      if (s.usedCallsigns.length > 500) s.usedCallsigns.shift();
      return cs;
    }
  }
  return `${airline}${randInt(s, 3000, 9999)}`;
}

/** gates occupied (aircraft physically on stand) or reserved by an inbound aircraft */
export function gateUser(w: World, gateName: string, except?: Aircraft): Aircraft | undefined {
  return w.s.aircraft.find((a) => a !== except && a.gate === gateName && isActive(a) && !(a.phase === 'pushback' && a.flags.offGate));
}
export const gateOccupied = (w: World, gateName: string) => {
  const u = gateUser(w, gateName);
  return !!u && (u.phase === 'parked' || u.phase === 'pushback');
};

/** gates usable by an aircraft, best first */
export function gateOptions(w: World, ac: Pick<Aircraft, 'type' | 'airline' | 'x' | 'y'> & { id?: number }): Gate[] {
  const t = typeOf(ac.type);
  const al = airlineOf(ac.airline);
  const self = w.s.aircraft.find((a) => a.id === ac.id);
  const rank = { S: 0, M: 1, L: 2, XL: 3 };
  return w.ap.gates
    .filter((g) => sizeFits(t.size, g.size) && !gateUser(w, g.name, self) && !!g.cargo === !!al.cargo && (!!g.ga === (ac.airline === 'GA') || !w.ap.gates.some((x) => x.ga)))
    .map((g) => {
      const n = w.ap.nodes[g.node];
      const pref = g.airlines?.includes(ac.airline) ? 0 : 1500;
      return { g, score: pref + (rank[g.size] - rank[t.size]) * 400 + dist(ac.x, ac.y, n.x, n.y) * 0.25 };
    })
    .sort((a, b) => a.score - b.score)
    .map((o) => o.g);
}

function usableMix(w: World): TrafficMixEntry[] {
  const { ap } = w;
  const maxPax = ap.gates.filter((g) => !g.cargo).reduce((m, g) => Math.max(m, { S: 0, M: 1, L: 2, XL: 3 }[g.size]), 0);
  const hasCargo = ap.gates.some((g) => g.cargo);
  const longest = Math.max(...ap.runways.map((r) => r.length));
  return ap.mix
    .filter((m) => (airlineOf(m.airline).cargo ? hasCargo : true))
    .map((m) => ({ ...m, types: m.types.filter((id) => AIRCRAFT_TYPES[id] && (airlineOf(m.airline).cargo || { S: 0, M: 1, L: 2, XL: 3 }[typeOf(id).size] <= maxPax) && typeOf(id).takeoffDist < longest + 100) }))
    .filter((m) => m.types.length);
}

export function pickFlight(w: World): { airline: string; type: string; route: string } {
  const mix = usableMix(w);
  const m = pickWeighted(w.s, mix, (e) => e.weight);
  return { airline: m.airline, type: pick(w.s, m.types), route: pick(w.s, m.routes) };
}
function routeFor(w: World, airline: string, type: string): string {
  const cands = w.ap.mix.filter((m) => m.airline === airline && m.types.includes(type));
  const m = cands.length ? pick(w.s, cands) : pick(w.s, w.ap.mix);
  return pick(w.s, m.routes);
}

export interface ArrivalOpts {
  airline?: string; type?: string; callsign?: string; origin?: string;
  fix?: string; distNm?: number; alt?: number; fuelMin?: number;
}
export function spawnArrival(w: World, o: ArrivalOpts = {}): Aircraft | undefined {
  const { s, ap } = w;
  const fl = pickFlight(w);
  const airline = o.airline ?? fl.airline;
  const type = o.type ?? fl.type;
  const t = typeOf(type);
  const posts = ap.fixes.filter((f) => f.kind === 'arrival');
  let fix = o.fix ? posts.find((f) => f.name === o.fix) : undefined;
  let px = 0, py = 0, alt = o.alt ?? 0;
  const tryFix = (f: typeof posts[number]): boolean => {
    const brg = hdgOf(f.x, f.y) + (o.distNm ? 0 : randRange(s, -6, 6));
    const [ux, uy] = vecOf(brg);
    const r = o.distNm ? o.distNm * NM : ap.airspaceRadius - 400;
    px = ux * r; py = uy * r;
    for (const a of o.alt ? [o.alt] : [10000, 11000, 9000, 12000]) {
      const clash = s.aircraft.some((b) => isAirborne(b) && dist(b.x, b.y, px, py) < 6 * NM && Math.abs(b.alt - a) < 1500);
      if (!clash) { alt = a; return true; }
    }
    return false;
  };
  if (fix) { if (!tryFix(fix)) return undefined; }
  else {
    const order = [...posts].sort(() => rand(s) - 0.5);
    for (const f of order) if (tryFix(f)) { fix = f; break; }
    if (!fix) return undefined;
  }
  const hdg = hdgOf(fix.x - px, fix.y - py);
  const fuelMin = o.fuelMin ?? (s.cfg.difficulty.fuelRealism ? randRange(s, 42, 80) : 240);
  const nominal = (dist(px, py, 0, 0) / NM / 215) * 3600 + 330;
  const ac = blankAircraft(w, {
    airline, type, callsign: o.callsign ?? genCallsign(w, airline),
    kind: 'arrival', origin: o.origin ?? fl.route, dest: ap.iata,
    phase: 'inbound', x: px, y: py, alt, hdg, track: hdg,
    ias: Math.min(250, t.cruiseKt), gs: 280, latMode: 'fix', fix: fix.name, tgtHdg: hdg, tgtAlt: alt,
    fuel: t.fuelBurnKgMin * fuelMin, fuelMin,
    sched: s.t + nominal + randRange(s, -120, 200),
  });
  if (o.airline && !o.origin) ac.origin = routeFor(w, airline, type);
  ac.est = ac.sched;
  ac.nextLeg = { callsign: genCallsign(w, airline), dest: routeFor(w, airline, type), sched: 0 };
  s.stats.demand++;
  return ac;
}

export interface ParkedOpts { airline?: string; type?: string; callsign?: string; dest?: string; readyIn?: number }
export function spawnParked(w: World, gateName: string, o: ParkedOpts = {}): Aircraft | undefined {
  const { s, ap } = w;
  const g = gateByName(ap, gateName);
  if (!g || gateUser(w, g.name)) return undefined;
  let airline = o.airline, type = o.type;
  if (!airline || !type) {
    // choose a flight that fits this stand, preferring its usual operators
    for (let i = 0; i < 40; i++) {
      const f = pickFlight(w);
      const al = airlineOf(f.airline);
      if (!sizeFits(typeOf(f.type).size, g.size) || !!al.cargo !== !!g.cargo || (g.ga ? f.airline !== 'GA' : f.airline === 'GA' && ap.gates.some((x) => x.ga))) continue;
      if (i < 25 && g.airlines && !g.airlines.includes(f.airline)) continue;
      if (i < 12 && typeOf(f.type).size !== g.size && g.size !== 'M') continue;
      airline = airline ?? f.airline; type = type ?? f.type;
      break;
    }
    if (!airline || !type) return undefined;
  }
  const n = ap.nodes[g.node];
  const ac = blankAircraft(w, {
    airline, type, callsign: genCallsign(w, airline), kind: 'arrival',
    origin: routeFor(w, airline, type), dest: ap.iata, phase: 'parked', gate: g.name,
    x: n.x, y: n.y, hdg: g.hdg, track: g.hdg, checkedIn: true,
  });
  ac.actual = s.t;
  ac.nextLeg = { callsign: o.callsign ?? genCallsign(w, airline), dest: o.dest ?? routeFor(w, airline, type), sched: 0 };
  const total = turnaroundDuration(w, ac);
  const readyIn = o.readyIn ?? total * 0.5;
  beginTurnaround(w, ac, total, Math.max(0, total - readyIn));
  return ac;
}

export function populate(w: World) {
  const { s, ap } = w;
  const d = s.cfg.difficulty;
  const nParked = Math.min(Math.floor(ap.gates.length * 0.72), Math.round(d.departureRate * 0.35 * (0.6 + d.groundComplexity)) + 2);
  const gates = [...ap.gates].sort(() => rand(s) - 0.5);
  const gap = 3600 / Math.max(4, d.departureRate);
  let placed = 0;
  for (const g of gates) {
    if (placed >= nParked) break;
    const readyIn = placed === 0 ? 12 : 25 + placed * gap * randRange(s, 0.75, 1.15);
    if (spawnParked(w, g.name, { readyIn })) placed++;
  }
  const posts = ap.fixes.filter((f) => f.kind === 'arrival');
  const nArr = Math.max(1, Math.min(8, Math.round(d.arrivalRate / 10), Math.floor(d.maxAircraft / 2)));
  const R = ap.airspaceRadius / NM;
  for (let i = 0; i < nArr; i++) {
    const f = posts[i % posts.length];
    const ring = Math.floor(i / posts.length);
    spawnArrival(w, { fix: f.name, distNm: R * (ring === 0 ? 0.86 : 0.98), alt: ring === 0 ? 9000 + (i % 2) * 1000 : 11000 + (i % 2) * 1000 });
  }
  s.nextArrival = s.t + (3600 / Math.max(1, d.arrivalRate)) * randRange(s, 0.4, 1);
  s.nextOrigin = s.t + 240;
}

export const activeCount = (w: World) => w.s.aircraft.filter((a) => isActive(a) && a.phase !== 'parked').length;

/** called once per simulated second */
export function updateTraffic(w: World) {
  const { s, ap } = w;
  const d = s.cfg.difficulty;
  if (!s.cfg.emptyStart || s.cfg.challenge) {
    if (d.arrivalRate > 0 && s.t >= s.nextArrival) {
      const total = s.aircraft.filter(isActive).length;
      if (activeCount(w) < d.maxAircraft && total < ap.gates.length + d.maxAircraft - 2) {
        const ac = spawnArrival(w);
        s.nextArrival = s.t + (ac ? (3600 / d.arrivalRate) * randRange(s, 0.55, 1.5) : 15);
        if (ac && s.spawnQueue > 0) s.spawnQueue--;
      } else {
        if (s.spawnQueue < 9) s.spawnQueue++;
        s.nextArrival = s.t + 25;
      }
    }
    // originating flights keep the departure rate up when arrivals alone cannot feed it
    if (s.t >= s.nextOrigin) {
      const surplus = d.departureRate - d.arrivalRate * 0.9;
      s.nextOrigin = s.t + (surplus > 1 ? 3600 / surplus : 600);
      const parked = s.aircraft.filter((a) => a.phase === 'parked').length;
      if (surplus > 1 && parked < ap.gates.length * 0.6 && activeCount(w) < d.maxAircraft) {
        const free = ap.gates.filter((g) => !gateUser(w, g.name));
        if (free.length) {
          const g = pick(s, free);
          const ac = spawnParked(w, g.name, { readyIn: randRange(s, 150, 320) });
          if (ac) logEvent(w, 'gate', 'info', `${ac.nextLeg?.callsign ?? ac.callsign} (${ac.type}) towed onto gate ${g.name} from remote parking for an originating flight`, [ac]);
        }
      }
    }
  }
  for (const ac of s.aircraft) {
    // initial contact
    if (ac.phase === 'inbound' && !ac.checkedIn && s.t - ac.spawnT > 4) {
      ac.checkedIn = true;
      const lvl = Math.abs(ac.vs) < 200 ? `level ${sayAlt(Math.round(ac.alt / 1000) * 1000)}` : `descending through ${sayAlt(Math.round(ac.alt / 100) * 100)}`;
      setRequest(w, ac, 'approach', `${ap.facility} Approach, ${csay(ac)}, ${lvl}, inbound ${ac.fix ?? ''} with information ${s.atis}.`);
    }
    if (ac.kind === 'arrival' && isAirborne(ac)) {
      const remain = dist(ac.x, ac.y, 0, 0) / NM / 200 * 3600 + 300;
      ac.est = s.t + remain;
      ac.delay = Math.max(0, ac.est - ac.sched);
    } else ac.est = ac.kind === 'departure' ? Math.max(ac.sched, s.t) : ac.sched + ac.delay;
    // reminders for long-ignored requests
    const r = ac.request;
    if (r && !isAirborne(ac) && s.t - r.since > 150 && s.t >= (ac.flags.remindAt ?? 0) && (r.deferredUntil ?? 0) < s.t) {
      ac.flags.remindAt = s.t + 180;
      const what = { clearance: 'still waiting for clearance', pushback: 'still ready for pushback', taxi: 'still waiting for taxi', crossing: 'still holding short', takeoff: 'still ready for departure', taxi_in: 'still waiting for taxi to the gate' }[r.type as string];
      if (what) radioPilot(w, ac, `${ap.facility}, ${csay(ac)}, ${what}.`);
    }
  }
  // purge aircraft that left long ago
  if (s.step % 600 === 0) s.aircraft = s.aircraft.filter((a) => a.phase !== 'gone' || s.t - (a.flags.goneAt ?? 0) < 300);
}
