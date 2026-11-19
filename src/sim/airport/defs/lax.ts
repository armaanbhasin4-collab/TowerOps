/**
 * KLAX – Los Angeles International.
 *
 * DATA PROVENANCE (be honest about this):
 *  - Runway designators, count and lengths follow the real airport: four parallels in a north
 *    complex (6L/24R, 6R/24L) and a south complex (7L/25R, 7R/25L) either side of a central
 *    terminal area, with the Tom Bradley International Terminal across its west end.
 *  - Deliberate distortions: (a) all four runways are drawn on a common 065° bearing so that both
 *    the 06/24 and 07/25 designators match the geometry (the real runways are parallel at about
 *    083° true); (b) the two runways of each complex are drawn 300 m apart (really ~215–245 m)
 *    so that aircraft can hold between them; (c) threshold positions are approximate.
 *  - The taxiway network (E/D north, C/B south, A south of 25L, cross-field S/R), the single-row
 *    terminal frontages, taxilanes, gate positions and gate numbers are a SIMPLIFIED
 *    APPROXIMATION for playability – the real terminals are piers with alleys. Not surveyed
 *    data; must not be used for navigation.
 *
 * Authored in a frame with the runways along +x, then rotated 25° anticlockwise.
 */
import type { AirportDef, GateDef, TaxiwayDef } from '../build';
import type { SizeClass } from '../../types';

type P = [number, number];
const TH = (-25 * Math.PI) / 180, CS = Math.cos(TH), SN = Math.sin(TH);
const r2 = (v: number) => Math.round(v * 100) / 100;
/** frame → world (x east, y north) */
const W = (x: number, y: number): P => [r2(x * CS + y * SN), r2(-x * SN + y * CS)];
const WP = (pts: P[]) => pts.map(([x, y]) => W(x, y));

const T: TaxiwayDef[] = [];
const tw = (name: string, pts: P[], kind: 'taxiway' | 'apron' = 'taxiway') => T.push({ name, pts: WP(pts), kind });
const ew = (name: string, y: number, x0: number, x1: number) => tw(name, [[x0, y], [x1, y]]);
const ns = (name: string, x: number, y0: number, y1: number) => tw(name, [[x, y0], [x, y1]]);
/** 30° high-speed exit from a runway point toward a parallel taxiway (dir = roll direction) */
const hs = (name: string, x: number, yRwy: number, yTo: number, dir: 1 | -1) =>
  tw(name, [[x, yRwy], [x + dir * Math.abs(yTo - yRwy) * 1.73, yTo]]);
/** exit from the outer north runway: 30° turn-off, then straight across the inner runway to E */
const dog = (name: string, x: number, dir: 1 | -1) => tw(name, [[x, Y6L], [x + dir * 260, 1000], [x + dir * 260, YE]]);

// runway centrelines and parallel taxiways (frame y)
const Y6L = 1150, Y6R = 850, Y7L = -850, Y7R = -1150;
const YE = 670, YD = 570, YC = -570, YB = -670, YA = -1330;

// ── north complex ──
ew('E', YE, -1896, 1209);
ew('D', YD, -1896, 1400);
ns('E6', -1896, YD, Y6R);
ns('E8', -900, YD, Y6L);
ns('E10', -300, 490, Y6L);
ns('E12', 300, 490, Y6L);
ns('E14', 800, 490, Y6L);
ns('E17', 1209, YD, Y6L);
hs('E13', 700, Y6R, YE, -1);
hs('E11', -100, Y6R, YE, -1);
hs('E7', -1300, Y6R, YE, 1);
hs('E9', -200, Y6R, YE, 1);
dog('Y', 620, -1);
dog('Z', -400, -1);
dog('W', -800, 1);
dog('V', -80, 1);
// ── cross-field (west of the Bradley terminal) ──
ns('S', -1482, Y6L, YA);
ns('R', -1270, YD, YC);
// ── south complex ──
ew('C', YC, -1785, 1870);
ew('B', YB, -1785, 1870);
ew('A', YA, -1482, 1870);
ns('B1', -1785, YC, Y7L);
ns('F', -900, YC, YA);
ns('G', -300, -490, YA);
ns('H', 300, -490, YA);
ns('J', 900, -490, YA);
ns('K', 1400, YC, YA);
ns('U', 1870, YC, YA);
hs('B6', 700, Y7L, YB, -1);
hs('B4', -100, Y7L, YB, -1);
hs('B3', -1300, Y7L, YB, 1);
hs('B5', -200, Y7L, YB, 1);
hs('A6', 650, Y7R, YA, -1);
hs('A4', -200, Y7R, YA, -1);
hs('A3', -700, Y7R, YA, 1);
hs('A5', 100, Y7R, YA, 1);

