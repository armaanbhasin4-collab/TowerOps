/** Topic 14: weather restrictions on pilot decisions and performance, METAR output. */
import { describe, expect, it } from 'vitest';
import type { Weather } from '../src/sim/types';
import { metar, runwayWeatherIssue, fmtWind } from '../src/sim/weather';
import { endRef, windComponents } from '../src/sim/airport/query';
import { defaultCustomParams } from '../src/sim/airport/custom';
import { NM, vecOf } from '../src/sim/util';
import { Sim } from '../src/sim/sim';
import { eventsOf, mkSim, ok, placeAirborne, placeFinal, placeOnRunway, quietConfig, until } from './helpers';

const wx = (w: Partial<Weather>) => ({ configName: 'West flow', customWeather: { windDir: 270, windKt: 5, gustKt: 0, ...w } });
/** an arrival being vectored for 27L / a departure lined up on 27R */
function setup(w: Partial<Weather>, diff = {}) {
  const sim = mkSim('ATL', wx(w), diff);
  const e = endRef(sim.ap, '27L')!;
  const [ux, uy] = vecOf(e.end.hdg);
  const arr = placeAirborne(sim, { callsign: 'UAL1', airline: 'UAL', x: e.end.x - ux * 14 * NM, y: e.end.y - uy * 14 * NM + 2 * NM, alt: 3000, hdg: 240, ias: 190 });
  const dep = placeOnRunway(sim, '27R', { callsign: 'DAL2' });
  return { sim, arr, dep };
}

describe('crosswind / tailwind limits (perfRealism)', () => {
  it('wind components are computed correctly', () => {
    expect(windComponents(270, 270, 20).head).toBeCloseTo(20);
    expect(windComponents(270, 270, 20).cross).toBeCloseTo(0);
    expect(windComponents(270, 360, 20).cross).toBeCloseTo(20);
    expect(windComponents(270, 90, 20).head).toBeCloseTo(-20);
    expect(windComponents(270, 300, 20).cross).toBeCloseTo(10);
  });

  it('a 40 kt crosswind: approach and takeoff are refused with the reason', () => {
    const { sim, arr, dep } = setup({ windDir: 360, windKt: 40 });
    const a = sim.commandText('UAL1 CLEARED ILS 27L');
    expect(a.ok).toBe(false);
    expect(a.refused).toBe(true);
    expect(a.message).toMatch(/UAL1 unable: runway two seven left, crosswind 40 knots exceeds our limit/);
    const t = sim.commandText('DAL2 CLEARED TAKEOFF 27R');
    expect(t.refused).toBe(true);
    expect(t.message).toMatch(/crosswind 40 knots exceeds our limit/);
    sim.advance(60);
    expect(arr.phase).toBe('inbound');
    expect(arr.apprCleared).toBe(false);
    expect(dep.phase).toBe('lined_up');
    expect(eventsOf(sim, 'pilot_action').filter((e) => /refused/.test(e.text))).toHaveLength(2);
    expect(sim.s.radio.filter((m) => m.from === 'pilot' && /^Unable, /.test(m.text))).toHaveLength(2);
  });

  it('the same wind is accepted when perfRealism is off', () => {
    const { sim, arr, dep } = setup({ windDir: 360, windKt: 40 }, { perfRealism: false });
    ok(sim, 'UAL1 CLEARED ILS 27L');
    ok(sim, 'DAL2 CLEARED TAKEOFF 27R');
    expect(arr.phase).toBe('approach');
    until(sim, () => dep.phase === 'departure', 120, 'airborne');
  });

  it('a crosswind within limits is accepted; the limit depends on the type and the surface', () => {
    const { sim } = setup({ windDir: 360, windKt: 25 });
    expect(sim.commandText('UAL1 CLEARED ILS 27L').ok).toBe(true);
    expect(sim.commandText('DAL2 CLEARED TAKEOFF 27R').ok).toBe(true);
    // 30 kt: fine for a 737 (33 kt) on a dry runway, too much on a wet one (×0.85) and for an ATR 72 on snow (×0.6)
    const dry = setup({ windDir: 360, windKt: 30 });
    expect(runwayWeatherIssue(dry.sim, '27L', 33, true)).toBeUndefined();
    const wet = setup({ windDir: 360, windKt: 30, surface: 'wet', precip: 'rain' });
    expect(runwayWeatherIssue(wet.sim, '27L', 33, true)).toMatch(/crosswind 30 knots/);
    expect(wet.sim.commandText('UAL1 CLEARED ILS 27L').refused).toBe(true);
    const snow = setup({ windDir: 360, windKt: 20, surface: 'snow', precip: 'snow' });
    expect(runwayWeatherIssue(snow.sim, '27L', 30, true)).toMatch(/crosswind 20 knots/);
    expect(runwayWeatherIssue(snow.sim, '27L', 38, true)).toBeUndefined();
  });

  it('gusts count towards the limit', () => {
    const { sim } = setup({ windDir: 360, windKt: 20, gustKt: 45 });
    const r = sim.commandText('UAL1 CLEARED ILS 27L');
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/crosswind 38 knots/);
  });

  it('a 15 kt tailwind: approach and takeoff are refused; the opposite direction is fine', () => {
    const { sim } = setup({ windDir: 90, windKt: 15 });
    const a = sim.commandText('UAL1 CLEARED ILS 27L');
    expect(a.refused).toBe(true);
    expect(a.message).toMatch(/tailwind 15 knots/);
    const t = sim.commandText('DAL2 CLEARED TAKEOFF 27R');
    expect(t.refused).toBe(true);
    expect(t.message).toMatch(/tailwind 15 knots/);
    expect(sim.commandText('UAL1 CLEARED ILS 09R').ok).toBe(true);
    // a light tailwind (≤ 10 kt) is acceptable
    const light = setup({ windDir: 90, windKt: 8 });
    expect(light.sim.commandText('UAL1 CLEARED ILS 27L').ok).toBe(true);
    expect(light.sim.commandText('DAL2 CLEARED TAKEOFF 27R').ok).toBe(true);
  });

  it('a strong tailwind produces a controller advisory to change configuration', () => {
    const { sim } = setup({ windDir: 90, windKt: 15 });
    sim.advance(40);
    expect(eventsOf(sim, 'weather').some((e) => /tailwind on runway/.test(e.text))).toBe(true);
  });

  it('a MAYDAY aircraft accepts an approach in out-of-limit wind', () => {
    const { sim, arr } = setup({ windDir: 360, windKt: 40 });
    arr.emergency = { kind: 'engine_failure', since: 0, mayday: true };
    expect(sim.commandText('UAL1 CLEARED ILS 27L').ok).toBe(true);
  });
});

