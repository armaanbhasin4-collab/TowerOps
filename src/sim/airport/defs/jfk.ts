/**
 * KJFK – New York John F. Kennedy International.
 *
 * DATA PROVENANCE (be honest about this):
 *  - Runway designators, count and lengths follow the real airport: two pairs of parallels
 *    (4L/22R, 4R/22L and 13L/31R, 13R/31L) at right angles around a central terminal area.
 *    Threshold positions are approximations entered from general knowledge, not surveyed data.
 *  - In reality 4L/22R physically intersects 13R/31L near the 31L end; here the 13R/31L runway
 *    is shifted so that the two do NOT intersect (kept simple for playability).
 *  - Taxiways A (inner) and B (outer) really do ring the central terminal area, but everything
 *    else – connector positions and letters, the ramp taxilane, gate positions, gate numbers and
 *    which side of the ring each terminal sits on – is a SIMPLIFIED APPROXIMATION. It is not
 *    geographically exact and must not be used for navigation.
 *
 * The layout is authored in a "frame" where 13→31 runs along +x and 04→22 along +y, then rotated
 * clockwise by 43° so that the geometric bearings match the designators.
 */
import type { AirportDef, GateDef, TaxiwayDef } from '../build';
import type { SizeClass } from '../../types';

type P = [number, number];
const TH = (43 * Math.PI) / 180, CS = Math.cos(TH), SN = Math.sin(TH);
const OX = 500, OY = 0; // frame point that becomes the world origin
const r2 = (v: number) => Math.round(v * 100) / 100;
/** frame → world (x east, y north) */
const W = (x: number, y: number): P => [r2((x - OX) * CS + (y - OY) * SN), r2(-(x - OX) * SN + (y - OY) * CS)];
const WP = (pts: P[]) => pts.map(([x, y]) => W(x, y));

const T: TaxiwayDef[] = [];
const tw = (name: string, pts: P[], kind: 'taxiway' | 'apron' = 'taxiway') => T.push({ name, pts: WP(pts), kind });
/** 30° high-speed exit off an x-aligned runway (dir = roll direction along x) */
const hsX = (name: string, x: number, yRwy: number, yTo: number, dir: 1 | -1) =>
  tw(name, [[x, yRwy], [x + dir * Math.abs(yTo - yRwy) * 1.73, yTo]]);
/** 30° high-speed exit off a y-aligned runway (dir = roll direction along y) */
const hsY = (name: string, y: number, xRwy: number, xTo: number, dir: 1 | -1) =>
  tw(name, [[xRwy, y], [xTo, y + dir * Math.abs(xTo - xRwy) * 1.73]]);

// runway centrelines (frame)
const Y13L = 1200, Y13R = -1200, X4L = 2250, X4R = 3164;

// ── taxiway B (outer ring, doubles as the parallel taxiway of 13L/31R, 13R/31L and 4L/22R) ──
tw('B', [[-1285, 1000], [2050, 1000]]);
tw('B', [[2050, 1167], [2050, -2485]]);
tw('B', [[-1000, 1000], [-1000, -1000]]);
tw('B', [[-1000, -1000], [2050, -1000]]);
// ── taxiway A (inner ring) ──
tw('A', [[-900, 900], [1950, 900], [1950, -900], [-900, -900], [-900, 900]]);
// ── western parallels of 13R/31L and southern parallels of 4L/22R ──
tw('Q', [[-2708, -1000], [-1000, -1000]]);
tw('P', [[-2708, -900], [-900, -900]]);
tw('K', [[1950, -900], [1950, -2485]]);
// ── parallel between the 4s ──
tw('C', [[2964, -1363], [2964, 1167]]);
// ── ramp taxilane ring inside A (the terminals face it) ──
tw('RN', [[-820, 820], [1870, 820]], 'apron');
tw('RE', [[1870, 820], [1870, -820]], 'apron');
tw('RS', [[1870, -820], [-820, -820]], 'apron');
tw('RW', [[-820, -820], [-820, 820]], 'apron');