// ── taxilanes ──
tw('D8', [[-560, YD], [-560, 490], [1400, 490], [1400, YD]], 'apron'); // north frontage (T3, T2, T1)
tw('C8', [[-560, YC], [-560, -490], [1400, -490], [1400, YC]], 'apron'); // south frontage (T4–T8)
tw('TE', [[-740, YC], [-740, YD]], 'apron'); // Bradley east side
tw('TW', [[-1060, YC], [-1060, YD]], 'apron'); // Bradley west side / west gates
tw('CG', [[-600, YA], [-600, -1430], [600, -1430], [600, YA]], 'apron'); // south cargo

// ── gates ──
const gates: GateDef[] = [];
const terminals: { name: string; poly: P[] }[] = [];
function row(terminal: string, name: (i: number) => string, n: number, x: number, y: number, dx: number, dy: number,
  size: (i: number) => SizeClass, airlines: string[], cargo = false) {
  for (let i = 0; i < n; i++) {
    const [wx, wy] = W(x + dx * i, y + dy * i);
    gates.push({ name: name(i), terminal, x: wx, y: wy, size: size(i), airlines, ...(cargo ? { cargo } : {}) });
  }
}
const num = (base: number) => (i: number) => `${base + i}`;
const M = (): SizeClass => 'M';
const L = (): SizeClass => 'L';
const wide = (i: number): SizeClass => (i % 2 === 1 ? 'XL' : 'L');
/** single-row frontage: side = +1 north row (gates south of lane y=490), -1 south row */
function frontage(t: string, x0: number, n: number, big: boolean, side: 1 | -1, airlines: string[]) {
  const step = big ? 80 : 40;
  const yLane = side * 490;
  const yG = yLane - side * (big ? 100 : 55);
  row(t, num(+t * 100 + 1), n, x0, yG, step, 0, big ? L : M, airlines);
  const y1 = yG - side * (big ? 45 : 27), y2 = side * 290;
  terminals.push({ name: `Terminal ${t}`, poly: WP([[x0 - 30, y1], [x0 + (n - 1) * step + 30, y1], [x0 + (n - 1) * step + 30, y2], [x0 - 30, y2]]) });
}
frontage('3', -500, 12, false, 1, ['DAL', 'SKW']);
frontage('2', 60, 7, true, 1, ['DAL', 'VIR', 'KLM', 'AFR']);
frontage('1', 680, 17, false, 1, ['SWA']);
frontage('4', -500, 11, false, -1, ['AAL', 'SKW']);
frontage('5', 20, 10, false, -1, ['AAL', 'JBU', 'NKS']);
frontage('6', 520, 8, false, -1, ['ASA', 'ACA', 'SKW']);
frontage('7', 900, 4, true, -1, ['UAL']);
frontage('8', 1240, 4, false, -1, ['UAL', 'SKW']);
const INTL = ['QFA', 'SIA', 'JAL', 'KAL', 'BAW', 'DLH', 'AFR', 'KLM', 'UAE', 'QTR', 'THY', 'AAL', 'DAL', 'UAL', 'ACA'];
row('TBIT', (i) => `B${130 + i}`, 9, -840, -320, 0, 80, wide, INTL);
row('TBIT', (i) => `B${148 + i}`, 9, -960, -320, 0, 80, wide, INTL);
row('West Gates', (i) => `W${201 + i}`, 9, -1160, -320, 0, 80, L, INTL);
row('Cargo', (i) => `CG${i + 1}`, 9, -480, -1530, 120, 0, () => 'XL', ['FDX', 'UPS'], true);
terminals.push({ name: 'Tom Bradley International', poly: WP([[-915, -365], [-885, -365], [-885, 365], [-915, 365]]) });
terminals.push({ name: 'West Gates', poly: WP([[-1235, -365], [-1205, -365], [-1205, 365], [-1235, 365]]) });
terminals.push({ name: 'South Cargo', poly: WP([[-540, -1620], [540, -1620], [540, -1580], [-540, -1580]]) });

