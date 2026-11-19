/**
 * KLGA – New York LaGuardia.
 *
 * DATA PROVENANCE (be honest about this):
 *  - Runway designators, count and lengths follow the real airport: two ~2135 m runways, 4/22 and
 *    13/31, at right angles and intersecting toward the north-east of the field, with the
 *    terminals in the angle south-west of the intersection. Threshold and intersection positions
 *    are approximations entered from general knowledge, not surveyed data.
 *  - Taxiways A (inner) and B (outer) paralleling both runways on the terminal side exist in
 *    reality, but connector positions and letters, the ladder of pier alleys, terminal shapes,
 *    gate positions and gate numbers are a SIMPLIFIED APPROXIMATION for playability. Not
 *    surveyed data; must not be used for navigation.
 *
 * Authored in a "frame" where 13→31 runs along +x and 04→22 along +y, then rotated clockwise by
 * 43° so that the geometric bearings match the designators.
 */
import type { AirportDef, GateDef, TaxiwayDef } from '../build';
import type { SizeClass } from '../../types';

type P = [number, number];
const TH = (43 * Math.PI) / 180, CS = Math.cos(TH), SN = Math.sin(TH);
const OX = 200, OY = 150; // frame point that becomes the world origin
const r2 = (v: number) => Math.round(v * 100) / 100;
/** frame → world (x east, y north) */
const W = (x: number, y: number): P => [r2((x - OX) * CS + (y - OY) * SN), r2(-(x - OX) * SN + (y - OY) * CS)];
const WP = (pts: P[]) => pts.map(([x, y]) => W(x, y));

const T: TaxiwayDef[] = [];
const tw = (name: string, pts: P[], kind: 'taxiway' | 'apron' = 'taxiway') => T.push({ name, pts: WP(pts), kind });
/** 30° high-speed exits (dir = roll direction) off the x-aligned 13/31 and the y-aligned 04/22 */
const hsX = (name: string, x: number, dir: 1 | -1) => tw(name, [[x, R13], [x + dir * 180 * 1.73, BO]]);
const hsY = (name: string, y: number, dir: 1 | -1) => tw(name, [[R04, y], [BO, y + dir * 180 * 1.73]]);

const R13 = 600; // frame y of the 13/31 centreline
const R04 = 600; // frame x of the 04/22 centreline
const BO = 420, AO = 320, LO = 240; // taxiway B, taxiway A and the ramp-edge taxilane (same offset on both legs)

// ── B (outer) runs the full length of both runways, crossing each one to reach the far thresholds ──
tw('B', [[-820, BO], [1285, BO]]);
tw('B', [[BO, -885], [BO, 1220]]);
// ── A (inner) ──
tw('A', [[-820, AO], [AO, AO], [AO, -885]]);
// ── 13/31 connectors ──
tw('AA', [[-820, AO], [-820, R13]]);
tw('C', [[-420, AO], [-420, R13]]);
tw('D', [[-20, AO], [-20, R13]]);
tw('P', [[900, BO], [900, R13]]);
tw('Z', [[1285, BO], [1285, R13]]);
hsX('E', -70, -1);
hsX('F', 40, 1);
hsX('R', 650, 1);
// ── 04/22 connectors ──
tw('BB', [[AO, -885], [R04, -885]]);
tw('M', [[LO, -620], [R04, -620]]);
tw('N', [[LO, -260], [BO, -260]]);
tw('G', [[LO, 0], [R04, 0]]);
tw('T', [[BO, 900], [R04, 900]]);
tw('CC', [[BO, 1220], [R04, 1220]]);
hsY('J', -150, -1);
hsY('H', 50, 1);
hsY('U', 700, 1);
// ── ramp links (taxilane → A → B) ──
tw('K', [[-660, LO], [-660, BO]]);
tw('L', [[-300, LO], [-300, BO]]);
tw('Q', [[60, LO], [60, BO]]);

// ── taxilanes: a ladder of alleys between pier fingers ──
tw('LT', [[-660, LO], [LO, LO]], 'apron'); // ramp edge along A (13/31 side)
tw('LR', [[LO, LO], [LO, -620]], 'apron'); // ramp edge along A (04/22 side)
tw('LB', [[-660, -260], [LO, -260]], 'apron');
tw('R1', [[-660, LO], [-660, -260]], 'apron');
tw('R2', [[-480, LO], [-480, -260]], 'apron');
tw('R3', [[-300, LO], [-300, -620]], 'apron');
tw('R4', [[-120, LO], [-120, -260]], 'apron');
tw('R5', [[-300, -440], [LO, -440]], 'apron');
tw('R6', [[-300, -620], [LO, -620]], 'apron');

