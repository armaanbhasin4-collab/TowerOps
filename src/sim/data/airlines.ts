import type { Airline } from '../types';

/** Real airline identities (ICAO code, telephony callsign) with simplified livery colours. */
const rows: [string, string, string, string, string, string, string, boolean?][] = [
  ['DAL', 'DL', 'Delta Air Lines', 'Delta', '#f4f6f8', '#c8102e', '#003366'],
  ['AAL', 'AA', 'American Airlines', 'American', '#d9dde2', '#0078d2', '#c30019'],
  ['UAL', 'UA', 'United Airlines', 'United', '#f2f4f7', '#0b3a8f', '#6cace4'],
  ['SWA', 'WN', 'Southwest Airlines', 'Southwest', '#304cb2', '#ffbf27', '#e31837'],
  ['JBU', 'B6', 'JetBlue', 'JetBlue', '#f5f7fa', '#003876', '#2f9bd8'],
  ['ASA', 'AS', 'Alaska Airlines', 'Alaska', '#f3f5f7', '#01426a', '#64ccc9'],
  ['NKS', 'NK', 'Spirit Airlines', 'Spirit Wings', '#ffec00', '#ffec00', '#111111'],
  ['FFT', 'F9', 'Frontier Airlines', 'Frontier Flight', '#f5f7f5', '#248168', '#c7d0d4'],
  ['BAW', 'BA', 'British Airways', 'Speedbird', '#f5f6f8', '#0b2a63', '#c8102e'],
  ['DLH', 'LH', 'Lufthansa', 'Lufthansa', '#f6f6f6', '#05164d', '#ffad00'],
  ['AFR', 'AF', 'Air France', 'Air France', '#f7f7f9', '#002157', '#ed1c24'],
  ['KLM', 'KL', 'KLM', 'KLM', '#00a1de', '#00a1de', '#ffffff'],
  ['UAE', 'EK', 'Emirates', 'Emirates', '#f5f3ee', '#d71921', '#b8975a'],
  ['QTR', 'QR', 'Qatar Airways', 'Qatari', '#eceef0', '#5c0632', '#9aa0a6'],
  ['THY', 'TK', 'Turkish Airlines', 'Turkish', '#f6f6f6', '#c8102e', '#ffffff'],
  ['SIA', 'SQ', 'Singapore Airlines', 'Singapore', '#f6f4ee', '#1d3a70', '#f2a900'],
  ['UPS', '5X', 'UPS Airlines', 'UPS', '#f1ece2', '#4b2e1e', '#ffb500', true],
  ['FDX', 'FX', 'FedEx Express', 'FedEx', '#f4f4f6', '#4d148c', '#ff6600', true],
  // connection / regional carriers and extras used for realistic mixes
  ['EDV', '9E', 'Endeavor Air (Delta Connection)', 'Endeavor', '#f4f6f8', '#c8102e', '#003366'],
  ['RPA', 'YX', 'Republic Airways', 'Brickyard', '#e6e9ee', '#0b3a8f', '#c30019'],
  ['SKW', 'OO', 'SkyWest Airlines', 'SkyWest', '#eef1f5', '#1b365d', '#6cace4'],
  ['ACA', 'AC', 'Air Canada', 'Air Canada', '#f4f4f4', '#111111', '#d22630'],
  ['VIR', 'VS', 'Virgin Atlantic', 'Virgin', '#f6f6f8', '#da0530', '#5f2167'],
  ['KAL', 'KE', 'Korean Air', 'Korean Air', '#9fd3e6', '#9fd3e6', '#c8102e'],
  ['JAL', 'JL', 'Japan Airlines', 'Japan Air', '#f7f7f7', '#c8102e', '#111111'],
  ['QFA', 'QF', 'Qantas', 'Qantas', '#f6f6f6', '#e0001b', '#ffffff'],
  ['EIN', 'EI', 'Aer Lingus', 'Shamrock', '#f3f6f4', '#006272', '#8dc63f'],
  ['IBE', 'IB', 'Iberia', 'Iberia', '#f6f6f6', '#d7192d', '#fcd100'],
  ['GA', '', 'General Aviation', 'November', '#e8e8e8', '#4b6584', '#c0392b'],
];