describe('runway surface', () => {
  /** distance from the threshold at which a landing A330 turns off / stops, and the time it needs */
  function landing(surface: Weather['surface']) {
    const sim = mkSim('ATL', wx({ surface, precip: surface === 'snow' ? 'snow' : surface === 'wet' ? 'rain' : 'none' }), { perfRealism: false });
    const ac = placeFinal(sim, '27R', 2, { callsign: 'DAL1', airline: 'DAL', type: 'A333', landCleared: true });
    until(sim, () => ac.phase === 'landing_roll', 200, 'touchdown');
    const td = ac.rwyDist!, t0 = sim.s.t;
    let dist60 = -1, maxDist = td;
    until(sim, () => ac.phase === 'vacated', 400, 'vacated', () => {
      if (ac.route.length < 2) maxDist = Math.max(maxDist, ac.rwyDist!);
      if (dist60 < 0 && ac.gs <= 60) dist60 = maxDist - td;
    });
    return { roll: maxDist - td, dist60, time: sim.s.t - t0, sim, ac };
  }
  const dry = landing('dry'), wet = landing('wet'), snow = landing('snow'), ice = landing('ice');

  it('wet and contaminated runways lengthen the landing roll', () => {
    const v = [dry, wet, snow, ice].map((r) => Math.round(r.roll));
    // never shorter on a worse surface (dry and wet may share the same exit)
    for (let i = 1; i < v.length; i++) expect(v[i], `landing rolls ${v.join(' / ')} m`).toBeGreaterThanOrEqual(v[i - 1] - 20);
    expect(dry.roll).toBeGreaterThan(400);
    expect(snow.roll).toBeGreaterThan(dry.roll + 100);
    expect(ice.roll).toBeGreaterThan(wet.roll + 100);
    expect(ice.time).toBeGreaterThan(dry.time);
    for (const r of [dry, wet, snow, ice]) {
      expect(r.roll).toBeLessThan(endRef(r.sim.ap, '27R')!.rwy.length); // stays on the runway
      expect(r.sim.s.stats.collisions).toBe(0);
    }
  });

  it('braking deceleration on the runway is weaker on wet / snow / ice (no exits available: full stop)', () => {
    const stop = (surface: Weather['surface']) => {
      const sim = mkSim('ATL', wx({ surface }), { perfRealism: false });
      const ac = placeOnRunway(sim, '27R', { callsign: 'DAL1', type: 'A333', along: 300, phase: 'landing_roll', gs: 130, kind: 'arrival' });
      ac.landCleared = true;
      ac.flags.stopOnRwy = 1; // brake to a full stop on the runway
      let d = 0;
      for (let i = 0; i < 3000 && ac.phase === 'landing_roll'; i++) { sim.advance(0.1); d = ac.rwyDist! - 300; }
      return d;
    };
    const d = [stop('dry'), stop('wet'), stop('snow'), stop('ice')];
    expect(d[0]).toBeGreaterThan(700);
    expect(d[1]).toBeGreaterThan(d[0] * 1.2);
    expect(d[2]).toBeGreaterThan(d[1] * 1.2);
    expect(d[3]).toBeGreaterThan(d[2] * 1.2);
  });

  it('with perfRealism the required landing distance grows on wet / snow and short runways are refused', () => {
    // LGA: 2135 m runways. A 767-300 needs 1700 m dry, 2125 m wet, 2720 m on snow
    const mk = (surface: Weather['surface']) => {
      const sim = mkSim('LGA', { customWeather: { windDir: 220, windKt: 5, gustKt: 0, surface } });
      placeAirborne(sim, { callsign: 'DAL1', type: 'B763', x: 10 * NM, y: 10 * NM, alt: 4000, hdg: 220 });
      return sim.commandText('DAL1 CLEARED ILS 22');
    };
    expect(mk('dry').ok).toBe(true);
    expect(mk('wet').ok).toBe(true);
    const r = mk('snow');
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/too short for us, we need 2720 metres/);
  });

  it('snow slows taxiing', () => {
    const speeds: number[] = [];
    for (const surface of ['dry', 'snow'] as const) {
      const sim = mkSim('ATL', wx({ surface }));
      const { placeOnRoute, routeVia } = helpers;
      const ac = placeOnRoute(sim, routeVia(sim, [[-1300, -80], [600, -80]]), { callsign: 'DAL1' });
      sim.advance(60);
      speeds.push(ac.gs);
    }
    expect(speeds[0]).toBeCloseTo(21, 0);
    expect(speeds[1]).toBeCloseTo(21 * 0.75, 0);
  });
});
import * as helpers from './helpers';

