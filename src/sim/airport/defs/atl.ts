/**
 * KATL – Hartsfield–Jackson Atlanta International.
 *
 * DATA PROVENANCE (be honest about this):
 *  - Runway designators, count, lengths, orientation and relative spacing follow the real
 *    airport (five east–west parallels: 8L/26R, 8R/26L, 9L/27R, 9R/27L, 10/28). Threshold
 *    positions are approximations entered from general knowledge, not surveyed data.
 *  - The midfield concourse arrangement (T, A–F between the north and south complexes) is real.
 *  - The taxiway network, taxiway letters, gate positions and gate counts are a SIMPLIFIED
 *    APPROXIMATION designed for playability. It is not geographically exact and must not be
 *    used for navigation.
 */
import type { AirportDef, GateDef, TaxiwayDef } from '../build';
import type { SizeClass } from '../../types';

const T: TaxiwayDef[] = [];
const tw = (name: string, pts: [number, number][], kind: 'taxiway' | 'apron' = 'taxiway') => T.push({ name, pts, kind });
const ew = (name: string, y: number, x0: number, x1: number) => tw(name, [[x0, y], [x1, y]]);
const ns = (name: string, x: number, y0: number, y1: number) => tw(name, [[x, y0], [x, y1]]);
/** 30° high-speed exit from a runway point toward a parallel taxiway */
const hs = (name: string, x: number, yRwy: number, yTo: number, dir: 1 | -1) =>
  tw(name, [[x, yRwy], [x + dir * Math.abs(yTo - yRwy) * 1.73, yTo]]);

// runway centreline y positions
const Y8L = 1423, Y8R = 1123, Y9L = -222, Y9R = -545, Y10 = -1823;

// ── north complex ──
ew('B', 1273, -1009, 2093);
ew('E', 960, -1100, 2093);
ew('F', 860, -1100, 2093);
ns('B1', -995, 1273, Y8L);
ns('C', -940, 860, 1273);
ns('D', -400, 860, Y8L);
ns('G', 150, 860, Y8L);
ns('H', 700, 860, Y8L);
ns('J', 1250, 860, Y8L);
ns('K', 1705, 860, Y8L);
ns('V', 2080, 860, 1273);
hs('B4', -150, Y8L, 1273, -1);
hs('B6', 350, Y8L, 1273, -1);
hs('B10', 450, Y8L, 1273, 1);
hs('B12', 950, Y8L, 1273, 1);
hs('E5', 300, Y8R, 960, -1);
hs('E7', 1000, Y8R, 960, -1);
hs('E9', 250, Y8R, 960, 1);
hs('E11', 900, Y8R, 960, 1);

// ── midfield ramps (two taxilanes per ramp) ──
const ramps: [string, number][] = [['R1', -900], ['R2', -600], ['R3', -300], ['R4', 0], ['R5', 327], ['R6', 760]];
for (const [name, c] of ramps) {
  tw(name, [[c - 38, 10], [c - 38, 860]], 'apron');
  tw(name, [[c + 38, 10], [c + 38, 860]], 'apron');
  tw(name, [[c - 38, 435], [c + 38, 435]], 'apron');
}
tw('R7', [[1170, 10], [1170, 860]], 'apron');

// ── south complex ──
ew('L', 10, -1843, 1908);
ew('M', -80, -1843, 1908);
ew('N', -383, -1843, 1908);
ew('S', -700, -1843, 1000);
ns('P', -1830, 10, -700);
ns('Q', -1300, 10, -700);
ns('T', -800, 10, -700);
ns('U', -300, 10, -700);
ns('W', 200, 10, -700);
ns('X', 600, 10, -700);
ns('Y', 878, 10, -700);
ns('Z', 1400, 10, -383);
ns('A', 1895, 10, -383);
hs('M4', -500, Y9L, -80, -1);
hs('M6', 300, Y9L, -80, -1);
hs('M10', -200, Y9L, -80, 1);
hs('M12', 500, Y9L, -80, 1);
hs('N4', -1050, Y9R, -383, -1);
hs('N6', -550, Y9R, -383, -1);
hs('N10', -150, Y9R, -383, 1);
hs('N12', 350, Y9R, -383, 1);

// ── fifth runway + south cargo ──
ew('SC', -1673, -1834, 898);
ns('SG', -1200, -700, Y10);
ns('SJ', 300, -700, Y10);
ns('SC1', -1822, -1673, Y10);
ns('SC3', -500, -1673, Y10);
ns('SC5', 886, -1673, Y10);
hs('SC4', -850, Y10, -1673, -1);
hs('SC6', -350, Y10, -1673, -1);
hs('SC8', -650, Y10, -1673, 1);
hs('SC10', 0, Y10, -1673, 1);
tw('CG', [[-1200, -900], [300, -900]], 'apron');