// ── gates ──
const gates: GateDef[] = [];
const terminals: { name: string; poly: P[] }[] = [];
const add = (name: string, terminal: string, x: number, y: number, size: SizeClass, airlines: string[]) => {
  const [wx, wy] = W(x, y);
  gates.push({ name, terminal, x: wx, y: wy, size, airlines });
};
// Terminal A (Marine Air Terminal): five small stands on the west alley
for (let i = 0; i < 5; i++) add(`A${i + 1}`, 'A', -605, 80 - i * 40, i < 2 ? 'M' : 'S', ['JBU', 'NKS', 'FFT']);
terminals.push({ name: 'Terminal A', poly: WP([[-585, -115], [-540, -115], [-540, 115], [-585, 115]]) });
// Terminal B: two north–south fingers, eight stands a side
const TB = ['AAL', 'UAL', 'SWA', 'JBU', 'ACA', 'RPA'];
let k = 1;
for (const c of [-390, -210]) {
  for (let i = 0; i < 8; i++) {
    const y = 140 - i * 40;
    add(`B${k++}`, 'B', c - 35, y, i % 4 === 3 ? 'S' : 'M', TB);
    add(`B${k++}`, 'B', c + 35, y, i % 4 === 3 ? 'S' : 'M', TB);
  }
  terminals.push({ name: `Terminal B (${c < -300 ? 'west' : 'east'} concourse)`, poly: WP([[c - 11, -170], [c + 11, -170], [c + 11, 170], [c - 11, 170]]) });
}
terminals.push({ name: 'Terminal B', poly: WP([[-60, -180], [150, -180], [150, 150], [-60, 150]]) });
// Terminal C: two east–west fingers, eight stands a side
const TC = ['DAL', 'EDV'];
k = 61;
for (const c of [-350, -530]) {
  for (let i = 0; i < 8; i++) {
    const x = 120 - i * 40;
    add(`C${k++}`, 'C', x, c + 35, i % 3 === 2 ? 'S' : 'M', TC);
    add(`C${k++}`, 'C', x, c - 35, i % 3 === 2 ? 'S' : 'M', TC);
  }
  terminals.push({ name: `Terminal C (${c > -400 ? 'north' : 'south'} concourse)`, poly: WP([[-190, c - 11], [150, c - 11], [150, c + 11], [-190, c + 11]]) });
}

const EAST = ['ORD', 'ATL', 'DFW', 'MIA', 'CLT', 'BOS', 'DCA', 'DTW', 'MSP', 'MCO', 'FLL', 'TPA', 'RDU', 'BNA', 'MSY', 'IAH', 'DEN', 'STL', 'MDW', 'DAL', 'HOU'];
const SHUTTLE = ['BOS', 'DCA', 'ORD', 'PIT', 'CLE', 'CMH', 'IND', 'BUF', 'SYR', 'ROC', 'PWM', 'BTV', 'ORF', 'RIC', 'RDU', 'CHS', 'SAV', 'JAX', 'GSP', 'TYS', 'BHM', 'MEM', 'SDF'];

export const LGA: AirportDef = {
  id: 'LGA', icao: 'KLGA', iata: 'LGA',
  name: 'LaGuardia', city: 'New York', facility: 'LaGuardia',
  elevation: 21, fictional: false,
  dataNote:
    'Runway designators, count, lengths and the intersecting 4/22 – 13/31 arrangement follow the real airport. ' +
    'Threshold and intersection positions, the taxiway network and letters (apart from the A/B parallels idea), ' +
    'terminal shapes and gate positions/numbers are simplified approximations – not surveyed data.',
  runways: [
    { a: { name: '04', x: W(R04, -900)[0], y: W(R04, -900)[1] }, b: { name: '22', x: W(R04, 1235)[0], y: W(R04, 1235)[1] } },
    { a: { name: '13', x: W(-835, R13)[0], y: W(-835, R13)[1] }, b: { name: '31', x: W(1300, R13)[0], y: W(1300, R13)[1] } },
  ],
  taxiways: T,
  terminals,
  aprons: [
    WP([[-700, -290], [270, -290], [270, 270], [-700, 270]]),
    WP([[-330, -650], [270, -650], [270, -290], [-330, -290]]),
  ],
  gates,
  // fix names borrowed from real New York-area procedures, but their positions here are purely schematic
  fixNames: { arr: ['NOBBI', 'HOFFI', 'PROUD', 'HAARP'], dep: ['NEION', 'MERIT', 'DIXIE', 'ELIOT'] },
  configs: [
    { name: 'Land 22 / Depart 13', arr: ['22'], dep: ['13'] },
    { name: 'Land 31 / Depart 4', arr: ['31'], dep: ['04'] },
    { name: 'Land 4 / Depart 13', arr: ['04'], dep: ['13'] },
    { name: 'Land 22 / Depart 31', arr: ['22'], dep: ['31'] },
  ],
  mix: [
    { airline: 'DAL', weight: 22, types: ['A320', 'A321', 'B738', 'BCS3', 'A319', 'B737'], routes: EAST },
    { airline: 'EDV', weight: 14, types: ['CRJ9', 'CRJ9', 'CRJ7', 'E75L'], routes: SHUTTLE },
    { airline: 'AAL', weight: 15, types: ['B738', 'A321', 'A319', 'A320'], routes: ['ORD', 'DFW', 'MIA', 'CLT', 'DCA', 'BOS', 'PHL', 'BNA', 'RDU', 'ATL'] },
    { airline: 'RPA', weight: 14, types: ['E75L', 'E170', 'E75L'], routes: SHUTTLE },
    { airline: 'UAL', weight: 8, types: ['B738', 'A320', 'A319', 'B38M'], routes: ['ORD', 'DEN', 'IAH', 'IAD'] },
    { airline: 'SWA', weight: 8, types: ['B737', 'B738', 'B38M'], routes: ['MDW', 'BNA', 'DAL', 'HOU', 'STL', 'MCI', 'ATL', 'DEN', 'TPA', 'MSY'] },
    { airline: 'JBU', weight: 7, types: ['A320', 'BCS3', 'E190'], routes: ['BOS', 'MCO', 'FLL', 'TPA', 'JAX', 'CHS', 'SAV', 'ORD', 'ATL'] },
    { airline: 'NKS', weight: 5, types: ['A320', 'A319', 'A321'], routes: ['FLL', 'MCO', 'DTW', 'ORD', 'DFW', 'ATL', 'IAH'] },
    { airline: 'FFT', weight: 3, types: ['A320', 'A321'], routes: ['DEN', 'MCO', 'ATL', 'MIA', 'DFW'] },
    { airline: 'ACA', weight: 3, types: ['BCS3', 'E190', 'A319'], routes: ['YYZ', 'YUL'] },
  ],
  baseRate: 55,
  towerPos: W(100, 195),
};
