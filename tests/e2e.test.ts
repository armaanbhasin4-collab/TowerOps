import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import { spawnArrival, spawnParked } from '../src/sim/traffic';
import { NM } from '../src/sim/util';
import { autoControl, distNm, ok, quietConfig, until } from './helpers';
import { runwayZoneAt } from '../src/sim/airport/query';

describe('end-to-end: Delta A321 departure from B18 + United 737 arrival at Atlanta', () => {
  const sim = new Sim(quietConfig('ATL', { configName: 'West flow' }));
  const dal = spawnParked(sim, 'B18', { airline: 'DAL', type: 'A321', callsign: 'DAL1426', dest: 'LGA', readyIn: 5 })!;
  const ual = spawnArrival(sim, { airline: 'UAL', type: 'B738', callsign: 'UAL892', fix: 'LOGEN', distNm: 21, alt: 8000 })!;
  // other traffic operating at the same time, controlled through the same command pipeline
  const others = [
    spawnParked(sim, 'A5', { airline: 'DAL', type: 'B738', readyIn: 40 })!,
    spawnParked(sim, 'D12', { airline: 'NKS', type: 'A320', readyIn: 90 })!,
    spawnArrival(sim, { airline: 'SWA', type: 'B737', fix: 'HONIE', distNm: 23, alt: 9000 })!,
    spawnArrival(sim, { airline: 'DAL', type: 'B752', fix: 'SINCA', distNm: 27, alt: 10000 })!,
  ];
  const drive = () => { if (Math.round(sim.s.t) % 3 === 0) for (const o of others) autoControl(sim, o); };
  const step = (cond: () => boolean, max: number, label: string) => until(sim, cond, max, label, () => { drive(); arrivalScript(); });

  // the United arrival is vectored by "the player" as the scenario unfolds
  let stage = 0;
  const base = sim.ap.fixes.find((f) => f.name === 'B26RN')!;
  const arrivalScript = () => {
    if (stage === 0 && ual.checkedIn) { ok(sim, 'UAL892 DESCEND 4000, DIRECT B26RN, SPEED 210'); stage = 1; }
    else if (stage === 1 && distNm(ual, base.x, base.y) < 1.8) { ok(sim, 'UAL892 HEADING 230, DESCEND 3000, CLEARED ILS 26R'); stage = 2; }
    else if (stage === 2 && ual.phase === 'final') {
      seen.landingRequest = ual.request?.type === 'landing';
      seen.clearedBefore = ual.landCleared;
      ok(sim, 'UAL892 CLEARED LAND 26R');
      stage = 3;
    }
  };
  const seen = { landingRequest: false, clearedBefore: true };

  it('aircraft share one authoritative state', () => {
    expect(sim.s.aircraft.length).toBe(6);
    expect(dal.gate).toBe('B18');
    expect(dal.type).toBe('A321');
  });

  it('1-2. departure clearance, then pushback only when authorised', () => {
    step(() => dal.request?.type === 'clearance', 30, 'clearance request');
    expect(dal.callsign).toBe('DAL1426');
    // pushback before clearance is rejected
    expect(sim.commandText('DAL1426 PUSHBACK APPROVED').ok).toBe(false);
    ok(sim, 'DAL1426 CLEARED AS FILED');
    expect(dal.depCleared).toBe(true);
    step(() => dal.request?.type === 'pushback', 60, 'pushback request');
    // withholding the pushback clearance keeps the aircraft on stand
    const x0 = dal.x, y0 = dal.y;
    step(() => false || sim.s.t > 150, 200, 'wait');
    expect(dal.phase).toBe('parked');
    expect(dal.x).toBe(x0); expect(dal.y).toBe(y0);
    ok(sim, 'DAL1426 PUSHBACK APPROVED');
    expect(dal.phase).toBe('pushback');
    step(() => dal.phase === 'push_done', 200, 'pushback complete');
    expect(dal.request?.type).toBe('taxi');
  });

  it('3-4. taxi route assignment; aircraft waits without it and follows it when given', () => {
    const x0 = dal.x;
    step(() => sim.s.t > 330, 200, 'wait');
    expect(dal.phase).toBe('push_done');
    expect(dal.x).toBe(x0);
    ok(sim, 'DAL1426 TAXI VIA R3 L M HOLD SHORT 27R');
    expect(dal.phase).toBe('taxi_out');
    expect(dal.rwy).toBe('27R');
    expect(dal.taxiNames.slice(0, 2)).toEqual(['R3', 'L']);
    expect(dal.taxiNames).toContain('M');
    step(() => dal.phase === 'holding_short', 900, 'holding short 27R');
    expect(dal.request?.type).toBe('takeoff');
    expect(runwayZoneAt(sim.ap, dal.x, dal.y)).toBeUndefined();
  });

  it('5-6. runway entry and takeoff need explicit clearances', () => {
    const t0 = sim.s.t;
    step(() => sim.s.t > t0 + 60, 100, 'wait');
    expect(dal.phase).toBe('holding_short');
    ok(sim, 'DAL1426 LINE UP WAIT 27R');
    step(() => dal.phase === 'lined_up', 120, 'lined up');
    expect(runwayZoneAt(sim.ap, dal.x, dal.y)?.id).toBe('09L/27R');
    const t1 = sim.s.t;
    step(() => sim.s.t > t1 + 40, 100, 'wait');
    expect(dal.phase).toBe('lined_up');
    expect(dal.gs).toBe(0);
    ok(sim, 'DAL1426 CLEARED TAKEOFF 27R');
    step(() => dal.phase === 'departure', 120, 'airborne');
    expect(sim.s.stats.departed).toBeGreaterThanOrEqual(1);
  });

  it('7-8. initial climb is managed and the departure is directed out of the airspace', () => {
    step(() => dal.alt > 1500, 120, 'climbing');
    expect(dal.tgtAlt).toBe(5000);
    ok(sim, `DAL1426 CLIMB 14000, DIRECT ${dal.depFix}`);
    expect(dal.tgtAlt).toBe(14000);
    expect(dal.latMode).toBe('fix');
  });

  it('arrival: contact, vectors, approach clearance, landing clearance', () => {
    step(() => stage === 3, 1500, 'vectored, established and cleared to land');
    expect(seen.landingRequest).toBe(true);
    expect(seen.clearedBefore).toBe(false);
    expect(ual.landCleared || ual.phase !== 'final').toBe(true);
    step(() => ual.phase === 'landing_roll' || ual.phase === 'vacated', 600, 'touchdown');
    expect(ual.goArounds).toBe(0);
    expect(sim.s.rwy['08L/26R'].lastArr['26R'].ac).toBe(ual.id);
  });

  it('arrival: exits the runway, needs gate + taxi + crossing clearances, parks', () => {
    step(() => ual.phase === 'vacated', 240, 'vacated');
    expect(ual.request?.type).toBe('taxi_in');
    expect(runwayZoneAt(sim.ap, ual.x, ual.y)).toBeUndefined();
    const x0 = ual.x;
    const t0 = sim.s.t;
    step(() => sim.s.t > t0 + 45, 100, 'wait');
    expect(ual.x).toBe(x0);
    // occupied gate is refused
    const occupied = sim.s.aircraft.find((a) => a.phase === 'parked' && a !== ual);
    if (occupied) expect(sim.commandText(`UAL892 TAXI GATE ${occupied.gate}`).ok).toBe(false);
    ok(sim, 'UAL892 TAXI GATE C12');
    expect(ual.phase).toBe('taxi_in');
    step(() => ual.request?.type === 'crossing', 400, 'holding short of 8R/26L');
    const t1 = sim.s.t;
    step(() => sim.s.t > t1 + 40, 100, 'wait');
    expect(ual.gs).toBe(0);
    expect(runwayZoneAt(sim.ap, ual.x, ual.y)).toBeUndefined();
    step(() => sim.commandText('UAL892 CROSS 26L').ok, 300, 'crossing clearance accepted');
    step(() => ual.phase === 'parked', 900, 'parked at C12');
    expect(ual.gate).toBe('C12');
    expect(ual.turn?.stage).toBeDefined();
  });

  it('departure leaves controlled airspace with a proper handoff; no safety events', () => {
    step(() => dal.phase === 'gone', 1500, 'departure handed off');
    expect(sim.s.stats.improperExits).toBe(0);
    expect(sim.s.stats.collisions).toBe(0);
    expect(sim.s.stats.incursions).toBe(0);
    // the other traffic also moved through the shared system
    expect(sim.s.stats.landed + sim.s.stats.departed).toBeGreaterThanOrEqual(3);
  });
});