// ── gates ──
const gates: GateDef[] = [];
const terminals: { name: string; poly: [number, number][] }[] = [];
interface Conc { name: string; x: number; wide: boolean; west: boolean; airlines: string[] }
const concourses: Conc[] = [
  { name: 'T', x: -1050, wide: false, west: false, airlines: ['UAL', 'AAL', 'ASA', 'DAL'] },
  { name: 'A', x: -750, wide: false, west: true, airlines: ['DAL'] },
  { name: 'B', x: -450, wide: false, west: true, airlines: ['DAL'] },
  { name: 'C', x: -150, wide: false, west: true, airlines: ['SWA', 'DAL', 'EDV'] },
  { name: 'D', x: 150, wide: false, west: true, airlines: ['NKS', 'FFT', 'JBU', 'AAL', 'EDV', 'DAL'] },
  { name: 'E', x: 540, wide: true, west: true, airlines: ['DAL', 'BAW', 'DLH', 'AFR', 'KLM', 'VIR', 'KAL'] },
  { name: 'F', x: 980, wide: true, west: true, airlines: ['DAL', 'QTR', 'THY', 'AFR', 'KLM', 'BAW', 'DLH', 'KAL', 'VIR'] },
];
for (const c of concourses) {
  terminals.push({ name: `Concourse ${c.name}`, poly: [[c.x - 16, 105], [c.x + 16, 105], [c.x + 16, 765], [c.x - 16, 765]] });
  const step = c.wide ? 75 : 40;
  const y0 = c.wide ? 135 : 130;
  const count = c.wide ? 9 : 16;
  const depth = c.wide ? 76 : 58;
  for (let i = 0; i < count; i++) {
    const y = y0 + i * step;
    let size: SizeClass = c.wide ? (i % 3 === 1 ? 'XL' : 'L') : i % 4 === 3 ? 'L' : 'M';
    if (c.name === 'T') {
      gates.push({ name: `T${i + 1}`, terminal: 'T', x: c.x + depth, y, size, airlines: c.airlines });
      continue;
    }
    gates.push({ name: `${c.name}${i * 2 + 1}`, terminal: c.name, x: c.x - depth, y, size, airlines: c.airlines });
    gates.push({ name: `${c.name}${i * 2 + 2}`, terminal: c.name, x: c.x + depth, y, size, airlines: c.airlines });
  }
}
terminals.push({ name: 'Domestic Terminal', poly: [[-1290, 250], [-1066, 250], [-1066, 620], [-1290, 620]] });
terminals.push({ name: 'International Terminal', poly: [[1230, 300], [1340, 300], [1340, 570], [1230, 570]] });
terminals.push({ name: 'South Cargo', poly: [[-1100, -1060], [220, -1060], [220, -1020], [-1100, -1020]] });
for (let i = 0; i < 9; i++) {
  gates.push({ name: `CG${i + 1}`, terminal: 'Cargo', x: -1040 + i * 150, y: -990, size: 'XL', airlines: ['UPS', 'FDX'], cargo: true });
}

const DOM_HUB = ['LGA', 'JFK', 'BOS', 'DCA', 'ORD', 'DFW', 'DEN', 'LAX', 'SFO', 'SEA', 'MIA', 'MCO', 'TPA', 'FLL', 'MSP', 'DTW', 'SLC', 'PHL', 'CLT', 'RDU', 'BNA', 'MSY', 'IAH', 'AUS', 'LAS', 'PHX', 'SAN', 'BWI', 'EWR', 'STL', 'MCI', 'IND', 'CMH', 'PIT', 'RIC', 'JAX', 'SAV', 'CHS'];
const REGIONAL = ['AGS', 'CHA', 'TYS', 'GSP', 'MGM', 'BHM', 'PNS', 'SAV', 'CHS', 'JAX', 'RIC', 'ORF', 'CMH', 'IND'];

