import type { AircraftType } from '../types';

/**
 * Aircraft performance database.
 *
 * Values are documented approximations assembled from publicly known typical figures
 * (manufacturer airport-planning documents, typical Vref/Vr at mid weights). They are tuned
 * for plausible relative behaviour in a terminal-area simulation, NOT for flight planning.
 */
type Row = [
  id: string, name: string, family: AircraftType['family'], wake: AircraftType['wake'], size: AircraftType['size'],
  length: number, span: number, engines: number, vr: number, vref: number, vClean: number,
  climb: number, descent: number, accel: number, toDist: number, ldgDist: number, xwind: number,
  burn: number, seats: number,
];

const rows: Row[] = [
  // Airbus
  ['BCS3', 'Airbus A220-300', 'Airbus', 'M', 'M', 38.7, 35.1, 2, 135, 128, 200, 2900, 2000, 2.0, 1890, 1500, 33, 38, 130],
  ['A319', 'Airbus A319', 'Airbus', 'M', 'M', 33.8, 35.8, 2, 135, 126, 200, 2800, 2000, 2.0, 1850, 1450, 33, 40, 128],
  ['A320', 'Airbus A320', 'Airbus', 'M', 'M', 37.6, 35.8, 2, 142, 133, 205, 2600, 2000, 1.9, 2100, 1500, 33, 42, 150],
  ['A321', 'Airbus A321', 'Airbus', 'M', 'M', 44.5, 35.8, 2, 150, 140, 210, 2400, 2000, 1.8, 2350, 1650, 33, 48, 190],
  ['A333', 'Airbus A330-300', 'Airbus', 'H', 'L', 63.7, 60.3, 2, 150, 137, 220, 2200, 1900, 1.6, 2770, 1750, 32, 95, 290],
  ['A359', 'Airbus A350-900', 'Airbus', 'H', 'L', 66.8, 64.8, 2, 152, 140, 220, 2400, 1900, 1.7, 2600, 1800, 35, 98, 310],
  ['A388', 'Airbus A380-800', 'Airbus', 'J', 'XL', 72.7, 79.8, 4, 155, 138, 225, 1900, 1800, 1.4, 2950, 2100, 35, 200, 500],
  // Boeing
  ['B737', 'Boeing 737-700', 'Boeing', 'M', 'M', 33.6, 35.8, 2, 138, 130, 205, 2800, 2000, 2.0, 1850, 1450, 33, 40, 137],
  ['B738', 'Boeing 737-800', 'Boeing', 'M', 'M', 39.5, 35.8, 2, 148, 141, 210, 2500, 2000, 1.9, 2300, 1650, 33, 44, 172],
  ['B38M', 'Boeing 737 MAX 8', 'Boeing', 'M', 'M', 39.5, 35.9, 2, 148, 141, 210, 2600, 2000, 1.9, 2300, 1650, 33, 40, 172],
  ['B752', 'Boeing 757-200', 'Boeing', 'H', 'L', 47.3, 38.1, 2, 145, 132, 210, 3200, 2100, 2.1, 2000, 1500, 30, 60, 199],
  ['B763', 'Boeing 767-300ER', 'Boeing', 'H', 'L', 54.9, 47.6, 2, 150, 138, 215, 2500, 2000, 1.8, 2600, 1700, 33, 80, 216],
  ['B772', 'Boeing 777-200ER', 'Boeing', 'H', 'L', 63.7, 60.9, 2, 155, 140, 220, 2200, 1900, 1.6, 2900, 1800, 38, 115, 288],
  ['B77W', 'Boeing 777-300ER', 'Boeing', 'H', 'XL', 73.9, 64.8, 2, 160, 149, 225, 2000, 1900, 1.5, 3100, 1950, 38, 130, 350],
  ['B788', 'Boeing 787-8', 'Boeing', 'H', 'L', 56.7, 60.1, 2, 150, 138, 215, 2500, 1900, 1.7, 2600, 1650, 33, 85, 242],
  ['B789', 'Boeing 787-9', 'Boeing', 'H', 'L', 62.8, 60.1, 2, 155, 143, 220, 2400, 1900, 1.7, 2800, 1750, 33, 90, 290],
  ['B78X', 'Boeing 787-10', 'Boeing', 'H', 'L', 68.3, 60.1, 2, 158, 146, 220, 2200, 1900, 1.6, 2900, 1850, 33, 95, 318],
  ['B748', 'Boeing 747-8F', 'Boeing', 'H', 'XL', 76.3, 68.4, 4, 160, 150, 225, 1900, 1800, 1.4, 3100, 2000, 36, 190, 0],
  // Regional
  ['E170', 'Embraer E170', 'Embraer', 'M', 'S', 29.9, 26.0, 2, 128, 122, 190, 2800, 2100, 2.1, 1650, 1250, 30, 28, 70],
  ['E75L', 'Embraer E175', 'Embraer', 'M', 'S', 31.7, 28.7, 2, 130, 124, 190, 2700, 2100, 2.1, 1730, 1300, 30, 29, 76],
  ['E190', 'Embraer E190', 'Embraer', 'M', 'M', 36.2, 28.7, 2, 135, 128, 195, 2700, 2100, 2.0, 2050, 1350, 30, 34, 100],
  ['CRJ7', 'Bombardier CRJ700', 'Bombardier', 'M', 'S', 32.3, 23.2, 2, 132, 128, 195, 2800, 2200, 2.1, 1700, 1500, 28, 25, 69],
  ['CRJ9', 'Bombardier CRJ900', 'Bombardier', 'M', 'S', 36.2, 24.9, 2, 138, 132, 195, 2700, 2200, 2.0, 1900, 1600, 28, 28, 76],
  ['AT76', 'ATR 72-600', 'ATR', 'M', 'S', 27.2, 27.1, 2, 112, 108, 160, 1500, 1500, 1.7, 1350, 1070, 30, 12, 70],
  // General aviation (regional airport only)
  ['C208', 'Cessna 208 Caravan', 'GA', 'L', 'S', 11.5, 15.9, 1, 75, 78, 120, 1000, 1000, 1.6, 650, 500, 20, 3, 9],
  ['C56X', 'Cessna Citation Excel', 'GA', 'M', 'S', 16.0, 17.2, 2, 110, 108, 170, 3000, 2500, 2.3, 1100, 950, 25, 9, 8],
  ['PC12', 'Pilatus PC-12', 'GA', 'L', 'S', 14.4, 16.3, 1, 82, 85, 130, 1500, 1500, 1.8, 800, 670, 25, 4, 8],
];

