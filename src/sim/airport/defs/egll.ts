/**
 * EGLL – London Heathrow.
 *
 * DATA PROVENANCE (be honest about this):
 *  - Runway designators, count, lengths, east–west orientation and the ~1400 m spacing of the two
 *    parallels (09L/27R north, 09R/27L south) follow the real airport, as does the general
 *    arrangement: Terminal 5 with its satellites at the west end between the runways, Terminals
 *    3 and 2 in the central area, Terminal 4 south of the southern runway (reached by crossing it).
 *    Threshold positions are approximations entered from general knowledge, not surveyed data.
 *  - Taxiways A (outer) and B (inner) really do loop the central area, but the connector
 *    positions and names, the "toast-rack" of north–south piers used here for T3/T2 as well as
 *    T5, taxilanes, gate positions and gate numbers are a SIMPLIFIED APPROXIMATION for
 *    playability. Not surveyed data; must not be used for navigation.
 */
import type { AirportDef, GateDef, TaxiwayDef } from '../build';
import type { SizeClass } from '../../types';

type P = [number, number];
const T: TaxiwayDef[] = [];
const tw = (name: string, pts: P[], kind: 'taxiway' | 'apron' = 'taxiway') => T.push({ name, pts, kind });
const ns = (name: string, x: number, y0: number, y1: number) => tw(name, [[x, y0], [x, y1]]);
/** 30° high-speed exit from a runway point toward a parallel taxiway (dir = roll direction) */
const hs = (name: string, x: number, yRwy: number, yTo: number, dir: 1 | -1) =>
  tw(name, [[x, yRwy], [x + dir * Math.abs(yTo - yRwy) * 1.73, yTo]]);

const YN = 700, YS = -700; // runway centrelines
const AY = 520, BY = 420; // taxiway A / B offsets from the airport axis
const YT4 = -880; // taxiway S, south of 09R/27L (Terminal 4 side)

// ── A (outer) and B (inner) loops between the runways ──
tw('A', [[-1935, AY], [1945, AY], [1945, -AY], [-1935, -AY], [-1935, AY]]);
tw('B', [[-1835, BY], [1845, BY], [1845, -BY], [-1835, -BY], [-1835, BY]]);
// ── 09L/27R links (B → A → runway) ──
ns('A1', -1935, AY, YN);
ns('A3', -1400, BY, YN);
ns('A5', -760, BY, YN);
ns('A7', -120, BY, YN);
ns('A9', 520, BY, YN);
ns('A10', 1100, BY, YN);
ns('A11', 1600, BY, YN);
ns('A13', 1945, AY, YN);
// one high-speed exit per gap between links so that exits never cross each other
hs('A10E', 1050, YN, AY, -1);
hs('A6E', -160, YN, AY, -1);
hs('A4E', -800, YN, AY, -1);
hs('A8W', -80, YN, AY, 1);
hs('A12W', 1150, YN, AY, 1);
// ── 09R/27L links; the eastern three continue across the runway to the Terminal 4 side ──
ns('S1', -1685, -BY, YS);
ns('S3', -1080, -BY, YS);
ns('S4', -440, -BY, YS);
ns('S5', 200, -BY, YS);
ns('S7', 760, -BY, YT4);
ns('S9', 1300, -BY, YT4);
ns('S11', 1945, -AY, YT4);
tw('S', [[760, YT4], [1945, YT4]]);
hs('S6E', 720, YS, -AY, -1);
hs('S3E', -480, YS, -AY, -1);
hs('S4W', -400, YS, -AY, 1);
hs('S8W', 800, YS, -AY, 1);

// ── pier alleys (taxilanes B south ↔ B north) and the Terminal 4 taxilane ──
const LANES: [string, number][] = [['Z1', -1720], ['Z2', -1400], ['Z3', -1080], ['Z4', -760], ['Z5', -440], ['Z6', -120], ['Z7', 200], ['Z8', 520]];
for (const [name, x] of LANES) tw(name, [[x, -BY], [x, BY]], 'apron');
tw('T4', [[860, YT4], [860, -980], [1760, -980], [1760, YT4]], 'apron');