// ── 13L/31R connectors (ramp → A → B → runway) ──
tw('D', [[-1285, 1000], [-1285, Y13L]]);
tw('E', [[-700, 820], [-700, Y13L]]);
tw('F', [[-100, 820], [-100, Y13L]]);
tw('G', [[500, 820], [500, Y13L]]);
tw('H', [[1100, 820], [1100, Y13L]]);
tw('J', [[1733, 820], [1733, Y13L]]);
// one high-speed exit per gap between connectors so that exits never cross each other
hsX('F1', 100, Y13L, 1000, 1);
hsX('G1', 600, Y13L, 1000, 1);
hsX('E1', -150, Y13L, 1000, -1);
hsX('D1', -750, Y13L, 1000, -1);
// ── west side links ──
tw('WA', [[-820, 600], [-1000, 600]]);
tw('WB', [[-820, 0], [-1000, 0]]);
tw('WC', [[-820, -600], [-1000, -600]]);
// ── 13R/31L connectors ──
tw('PA', [[-2708, -900], [-2708, Y13R]]);
tw('PB', [[-2100, -900], [-2100, Y13R]]);
tw('PC', [[-1650, -900], [-1650, Y13R]]);
tw('PD', [[-1150, -900], [-1150, Y13R]]);
tw('L', [[-620, -820], [-620, Y13R]]);
tw('M', [[-140, -820], [-140, Y13R]]);
tw('N', [[500, -820], [500, Y13R]]);
tw('S', [[1080, -820], [1080, Y13R]]);
tw('U', [[1685, -820], [1685, Y13R]]);
hsX('L1', -1100, Y13R, -1000, 1);
hsX('M1', -100, Y13R, -1000, 1);
hsX('N1', 550, Y13R, -1000, 1);
hsX('L2', -180, Y13R, -1000, -1);
hsX('PE', -1200, Y13R, -1000, -1);
// ── 4L/22R and 4R/22L connectors (the outer runway is reached by crossing the inner one) ──
tw('V', [[2050, 1167], [X4R, 1167]]);
tw('W', [[1870, 480], [X4R, 480]]);
tw('Y', [[1870, -150], [X4R, -150]]);
tw('Z', [[1870, -750], [X4R, -750]]);
tw('FA', [[1950, -1363], [X4R, -1363]]);
tw('FB', [[1950, -1900], [X4L, -1900]]);
tw('FC', [[1950, -2485], [X4L, -2485]]);
hsY('Y1', -100, X4L, 2050, 1);
hsY('Z1', -1300, X4L, 2050, 1);
hsY('W1', 900, X4L, 2050, -1);
hsY('Y2', -200, X4L, 2050, -1);
hsY('FD', -1400, X4L, 2050, -1);
hsY('C1', -100, X4R, 2964, 1);
hsY('C2', 520, X4R, 2964, 1);
hsY('C3', -200, X4R, 2964, -1);
hsY('C4', -800, X4R, 2964, -1);

// ── gates: parked on the inside of the ramp ring, nose toward the terminal ──
const gates: GateDef[] = [];
/** row of `n` gates starting at frame (x,y) stepping by (dx,dy) */
function row(terminal: string, name: (i: number) => string, n: number, x: number, y: number, dx: number, dy: number,
  size: (i: number) => SizeClass, airlines: string[]) {
  for (let i = 0; i < n; i++) {
    const [wx, wy] = W(x + dx * i, y + dy * i);
    gates.push({ name: name(i), terminal, x: wx, y: wy, size: size(i), airlines });
  }
}
const num = (base: number) => (i: number) => `${base + i}`;
const wide = (i: number): SizeClass => (i % 3 === 1 ? 'XL' : 'L');
const T4 = ['DAL', 'VIR', 'KLM', 'UAE', 'SIA', 'AFR'];
const T5 = ['JBU', 'EIN'];
const T7 = ['ASA', 'ACA', 'IBE', 'EIN', 'THY'];
const T8 = ['AAL', 'BAW', 'IBE', 'QTR', 'JAL', 'QFA'];
const T1 = ['AFR', 'DLH', 'KAL', 'THY', 'JAL', 'SIA', 'KLM', 'UAE'];
row('4', (i) => `B${20 + i}`, 16, -720, 600, 0, -80, wide, T4); // T4 concourse B (west side)
row('4', (i) => `A${2 + i}`, 6, -600, 720, 80, 0, wide, T4); // T4 concourse A
row('5', num(501), 30, -20, 765, 40, 0, () => 'M', T5); // T5 (JetBlue)
row('7', num(701), 6, 1280, 720, 80, 0, () => 'L', T7);
row('7', num(707), 4, 1770, 600, 0, -80, wide, T7);
row('8', num(801), 11, 1770, 200, 0, -80, wide, T8);
row('8', num(812), 11, 1640, -720, -80, 0, wide, T8);
row('1', num(101), 15, 580, -720, -80, 0, wide, T1);