export const AIRLINES: Record<string, Airline> = {};
for (const r of rows) {
  AIRLINES[r[0]] = { icao: r[0], iata: r[1], name: r[2], callsign: r[3], color: r[4], tail: r[5], accent: r[6], cargo: r[7] };
}
export const airlineOf = (icao: string): Airline => AIRLINES[icao] ?? AIRLINES.GA;

/** City names for route codes shown on boards. */
export const CITY: Record<string, string> = {
  ATL: 'Atlanta', JFK: 'New York JFK', LGA: 'New York LGA', EWR: 'Newark', LAX: 'Los Angeles', LHR: 'London',
  ORD: 'Chicago', DFW: 'Dallas/Ft Worth', DEN: 'Denver', SFO: 'San Francisco', SEA: 'Seattle', MIA: 'Miami',
  MCO: 'Orlando', BOS: 'Boston', DCA: 'Washington', IAD: 'Washington Dulles', CLT: 'Charlotte', PHX: 'Phoenix',
  IAH: 'Houston', LAS: 'Las Vegas', MSP: 'Minneapolis', DTW: 'Detroit', PHL: 'Philadelphia', SLC: 'Salt Lake City',
  BNA: 'Nashville', TPA: 'Tampa', FLL: 'Ft Lauderdale', RDU: 'Raleigh', MSY: 'New Orleans', AUS: 'Austin',
  SAN: 'San Diego', PDX: 'Portland', HNL: 'Honolulu', ANC: 'Anchorage', MEM: 'Memphis', SDF: 'Louisville',
  SAV: 'Savannah', CHS: 'Charleston', JAX: 'Jacksonville', BHM: 'Birmingham', GSP: 'Greenville', TYS: 'Knoxville',
  CHA: 'Chattanooga', AGS: 'Augusta', MGM: 'Montgomery', PNS: 'Pensacola', RIC: 'Richmond', PIT: 'Pittsburgh',
  CLE: 'Cleveland', CMH: 'Columbus', IND: 'Indianapolis', STL: 'St Louis', MCI: 'Kansas City', BWI: 'Baltimore',
  MDW: 'Chicago Midway', DAL: 'Dallas Love', HOU: 'Houston Hobby', OAK: 'Oakland', SJC: 'San Jose', SMF: 'Sacramento',
  BUF: 'Buffalo', SYR: 'Syracuse', ROC: 'Rochester', PWM: 'Portland ME', BTV: 'Burlington', ORF: 'Norfolk',
  CDG: 'Paris', AMS: 'Amsterdam', FRA: 'Frankfurt', MUC: 'Munich', MAD: 'Madrid', FCO: 'Rome', DUB: 'Dublin',
  IST: 'Istanbul', DXB: 'Dubai', DOH: 'Doha', SIN: 'Singapore', NRT: 'Tokyo Narita', HND: 'Tokyo Haneda',
  ICN: 'Seoul', HKG: 'Hong Kong', SYD: 'Sydney', GRU: 'São Paulo', MEX: 'Mexico City', CUN: 'Cancún',
  YYZ: 'Toronto', YVR: 'Vancouver', YUL: 'Montréal', JNB: 'Johannesburg', LOS: 'Lagos', CPT: 'Cape Town',
  EDI: 'Edinburgh', MAN: 'Manchester', GLA: 'Glasgow', BCN: 'Barcelona', ZRH: 'Zürich', GVA: 'Geneva',
  CPH: 'Copenhagen', ARN: 'Stockholm', OSL: 'Oslo', VIE: 'Vienna', ATH: 'Athens', LIS: 'Lisbon', DEL: 'Delhi',
  BOM: 'Mumbai', BKK: 'Bangkok', KUL: 'Kuala Lumpur', PVG: 'Shanghai', PEK: 'Beijing', AKL: 'Auckland',
  BOG: 'Bogotá', LIM: 'Lima', SCL: 'Santiago', EZE: 'Buenos Aires', SJU: 'San Juan', NAS: 'Nassau', MBJ: 'Montego Bay',
  CGN: 'Cologne', ONT: 'Ontario CA', OGG: 'Maui', TLV: 'Tel Aviv', CAI: 'Cairo', NBO: 'Nairobi', BLQ: 'Bologna',
};
export const cityOf = (code: string) => CITY[code] ?? code;