export const ATL: AirportDef = {
  id: 'ATL', icao: 'KATL', iata: 'ATL',
  name: 'Hartsfield–Jackson Atlanta International', city: 'Atlanta', facility: 'Atlanta',
  elevation: 1026, fictional: false,
  dataNote:
    'Runway designators, lengths, orientation and the midfield concourse arrangement follow the real airport. ' +
    'Threshold positions, the taxiway network, taxiway letters and gate positions are simplified approximations – not surveyed data.',
  runways: [
    { a: { name: '08L', x: -1009, y: Y8L }, b: { name: '26R', x: 1722, y: Y8L } },
    { a: { name: '08R', x: -954, y: Y8R }, b: { name: '26L', x: 2093, y: Y8R } },
    { a: { name: '09L', x: -1843, y: Y9L }, b: { name: '27R', x: 1908, y: Y9L } },
    { a: { name: '09R', x: -1843, y: Y9R }, b: { name: '27L', x: 889, y: Y9R } },
    { a: { name: '10', x: -1834, y: Y10 }, b: { name: '28', x: 898, y: Y10 } },
  ],
  taxiways: T,
  terminals,
  aprons: [
    [[-1100, 25], [1235, 25], [1235, 845], [-1100, 845]],
    [[-1230, -1015], [330, -1015], [330, -870], [-1230, -870]],
  ],
  gates,
  fixNames: { arr: ['LOGEN', 'SINCA', 'HONIE', 'ERLIN'], dep: ['SMKEY', 'PLMMR', 'VRSTY', 'POUNC'] },
  configs: [
    { name: 'West flow', arr: ['26R', '27L', '28'], dep: ['26L', '27R'] },
    { name: 'East flow', arr: ['08L', '09R', '10'], dep: ['08R', '09L'] },
  ],
  mix: [
    { airline: 'DAL', weight: 50, types: ['B738', 'A321', 'A321', 'A320', 'A319', 'BCS3', 'B752', 'B738'], routes: DOM_HUB },
    { airline: 'DAL', weight: 6, types: ['A333', 'A359', 'B763', 'B763'], routes: ['CDG', 'AMS', 'LHR', 'FRA', 'FCO', 'MAD', 'ICN', 'HND', 'GRU', 'JNB', 'LOS', 'HNL', 'LAX', 'DUB', 'BCN'] },
    { airline: 'EDV', weight: 9, types: ['CRJ9', 'CRJ9', 'CRJ7'], routes: REGIONAL },
    { airline: 'SWA', weight: 9, types: ['B737', 'B738', 'B38M'], routes: ['MDW', 'DAL', 'HOU', 'BWI', 'DEN', 'LAS', 'MCO', 'TPA', 'FLL', 'BNA', 'STL', 'MCI', 'PHX', 'AUS'] },
    { airline: 'AAL', weight: 4, types: ['B738', 'A321', 'A319'], routes: ['DFW', 'CLT', 'MIA', 'ORD', 'PHL', 'PHX', 'DCA'] },
    { airline: 'UAL', weight: 3, types: ['B738', 'A320', 'A319', 'B38M'], routes: ['ORD', 'DEN', 'IAH', 'EWR', 'IAD', 'SFO'] },
    { airline: 'NKS', weight: 3, types: ['A320', 'A321', 'A319'], routes: ['FLL', 'MCO', 'LAS', 'DTW', 'DFW', 'EWR', 'BWI'] },
    { airline: 'FFT', weight: 3, types: ['A320', 'A321'], routes: ['DEN', 'MCO', 'LAS', 'PHL', 'ORD', 'CUN'] },
    { airline: 'JBU', weight: 1.2, types: ['A320', 'BCS3', 'E190'], routes: ['BOS', 'JFK', 'FLL'] },
    { airline: 'ASA', weight: 1, types: ['B738', 'B38M'], routes: ['SEA', 'PDX', 'SAN'] },
    { airline: 'BAW', weight: 0.8, types: ['B772', 'B789'], routes: ['LHR'] },
    { airline: 'DLH', weight: 0.6, types: ['A333', 'A359'], routes: ['FRA', 'MUC'] },
    { airline: 'AFR', weight: 0.8, types: ['A359', 'B772'], routes: ['CDG'] },
    { airline: 'KLM', weight: 0.8, types: ['A333', 'B789', 'B78X'], routes: ['AMS'] },
    { airline: 'VIR', weight: 0.5, types: ['A359', 'B789'], routes: ['LHR', 'MAN'] },
    { airline: 'QTR', weight: 0.4, types: ['A359', 'B77W'], routes: ['DOH'] },
    { airline: 'THY', weight: 0.4, types: ['B77W', 'A359'], routes: ['IST'] },
    { airline: 'KAL', weight: 0.4, types: ['B77W', 'A388'], routes: ['ICN'] },
    { airline: 'UPS', weight: 1.2, types: ['B763', 'B752', 'B748'], routes: ['SDF', 'ONT', 'PHL', 'DFW'] },
    { airline: 'FDX', weight: 1.2, types: ['B763', 'B752', 'B772'], routes: ['MEM', 'IND', 'EWR', 'OAK'] },
  ],
  baseRate: 90,
  towerPos: [435, 62],
};
