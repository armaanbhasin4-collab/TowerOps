import type { Airport, ScenarioConfig } from '../types';
import { buildAirport, type AirportDef } from './build';
import { ATL } from './defs/atl';
import { JFK } from './defs/jfk';
import { LAX } from './defs/lax';
import { EGLL } from './defs/egll';
import { LGA } from './defs/lga';
import { REGIONAL } from './defs/regional';
import { customAirportDef } from './custom';

export const AIRPORT_DEFS: AirportDef[] = [ATL, JFK, LAX, EGLL, LGA, REGIONAL];

const cache = new Map<string, Airport>();
export function getAirport(cfg: Pick<ScenarioConfig, 'airportId' | 'custom'>): Airport {
  const key = cfg.airportId === 'CUSTOM' ? 'CUSTOM:' + JSON.stringify(cfg.custom) : cfg.airportId;
  let ap = cache.get(key);
  if (!ap) {
    const def = cfg.airportId === 'CUSTOM' && cfg.custom ? customAirportDef(cfg.custom) : AIRPORT_DEFS.find((d) => d.id === cfg.airportId) ?? ATL;
    ap = buildAirport(def);
    cache.set(key, ap);
  }
  return ap;
}