// ── gates ──
const gates: GateDef[] = [];
const terminals: { name: string; poly: P[] }[] = [];
const wide = (i: number): SizeClass => (i % 2 === 1 ? 'XL' : 'L');
/** column of gates along a pier face: 6 widebody stands (80 m) or 11 narrowbody stands (40 m) */
function col(terminal: string, prefix: string, n0: number, x: number, big: boolean, airlines: string[]) {
  const n = big ? 6 : 11, step = big ? 80 : 40;
  for (let i = 0; i < n; i++)
    gates.push({ name: `${prefix}${n0 + i}`, terminal, x, y: -200 + i * step, size: big ? wide(i) : 'M', airlines });
  return n0 + n;
}
const pier = (name: string, x0: number, x1: number) => terminals.push({ name, poly: [[x0, -245], [x1, -245], [x1, 245], [x0, 245]] });
const BA = ['BAW', 'IBE'];
const T3 = ['VIR', 'AAL', 'DAL', 'UAE', 'QFA', 'JAL', 'BAW'];
const T2 = ['DLH', 'UAL', 'ACA', 'SIA', 'THY', 'EIN'];
const T4A = ['KLM', 'AFR', 'QTR', 'KAL'];
// Terminal 5: A (main building, narrowbody stands both sides), B and C satellites (widebody)
let n = col('5', 'A', 1, -1665, false, BA);
col('5', 'A', n, -1455, false, BA);
pier('Terminal 5A', -1637, -1483);
n = col('5', 'B', 31, -1300, true, BA);
col('5', 'B', n, -1180, true, BA);
pier('Terminal 5B', -1255, -1225);
n = col('5', 'C', 51, -980, true, BA);
col('5', 'C', n, -860, true, BA);
pier('Terminal 5C', -935, -905);
// Terminal 3
n = col('3', '', 301, -660, true, T3);
n = col('3', '', n, -540, true, T3);
pier('Terminal 3 (pier 5–7)', -615, -585);
n = col('3', '', n, -340, true, T3);
col('3', '', n, -175, false, ['BAW', 'IBE', 'AAL', 'VIR']);
pier('Terminal 3', -295, -203);
// Terminal 2 (A) and its satellite (B)
n = col('2', '', 201, -65, false, ['DLH', 'EIN', 'THY', 'ACA']);
n = col('2', '', n, 100, true, T2);
pier('Terminal 2A', -37, 55);
n = col('2', '', n, 300, true, T2);
col('2', '', n, 420, true, T2);
pier('Terminal 2B', 345, 375);
// Terminal 4 (south side)
for (let i = 0; i < 10; i++) gates.push({ name: `${401 + i}`, terminal: '4', x: 940 + i * 80, y: -1080, size: wide(i), airlines: T4A });
terminals.push({ name: 'Terminal 4', poly: [[900, -1165], [1700, -1165], [1700, -1125], [900, -1125]] });

const EURO = ['EDI', 'GLA', 'MAN', 'DUB', 'CDG', 'AMS', 'FRA', 'MUC', 'MAD', 'BCN', 'FCO', 'ZRH', 'GVA', 'CPH', 'ARN', 'OSL', 'VIE', 'ATH', 'LIS', 'IST', 'BLQ', 'CGN'];
const LONG = ['JFK', 'EWR', 'BOS', 'ORD', 'IAD', 'MIA', 'ATL', 'DFW', 'IAH', 'LAX', 'SFO', 'SEA', 'SAN', 'LAS', 'PHX', 'DEN', 'YYZ', 'YVR', 'HKG', 'SIN', 'HND', 'DEL', 'BOM', 'JNB', 'CPT', 'NBO', 'LOS', 'GRU', 'EZE', 'MEX', 'DXB', 'DOH', 'TLV', 'CAI', 'BKK', 'KUL', 'PVG', 'PEK', 'SYD'];