const terminals: { name: string; poly: P[] }[] = [
  { name: 'Terminal 4', poly: WP([[-675, -640], [-635, -640], [-635, 635], [-160, 635], [-160, 675], [-675, 675]]) },
  { name: 'Terminal 5', poly: WP([[-50, 650], [1170, 650], [1170, 737], [-50, 737]]) },
  { name: 'Terminal 7', poly: WP([[1240, 635], [1685, 635], [1685, 320], [1725, 320], [1725, 675], [1240, 675]]) },
  { name: 'Terminal 8', poly: WP([[1685, 240], [1725, 240], [1725, -675], [800, -675], [800, -635], [1685, -635]]) },
  { name: 'Terminal 1', poly: WP([[-580, -675], [620, -675], [620, -635], [-580, -635]]) },
];

const NA_HUB = ['LAX', 'SFO', 'SEA', 'BOS', 'MCO', 'MIA', 'FLL', 'TPA', 'ATL', 'DTW', 'MSP', 'SLC', 'LAS', 'PHX', 'SAN', 'AUS', 'DFW', 'ORD', 'DCA', 'RDU', 'CLT', 'BNA', 'MSY', 'SJU', 'CUN'];
const SHORT = ['BOS', 'DCA', 'RDU', 'PIT', 'CLE', 'CMH', 'BUF', 'SYR', 'ROC', 'PWM', 'BTV', 'ORF', 'RIC', 'IND', 'YYZ', 'YUL'];