const DOM = ['SFO', 'SEA', 'LAS', 'PHX', 'DEN', 'DFW', 'ORD', 'JFK', 'EWR', 'BOS', 'ATL', 'MIA', 'IAH', 'SLC', 'PDX', 'SJC', 'OAK', 'SMF', 'HNL', 'OGG', 'MSP', 'DTW', 'AUS', 'BNA', 'MCO', 'IAD', 'DCA', 'PHL', 'CLT'];
const WEST = ['SFO', 'SJC', 'OAK', 'SMF', 'LAS', 'PHX', 'SEA', 'PDX', 'SLC', 'DEN', 'SAN'];

export const LAX: AirportDef = {
  id: 'LAX', icao: 'KLAX', iata: 'LAX',
  name: 'Los Angeles International', city: 'Los Angeles', facility: 'Los Angeles',
  elevation: 128, fictional: false,
  dataNote:
    'Runway designators, count, lengths and the north/south complexes around a central terminal area follow the real airport. ' +
    'All four runways are drawn at 065° (real ≈ 083° true) and each pair is spread to 300 m so the designators and hold points work in the sim. ' +
    'Threshold positions, taxiways and their letters, terminal shapes and gate positions/numbers are simplified approximations – not surveyed data.',
  runways: [
    { a: { name: '06L', x: W(-1497, Y6L)[0], y: W(-1497, Y6L)[1] }, b: { name: '24R', x: W(1224, Y6L)[0], y: W(1224, Y6L)[1] } },
    { a: { name: '06R', x: W(-1911, Y6R)[0], y: W(-1911, Y6R)[1] }, b: { name: '24L', x: W(1224, Y6R)[0], y: W(1224, Y6R)[1] } },
    { a: { name: '07L', x: W(-1800, Y7L)[0], y: W(-1800, Y7L)[1] }, b: { name: '25R', x: W(1885, Y7L)[0], y: W(1885, Y7L)[1] } },
    { a: { name: '07R', x: W(-1497, Y7R)[0], y: W(-1497, Y7R)[1] }, b: { name: '25L', x: W(1885, Y7R)[0], y: W(1885, Y7R)[1] }, width: 60 },
  ],
  taxiways: T,
  terminals,
  aprons: [
    WP([[-590, 300], [1430, 300], [1430, YD], [-590, YD]]),
    WP([[-590, YC], [1430, YC], [1430, -300], [-590, -300]]),
    WP([[-1200, YC], [-710, YC], [-710, YD], [-1200, YD]]),
    WP([[-630, -1575], [630, -1575], [630, YA], [-630, YA]]),
  ],
  gates,
  // fix names borrowed from real Southern California procedures, but their positions here are purely schematic
  fixNames: { arr: ['SEAVU', 'LEENA', 'FICKY', 'SADDE'], dep: ['ORCKA', 'HOLTZ', 'PNDAH', 'DOTSS'] },
  configs: [
    { name: 'West flow (land 24R/25L, depart 24L/25R)', arr: ['24R', '25L'], dep: ['24L', '25R'] },
    { name: 'East flow (land 06L/07R, depart 06R/07L)', arr: ['06L', '07R'], dep: ['06R', '07L'] },
    { name: 'Over-ocean nights (land 06R, depart 25R)', arr: ['06R'], dep: ['25R'] },
  ],
  mix: [
    { airline: 'DAL', weight: 13, types: ['A321', 'B738', 'A320', 'BCS3', 'B752', 'A319'], routes: DOM },
    { airline: 'AAL', weight: 13, types: ['A321', 'B738', 'A321', 'A319', 'B38M'], routes: DOM },
    { airline: 'UAL', weight: 12, types: ['B738', 'A320', 'B38M', 'A319', 'B752'], routes: DOM },
    { airline: 'SWA', weight: 11, types: ['B737', 'B738', 'B38M'], routes: [...WEST, 'HOU', 'DAL', 'MDW', 'BNA', 'AUS', 'STL', 'MCI', 'BWI'] },
    { airline: 'ASA', weight: 7, types: ['B738', 'B38M', 'E75L'], routes: ['SEA', 'PDX', 'SFO', 'SJC', 'ANC', 'SLC', 'BOS', 'JFK', 'DCA', 'CUN'] },
    { airline: 'JBU', weight: 3, types: ['A321', 'A320', 'BCS3'], routes: ['JFK', 'BOS', 'FLL', 'MCO', 'EWR'] },
    { airline: 'NKS', weight: 3, types: ['A320', 'A321', 'A319'], routes: ['LAS', 'DFW', 'ORD', 'DTW', 'IAH', 'OAK', 'FLL'] },
    { airline: 'SKW', weight: 6, types: ['E75L', 'CRJ7', 'CRJ9'], routes: ['SJC', 'SMF', 'OAK', 'PHX', 'LAS', 'SLC', 'SAN', 'ONT', 'PDX'] },
    { airline: 'DAL', weight: 2.5, types: ['A333', 'A359', 'B763'], routes: ['HND', 'SYD', 'CDG', 'AMS', 'LHR', 'ICN', 'AKL', 'HNL', 'JFK'] },
    { airline: 'AAL', weight: 2.5, types: ['B772', 'B77W', 'B789', 'B788'], routes: ['LHR', 'HND', 'SYD', 'NRT', 'GRU', 'MIA', 'JFK', 'DFW'] },
    { airline: 'UAL', weight: 2.5, types: ['B789', 'B772', 'B77W', 'B78X'], routes: ['LHR', 'NRT', 'SYD', 'PVG', 'HKG', 'EWR', 'IAD', 'ORD', 'HNL'] },
    { airline: 'ACA', weight: 2, types: ['A320', 'A321', 'B38M', 'B789'], routes: ['YYZ', 'YVR', 'YUL'] },
    { airline: 'QFA', weight: 1.6, types: ['A388', 'B789'], routes: ['SYD', 'AKL', 'JFK'] },
    { airline: 'SIA', weight: 1, types: ['A359', 'B77W'], routes: ['SIN', 'NRT'] },
    { airline: 'JAL', weight: 1.2, types: ['B77W', 'B789'], routes: ['HND', 'NRT'] },
    { airline: 'KAL', weight: 1.4, types: ['A388', 'B77W', 'B748'], routes: ['ICN'] },
    { airline: 'BAW', weight: 1.4, types: ['A388', 'B77W', 'B789'], routes: ['LHR'] },
    { airline: 'VIR', weight: 0.8, types: ['A359', 'B789'], routes: ['LHR', 'MAN'] },
    { airline: 'DLH', weight: 1.1, types: ['A388', 'B748', 'A359'], routes: ['FRA', 'MUC'] },
    { airline: 'AFR', weight: 1, types: ['B77W', 'A359'], routes: ['CDG'] },
    { airline: 'KLM', weight: 0.8, types: ['B772', 'B789', 'B78X'], routes: ['AMS'] },
    { airline: 'UAE', weight: 0.8, types: ['A388', 'B77W'], routes: ['DXB'] },
    { airline: 'QTR', weight: 0.7, types: ['A359', 'B77W'], routes: ['DOH'] },
    { airline: 'THY', weight: 0.7, types: ['B77W', 'A359'], routes: ['IST'] },
    { airline: 'FDX', weight: 2.2, types: ['B763', 'B772', 'B752'], routes: ['MEM', 'IND', 'OAK', 'ANC', 'HNL', 'EWR'] },
    { airline: 'UPS', weight: 1.6, types: ['B763', 'B748', 'B752'], routes: ['SDF', 'ONT', 'ANC', 'DFW', 'PHL', 'HNL'] },
  ],
  baseRate: 80,
  towerPos: W(150, 0),
};
