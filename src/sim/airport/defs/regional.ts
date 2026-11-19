/** Fictional single-runway regional airport (clearly labelled as fictional). */
import { customAirportDef } from '../custom';
import type { AirportDef } from '../build';

export const REGIONAL: AirportDef = customAirportDef(
  {
    name: 'Cedar Valley Regional',
    runways: [{ length: 2150, hdg: 70, offset: 0, along: 0 }],
    layout: 'parallel', terminals: 1, gatesPerTerminal: 8, taxiComplexity: 0.3, size: 0.8,
    categories: ['S', 'M'], airlines: ['EDV', 'SKW', 'RPA', 'SWA', 'DAL', 'GA'],
  },
  {
    id: 'REG', icao: 'KCVR', iata: 'CVR', name: 'Cedar Valley Regional (fictional)', city: 'Cedar Valley', facility: 'Cedar Valley',
    dataNote: 'Fictional single-runway regional airport. The layout is procedurally generated and does not represent any real aerodrome.',
    baseRate: 22, airspaceRadiusNm: 24,
    fixNames: { arr: ['CEDNE', 'CEDSE', 'CEDSW', 'CEDNW'], dep: ['VALLN', 'VALLE', 'VALLS', 'VALLW'] },
  },
);