export const JFK: AirportDef = {
  id: 'JFK', icao: 'KJFK', iata: 'JFK',
  name: 'John F. Kennedy International', city: 'New York', facility: 'Kennedy',
  elevation: 13, fictional: false,
  dataNote:
    'Runway designators, count, lengths and the perpendicular two-pair arrangement around a central terminal area follow the real airport ' +
    '(the real 4L/22R–13R/31L intersection is not modelled). Threshold positions, the taxiway network and letters (apart from the A/B ring idea), ' +
    'terminal placement and gate positions/numbers are simplified approximations – not surveyed data.',
  runways: [
    { a: { name: '04L', x: W(X4L, -2500)[0], y: W(X4L, -2500)[1] }, b: { name: '22R', x: W(X4L, 1182)[0], y: W(X4L, 1182)[1] }, width: 60 },
    { a: { name: '04R', x: W(X4R, -1378)[0], y: W(X4R, -1378)[1] }, b: { name: '22L', x: W(X4R, 1182)[0], y: W(X4R, 1182)[1] }, width: 60 },
    { a: { name: '13L', x: W(-1300, Y13L)[0], y: W(-1300, Y13L)[1] }, b: { name: '31R', x: W(1748, Y13L)[0], y: W(1748, Y13L)[1] }, width: 60 },
    { a: { name: '13R', x: W(-2723, Y13R)[0], y: W(-2723, Y13R)[1] }, b: { name: '31L', x: W(1700, Y13R)[0], y: W(1700, Y13R)[1] }, width: 60 },
  ],
  taxiways: T,
  terminals,
  aprons: [
    WP([[-900, 680], [1950, 680], [1950, 900], [-900, 900]]),
    WP([[-900, -900], [1950, -900], [1950, -680], [-900, -680]]),
    WP([[-900, -680], [-680, -680], [-680, 680], [-900, 680]]),
    WP([[1730, -680], [1950, -680], [1950, 680], [1730, 680]]),
  ],
  gates,
  // fix names borrowed from real New York-area procedures, but their positions here are purely schematic
  fixNames: { arr: ['ROBER', 'PARCH', 'CAMRN', 'LENDY'], dep: ['GREKI', 'BETTE', 'WAVEY', 'COATE'] },
  configs: [
    { name: '31s (land 31R, depart 31L)', arr: ['31R'], dep: ['31L'] },
    { name: '22s / 13L (land 22L + 22R, depart 22R + 13L)', arr: ['22L', '22R'], dep: ['22R', '13L'] },
    { name: '4s (land 4R, depart 4L + 31L)', arr: ['04R'], dep: ['04L', '31L'] },
    { name: '13s (land 13L, depart 13R)', arr: ['13L'], dep: ['13R'] },
  ],
  mix: [
    { airline: 'JBU', weight: 24, types: ['A320', 'A321', 'A321', 'BCS3', 'E190'], routes: [...NA_HUB, ...SHORT, 'NAS', 'MBJ'] },
    { airline: 'JBU', weight: 2, types: ['A321'], routes: ['LHR', 'CDG', 'AMS', 'DUB', 'EDI'] },
    { airline: 'DAL', weight: 16, types: ['A321', 'B738', 'A320', 'BCS3', 'B752', 'A319'], routes: NA_HUB },
    { airline: 'DAL', weight: 8, types: ['A333', 'A359', 'B763', 'B763'], routes: ['LHR', 'CDG', 'AMS', 'FRA', 'FCO', 'MAD', 'BCN', 'DUB', 'ATH', 'LIS', 'ZRH', 'TLV', 'GRU', 'EZE', 'ICN', 'HND', 'LOS', 'LAX', 'SFO'] },
    { airline: 'AAL', weight: 10, types: ['A321', 'B738', 'A321', 'A319'], routes: ['LAX', 'SFO', 'MIA', 'DFW', 'ORD', 'CLT', 'PHX', 'DCA', 'BOS', 'AUS', 'SJU', 'CUN'] },
    { airline: 'AAL', weight: 5, types: ['B772', 'B77W', 'B789', 'B788'], routes: ['LHR', 'CDG', 'MAD', 'FCO', 'BCN', 'GRU', 'EZE', 'HND', 'DOH', 'DEL'] },
    { airline: 'ASA', weight: 2, types: ['B738', 'B38M'], routes: ['SEA', 'SFO', 'PDX', 'SAN', 'LAX'] },
    { airline: 'ACA', weight: 1.5, types: ['A320', 'BCS3', 'E190'], routes: ['YYZ', 'YUL', 'YVR'] },
    { airline: 'BAW', weight: 4, types: ['B772', 'B77W', 'B789', 'A388'], routes: ['LHR'] },
    { airline: 'VIR', weight: 3, types: ['A359', 'B789', 'A333'], routes: ['LHR', 'MAN', 'EDI'] },
    { airline: 'AFR', weight: 2.5, types: ['B77W', 'A359', 'B772'], routes: ['CDG'] },
    { airline: 'DLH', weight: 2, types: ['B748', 'A359', 'A333'], routes: ['FRA', 'MUC'] },
    { airline: 'KLM', weight: 1.5, types: ['B772', 'B789', 'B78X'], routes: ['AMS'] },
    { airline: 'UAE', weight: 2, types: ['A388', 'B77W'], routes: ['DXB'] },
    { airline: 'QTR', weight: 1.5, types: ['B77W', 'A359'], routes: ['DOH'] },
    { airline: 'THY', weight: 1.5, types: ['B77W', 'A359', 'B789'], routes: ['IST'] },
    { airline: 'SIA', weight: 1, types: ['A359', 'A388'], routes: ['SIN', 'FRA'] },
    { airline: 'KAL', weight: 1.2, types: ['B77W', 'A388', 'B789'], routes: ['ICN'] },
    { airline: 'JAL', weight: 1, types: ['B77W', 'B789'], routes: ['HND', 'NRT'] },
    { airline: 'EIN', weight: 1.5, types: ['A333', 'A321'], routes: ['DUB', 'MAN'] },
    { airline: 'IBE', weight: 1.2, types: ['A333', 'A359'], routes: ['MAD', 'BCN'] },
    { airline: 'QFA', weight: 0.4, types: ['B789'], routes: ['SYD', 'AKL', 'LAX'] },
  ],
  baseRate: 60,
  towerPos: W(300, 150),
};