describe('visibility, closed runways and storms', () => {
  it('below CAT III minima the crew flies a missed approach even with a landing clearance', () => {
    const sim = mkSim('ATL', wx({ visSM: 0.1, ceilingFt: 100, precip: 'fog' }));
    const ac = placeFinal(sim, '27L', 4, { callsign: 'UAL1', landCleared: true });
    until(sim, () => ac.phase === 'go_around', 300, 'missed approach');
    expect(eventsOf(sim, 'go_around')[0].text).toMatch(/missed approach, runway not in sight at minimums/);
    expect(sim.s.stats.landed).toBe(0);
    expect(sim.s.stats.pilotGoArounds).toBe(1);
  });

  it('low visibility with an ILS is flyable (CAT II/III): the aircraft lands', () => {
    const sim = mkSim('ATL', wx({ visSM: 0.25, ceilingFt: 200, precip: 'fog' }));
    const ac = placeFinal(sim, '27L', 4, { callsign: 'UAL1', landCleared: true });
    until(sim, () => ac.phase === 'landing_roll', 300, 'touchdown');
    expect(sim.s.stats.goArounds).toBe(0);
  });

  /** custom single-runway field whose runway has no ILS */
  function nonIlsSim(w: Partial<Weather>, diff = {}) {
    const p = { ...defaultCustomParams(), name: `NoILS ${JSON.stringify(w)}${JSON.stringify(diff)}`, runways: [{ length: 3000, hdg: 90, offset: 0, along: 0 }] };
    const cfg = quietConfig('CUSTOM', { custom: p, customWeather: { windDir: 90, windKt: 5, gustKt: 0, ...w } });
    Object.assign(cfg.difficulty, diff);
    const sim = new Sim(cfg);
    for (const e of sim.ap.runways[0].ends) e.ils = false; // this airport instance is private to the test (unique cache key)
    const end = sim.ap.runways[0].ends.find((e) => Math.abs(e.hdg - 90) < 1)!;
    return { sim, end };
  }

  it('no instrument approach + weather below visual minimums → approach refused', () => {
    const { sim, end } = nonIlsSim({ visSM: 1.5, ceilingFt: 600, precip: 'rain' });
    placeAirborne(sim, { callsign: 'DAL1', x: end.x - 14 * NM, y: end.y + 2 * NM, alt: 3000, hdg: 120 });
    const r = sim.commandText(`DAL1 CLEARED ILS ${end.name}`);
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/no instrument approach and weather below visual minimums/);
    // good weather: the same approach is accepted
    const good = nonIlsSim({ visSM: 10, ceilingFt: 99999 });
    placeAirborne(good.sim, { callsign: 'DAL1', x: good.end.x - 14 * NM, y: good.end.y + 2 * NM, alt: 3000, hdg: 120 });
    expect(good.sim.commandText(`DAL1 CLEARED ILS ${good.end.name}`).ok).toBe(true);
  });

  it('no instrument approach: an aircraft already on final goes missed at minimums in poor visibility', () => {
    const { sim, end } = nonIlsSim({ visSM: 1.5, ceilingFt: 600, precip: 'rain' }, { perfRealism: false });
    const ac = placeFinal(sim, end.name, 4, { callsign: 'UAL1', landCleared: true });
    until(sim, () => ac.phase !== 'final', 300, 'outcome');
    expect(ac.phase).toBe('go_around');
    expect(eventsOf(sim, 'go_around')[0].text).toMatch(/runway not in sight at minimums/);
  });

  it('closed runway → approach, landing, taxi-out and takeoff clearances are refused', () => {
    const { sim, arr } = setup({});
    const fin = placeFinal(sim, '27L', 9, { callsign: 'AAL3', airline: 'AAL' });
    sim.setRunwayClosed('27L', true, 'disabled aircraft');
    sim.setRunwayClosed('27R', true, 'snow removal');
    for (const [text, re] of [
      ['UAL1 CLEARED ILS 27L', /runway two seven left is closed/],
      ['AAL3 CLEARED LAND 27L', /runway two seven left is closed/],
      ['DAL2 CLEARED TAKEOFF 27R', /runway two seven right is closed/],
    ] as const) {
      const r = sim.commandText(text);
      expect(r.refused, text).toBe(true);
      expect(r.message, text).toMatch(re);
    }
    expect(arr.apprCleared).toBe(false);
    expect(fin.landCleared).toBe(false);
    expect(eventsOf(sim, 'runway').filter((e) => /CLOSED/.test(e.text))).toHaveLength(2);
    // the other runways are unaffected
    expect(sim.commandText('UAL1 CLEARED ILS 26R').ok).toBe(true);
  });

  it('closing a runway changes the ATIS letter and is reversible', () => {
    const sim = mkSim('ATL');
    const a0 = sim.s.atis;
    sim.setRunwayClosed('8L', true);
    expect(sim.s.rwy['08L/26R'].closed).toBe(true);
    expect(sim.s.atis).not.toBe(a0);
    sim.setRunwayClosed('26R', false);
    expect(sim.s.rwy['08L/26R'].closed).toBe(false);
  });

  it('a thunderstorm cell off the departure end → takeoff refused; line-up and other runways still possible', () => {
    const e = endRef(mkSim('ATL').ap, '27R')!;
    const [ux, uy] = vecOf(e.end.hdg);
    const cell = { x: e.end.x + ux * 6 * NM, y: e.end.y + uy * 6 * NM, r: 3 * NM, intensity: 0.9, vx: 0, vy: 0 };
    const sim = mkSim('ATL', wx({ precip: 'thunderstorm', cells: [cell] }));
    const dep = placeOnRunway(sim, '27R', { callsign: 'DAL2' });
    const east = placeOnRunway(sim, '08R', { callsign: 'DAL3' });
    const r = sim.commandText('DAL2 CLEARED TAKEOFF 27R');
    expect(r.refused).toBe(true);
    expect(r.message).toMatch(/weather off the departure end/);
    sim.advance(30);
    expect(dep.phase).toBe('lined_up');
    // departing away from the cell is fine (wind permitting)
    expect(sim.commandText('DAL3 CLEARED TAKEOFF 08R').ok).toBe(true);
    expect(east.rwy).toBe('08R');
    // wind shear is advertised while the cell is close to the field
    expect(sim.s.weather.windshear).toBe(true);
    expect(metar(sim)).toMatch(/TSRA/);
    expect(metar(sim)).toMatch(/WS ALL RWY/);
  });

  it('aircraft flying into a storm cell report it and it is penalised', () => {
    const cell = { x: -6 * NM, y: 12 * NM, r: 3 * NM, intensity: 0.9, vx: 0, vy: 0 };
    const sim = mkSim('ATL', wx({ precip: 'thunderstorm', cells: [cell] }));
    placeAirborne(sim, { callsign: 'DAL1', x: -14 * NM, y: 12 * NM, alt: 6000, hdg: 90 });
    sim.advance(40);
    expect(sim.s.radio.some((m) => /weather ahead on this heading, request deviation/.test(m.text))).toBe(true);
    sim.advance(80);
    expect(eventsOf(sim, 'weather').some((e) => /DAL1 penetrated a thunderstorm cell/.test(e.text))).toBe(true);
    expect(sim.s.stats.safetyPenalty).toBeGreaterThanOrEqual(3);
  });
});