export const EGLL: AirportDef = {
  id: 'EGLL', icao: 'EGLL', iata: 'LHR',
  name: 'London Heathrow', city: 'London', facility: 'Heathrow',
  elevation: 83, fictional: false,
  dataNote:
    'Runway designators, count, lengths, spacing and the general terminal arrangement (T5 west, T3/T2 central, T4 south of 09R/27L) follow the real airport. ' +
    'Threshold positions, the taxiway network and names (apart from the A/B loop idea), pier shapes and gate positions/numbers are simplified approximations – not surveyed data.',
  runways: [
    { a: { name: '09L', x: -1950, y: YN }, b: { name: '27R', x: 1960, y: YN }, width: 50 },
    { a: { name: '09R', x: -1700, y: YS }, b: { name: '27L', x: 1960, y: YS }, width: 50 },
  ],
  taxiways: T,
  terminals,
  aprons: [
    [[-1760, -BY], [560, -BY], [560, BY], [-1760, BY]],
    [[830, -1120], [1790, -1120], [1790, YT4], [830, YT4]],
  ],
  gates,
  // Heathrow's real holding stacks are VORs with 3-letter idents (BNN, LAM, BIG, OCK); the arrival names below are
  // 5-letter stand-ins for those, the departure names are real SID waypoints. Positions are purely schematic.
  fixNames: { arr: ['LAMBN', 'BIGGN', 'OCKHM', 'BOVDN'], dep: ['UMLAT', 'KONAN', 'MAXIT', 'GOGSI'] },
  configs: [
    { name: 'Westerly (land 27L, depart 27R)', arr: ['27L'], dep: ['27R'] },
    { name: 'Westerly (land 27R, depart 27L)', arr: ['27R'], dep: ['27L'] },
    { name: 'Easterly (land 09L, depart 09R)', arr: ['09L'], dep: ['09R'] },
  ],
  mix: [
    { airline: 'BAW', weight: 30, types: ['A320', 'A320', 'A319', 'A321', 'A321'], routes: EURO },
    { airline: 'BAW', weight: 17, types: ['B772', 'B77W', 'B789', 'B78X', 'A359', 'A388', 'B772', 'B788'], routes: LONG },
    { airline: 'VIR', weight: 5, types: ['A359', 'B789', 'A333'], routes: ['JFK', 'BOS', 'ATL', 'LAX', 'SFO', 'MIA', 'MCO', 'LAS', 'SEA', 'IAD', 'DEL', 'BOM', 'JNB', 'LOS', 'HKG', 'PVG'] },
    { airline: 'DLH', weight: 4, types: ['A320', 'A321', 'A319'], routes: ['FRA', 'MUC'] },
    { airline: 'EIN', weight: 4, types: ['A320', 'A321'], routes: ['DUB'] },
    { airline: 'IBE', weight: 2.5, types: ['A320', 'A321', 'A359'], routes: ['MAD'] },
    { airline: 'AFR', weight: 2.5, types: ['A320', 'A321', 'A319'], routes: ['CDG'] },
    { airline: 'KLM', weight: 2.5, types: ['B738', 'E190', 'B737'], routes: ['AMS'] },
    { airline: 'THY', weight: 2, types: ['A321', 'A333', 'B77W'], routes: ['IST'] },
    { airline: 'AAL', weight: 4, types: ['B772', 'B77W', 'B789'], routes: ['JFK', 'ORD', 'DFW', 'MIA', 'PHL', 'CLT', 'LAX', 'BOS', 'RDU', 'PHX'] },
    { airline: 'UAL', weight: 3.5, types: ['B772', 'B789', 'B78X', 'B763'], routes: ['EWR', 'ORD', 'IAD', 'IAH', 'SFO', 'DEN', 'LAX'] },
    { airline: 'DAL', weight: 2, types: ['A333', 'B763', 'A359'], routes: ['ATL', 'JFK', 'DTW', 'MSP', 'BOS', 'SLC'] },
    { airline: 'ACA', weight: 1.5, types: ['B789', 'B77W', 'A333'], routes: ['YYZ', 'YVR', 'YUL'] },
    { airline: 'UAE', weight: 2, types: ['A388', 'B77W'], routes: ['DXB'] },
    { airline: 'QTR', weight: 2, types: ['A388', 'B77W', 'A359'], routes: ['DOH'] },
    { airline: 'SIA', weight: 1.2, types: ['A388', 'B77W', 'A359'], routes: ['SIN'] },
    { airline: 'JAL', weight: 0.8, types: ['B77W', 'B789', 'A359'], routes: ['HND'] },
    { airline: 'KAL', weight: 0.7, types: ['B77W', 'B789'], routes: ['ICN'] },
    { airline: 'QFA', weight: 0.8, types: ['A388', 'B789'], routes: ['SIN', 'SYD'] },
  ],
  baseRate: 80,
  towerPos: [40, 330],
};