export const AIRCRAFT_TYPES: Record<string, AircraftType> = {};
for (const r of rows) {
  const tp = r[2] === 'ATR' || r[0] === 'C208' || r[0] === 'PC12';
  AIRCRAFT_TYPES[r[0]] = {
    id: r[0], name: r[1], family: r[2], wake: r[3], size: r[4], length: r[5], span: r[6], engines: r[7],
    turboprop: tp, vr: r[8], vref: r[9], vClean: r[10], climbFpm: r[11], descentFpm: r[12],
    cruiseKt: tp ? (r[0] === 'AT76' ? 230 : 190) : 250,
    accelGround: r[13], takeoffDist: r[14], landingDist: r[15], maxXwind: r[16],
    taxiKt: r[4] === 'XL' ? 17 : r[4] === 'L' ? 19 : 21,
    fuelBurnKgMin: r[17], seats: r[18],
  };
}

export const typeOf = (id: string): AircraftType => AIRCRAFT_TYPES[id] ?? AIRCRAFT_TYPES.A320;

const SIZE_ORDER = { S: 0, M: 1, L: 2, XL: 3 } as const;
/** true when an aircraft of size `ac` fits a stand rated for `gate` */
export const sizeFits = (ac: AircraftType['size'], gate: AircraftType['size']) => SIZE_ORDER[ac] <= SIZE_ORDER[gate];