describe('METAR', () => {
  it('reports the custom weather in METAR format', () => {
    const sim = mkSim('ATL', wx({ windDir: 270, windKt: 5 }));
    expect(metar(sim)).toBe('KATL 181400L 27005KT 10SM FEW250 22/11 A3002');
    expect(fmtWind(sim.s.weather)).toBe('270/5');
  });
  it.each([
    [{ windDir: 0, windKt: 12, gustKt: 25, visSM: 3, ceilingFt: 1800, precip: 'rain' as const, tempC: 16, dewC: 15, qnh: 2978 }, /^KATL \d{6}L 36012G25KT 3SM -RA OVC018 16\/15 A2978/],
    [{ windKt: 0, visSM: 0.25, ceilingFt: 200, precip: 'fog' as const, tempC: 9, dewC: 9, qnh: 3021 }, /^KATL \d{6}L 00000KT 1\/4SM FG VV002 09\/09 A3021$/],
    [{ windDir: 310, windKt: 14, visSM: 1.5, ceilingFt: 1200, precip: 'snow' as const, tempC: -3, dewC: -5 }, /31014KT 2SM SN OVC012 M03\/M05/],
    [{ visSM: 4, ceilingFt: 4500, precip: 'heavy_rain' as const }, /27005KT 4SM \+RA BKN045 /],
  ])('%j', (w, re) => {
    expect(metar(mkSim('ATL', wx(w)))).toMatch(re);
  });
  it('every preset yields a well-formed METAR and the time group follows the sim clock', () => {
    for (const preset of ['clear', 'rain', 'thunderstorm', 'fog', 'winter', 'dynamic'] as const) {
      const cfg = quietConfig('JFK');
      cfg.weatherPreset = preset;
      const sim = new Sim(cfg);
      expect(metar(sim), preset).toMatch(/^KJFK 18\d{4}L (\d{5}(G\d{2})?KT) (10SM|\d SM|\dSM|1\/4SM|1\/2SM|3\/4SM)( (-RA|\+RA|SN|FG|TSRA))? (FEW250|VV\d{3}|(OVC|BKN)\d{3}(CB)?) M?\d{2}\/M?\d{2} A\d{4}( WS ALL RWY)?$/);
      expect(sim.s.events[0].text).toContain(metar(sim).split(' ')[0]);
    }
    const sim = mkSim('ATL', wx({}));
    sim.advance(25 * 60);
    expect(metar(sim)).toMatch(/^KATL 181425L /);
  });
  it('preset weather has the advertised character', () => {
    const mk = (preset: 'fog' | 'winter' | 'thunderstorm' | 'rain' | 'clear') => { const c = quietConfig('ATL'); c.weatherPreset = preset; return new Sim(c).s.weather; };
    expect(mk('clear').visSM).toBe(10);
    expect(mk('fog').visSM).toBeLessThanOrEqual(0.5);
    expect(mk('winter').precip).toBe('snow');
    expect(['snow', 'ice']).toContain(mk('winter').surface);
    expect(mk('thunderstorm').cells.length).toBeGreaterThanOrEqual(2);
    expect(mk('rain').surface).toBe('wet');
  });
});
