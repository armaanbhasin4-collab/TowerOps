/** Topic 11: aircraft physics – turn rate, speed and vertical-rate limits, type differences, wind, takeoff roll. */
import { describe, expect, it } from 'vitest';
import type { Aircraft } from '../src/sim/types';
import { AIRCRAFT_TYPES, typeOf } from '../src/sim/data/aircraft';
import { endRef } from '../src/sim/airport/query';
import { NM, angDiff } from '../src/sim/util';
import { Sim } from '../src/sim/sim';
import { cmd, mkSim, ok, placeAirborne, placeFinal, placeOnRunway, until } from './helpers';

const X0 = -8 * NM, Y0 = 10 * NM;
const CALM = { customWeather: { windDir: 270, windKt: 0, gustKt: 0 } };

/** step the sim in 0.1 s increments, recording per-step maxima for one aircraft */
function observe(sim: Sim, ac: Aircraft, seconds: number, stop?: () => boolean) {
  const m = { dHdg: 0, dIas: 0, dVs: 0, maxVs: -Infinity, minVs: Infinity, dPos: 0, dAlt: 0, steps: 0 };
  for (let i = 0; i < seconds * 10 && !(stop && stop()); i++) {
    const p = { hdg: ac.hdg, ias: ac.ias, vs: ac.vs, x: ac.x, y: ac.y, alt: ac.alt, gs: ac.gs };
    sim.advance(0.1);
    m.dHdg = Math.max(m.dHdg, Math.abs(angDiff(p.hdg, ac.hdg)));
    m.dIas = Math.max(m.dIas, Math.abs(ac.ias - p.ias));
    m.dVs = Math.max(m.dVs, Math.abs(ac.vs - p.vs));
    m.maxVs = Math.max(m.maxVs, ac.vs);
    m.minVs = Math.min(m.minVs, ac.vs);
    m.dPos = Math.max(m.dPos, Math.hypot(ac.x - p.x, ac.y - p.y) - Math.max(p.gs, ac.gs) * 0.514444 * 0.1);
    m.dAlt = Math.max(m.dAlt, Math.abs(ac.alt - p.alt));
    m.steps++;
  }
  return m;
}

describe('airborne kinematics limits', () => {
  it('turn rate never exceeds 3°/s and a 180° turn takes at least a minute', () => {
    const sim = mkSim('ATL', CALM);
    const ac = placeAirborne(sim, { callsign: 'DAL1', x: X0, y: Y0, alt: 6000, hdg: 90, ias: 220 });
    ok(sim, 'DAL1 TURN RIGHT HEADING 270');
    const t0 = sim.s.t;
    const m = observe(sim, ac, 200, () => Math.abs(angDiff(ac.hdg, 270)) < 0.5);
    expect(Math.abs(angDiff(ac.hdg, 270))).toBeLessThan(0.5);
    expect(m.dHdg).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(m.dHdg).toBeGreaterThan(0.1); // it does turn at a sensible rate
    expect(sim.s.t - t0).toBeGreaterThanOrEqual(58);
    expect(sim.s.t - t0).toBeLessThan(150);
    // heading holds afterwards
    sim.advance(30);
    expect(Math.abs(angDiff(ac.hdg, 270))).toBeLessThan(0.5);
  });

  it('turns the short way by default and the long way when a direction is given', () => {
    const sim = mkSim('ATL', CALM);
    const a = placeAirborne(sim, { callsign: 'DAL1', x: X0, y: Y0, alt: 6000, hdg: 90 });
    const b = placeAirborne(sim, { callsign: 'DAL2', x: X0, y: Y0 + 8 * NM, alt: 9000, hdg: 90 });
    sim.command(a, [{ t: 'HEADING', hdg: 180 }]);
    sim.command(b, [{ t: 'HEADING', hdg: 180, dir: 'L' }]);
    sim.advance(14);
    expect(angDiff(90, a.hdg)).toBeGreaterThan(10); // right turn
    expect(angDiff(90, b.hdg)).toBeLessThan(-10); // left turn, the long way round
    sim.advance(200);
    expect(Math.abs(angDiff(a.hdg, 180))).toBeLessThan(1);
    expect(Math.abs(angDiff(b.hdg, 180))).toBeLessThan(1);
  });

  it('speed changes are gradual in both directions', () => {
    const sim = mkSim('ATL', CALM);
    const ac = placeAirborne(sim, { callsign: 'DAL1', x: X0, y: Y0, alt: 6000, hdg: 90, ias: 250 });
    ok(sim, 'DAL1 SPEED 180');
    expect(ac.ias).toBeGreaterThan(240); // no jump on the readback
    const t0 = sim.s.t;
    const m = observe(sim, ac, 200, () => ac.ias <= 180.01);
    expect(ac.ias).toBeCloseTo(180, 1);
    expect(m.dIas).toBeLessThanOrEqual(0.16 + 1e-9);
    expect(sim.s.t - t0).toBeGreaterThan(40); // ~1.2 kt/s
    ok(sim, 'DAL1 SPEED 240');
    const t1 = sim.s.t;
    const m2 = observe(sim, ac, 200, () => ac.ias >= 239.99);
    expect(m2.dIas).toBeLessThanOrEqual(0.16 + 1e-9);
    expect(sim.s.t - t1).toBeGreaterThan(30);
    expect(m.dPos).toBeLessThan(0.05); // position always advances by ground speed × dt
  });

  it('climb and descent rates are bounded by the type data and change smoothly', () => {
    for (const type of ['B738', 'B77W', 'E75L', 'AT76', 'A388']) {
      const t = typeOf(type);
      const sim = mkSim('ATL', CALM);
      const ac = placeAirborne(sim, { callsign: 'DAL1', type, x: X0, y: Y0, alt: 6000, hdg: 90, ias: 200 });
      ok(sim, 'DAL1 CLIMB 9000');
      const up = observe(sim, ac, 400, () => ac.alt === 9000);
      expect(ac.alt, type).toBe(9000);
      expect(up.maxVs, type).toBeLessThanOrEqual(t.climbFpm + 1e-6);
      expect(up.maxVs, type).toBeGreaterThan(t.climbFpm * 0.9);
      expect(up.minVs, type).toBeGreaterThanOrEqual(0);
      expect(up.dVs, type).toBeLessThanOrEqual(190 + 1e-6); // 900 fpm/s, plus the final capture of the level (<100 fpm)
      expect(up.dAlt, type).toBeLessThanOrEqual(30); // no altitude jumps (the last <30 ft are captured in one step)
      ok(sim, 'DAL1 DESCEND 4000');
      const dn = observe(sim, ac, 600, () => ac.alt === 4000);
      expect(ac.alt, type).toBe(4000);
      expect(dn.minVs, type).toBeGreaterThanOrEqual(-t.descentFpm - 1e-6);
      expect(dn.minVs, type).toBeLessThan(-t.descentFpm * 0.9);
      expect(dn.maxVs, type).toBeLessThanOrEqual(1e-6);
      expect(dn.dVs, type).toBeLessThanOrEqual(190 + 1e-6);
      expect(ac.vs, type).toBe(0);
    }
  });

  it('crews refuse speeds outside the envelope', () => {
    const sim = mkSim('ATL', CALM);
    placeAirborne(sim, { callsign: 'DAL1', type: 'B77W', x: X0, y: Y0, alt: 6000, hdg: 90, ias: 220 });
    const slow = sim.commandText('DAL1 SPEED 130');
    expect(slow.refused).toBe(true);
    expect(slow.message).toMatch(/minimum speed/i);
    const fast = sim.commandText('DAL1 SPEED 280');
    expect(fast.refused).toBe(true);
    expect(fast.message).toMatch(/250 knots below ten thousand/i);
  });
});

describe('aircraft types behave differently under identical instructions', () => {
  function departure(type: string) {
    const sim = mkSim('ATL', { configName: 'West flow', ...CALM });
    const ac = placeOnRunway(sim, '27R', { callsign: 'DAL1', type, along: 60 });
    ok(sim, 'DAL1 CLEARED TAKEOFF 27R');
    until(sim, () => ac.phase === 'takeoff_roll', 20, 'roll');
    const startDist = ac.rwyDist!, tStart = sim.s.t;
    const roll = observe(sim, ac, 120, () => ac.phase === 'departure');
    const rollDist = ac.rwyDist! - startDist, rollTime = sim.s.t - tStart, liftoffKt = ac.ias;
    const tAir = sim.s.t;
    const climb = observe(sim, ac, 400, () => ac.alt >= 4000);
    return { sim, ac, rollDist, rollTime, liftoffKt, timeTo4000: sim.s.t - tAir, maxVs: climb.maxVs, roll };
  }
  const heavy = departure('B77W');
  const regional = departure('E75L');

  it('takeoff roll: the 777-300ER needs far more runway and time than the E175', () => {
    expect(heavy.rollDist).toBeGreaterThan(regional.rollDist * 1.5);
    expect(heavy.rollTime).toBeGreaterThan(regional.rollTime + 10);
    expect(heavy.liftoffKt).toBeGreaterThanOrEqual(AIRCRAFT_TYPES.B77W.vr);
    expect(regional.liftoffKt).toBeGreaterThanOrEqual(AIRCRAFT_TYPES.E75L.vr);
    expect(regional.liftoffKt).toBeLessThan(AIRCRAFT_TYPES.B77W.vr - 20);
    // acceleration on the roll is continuous
    expect(heavy.roll.dIas).toBeLessThan(0.5);
    expect(regional.roll.dIas).toBeLessThan(0.5);
  });

  it('climb: the E175 out-climbs the 777-300ER, each within its type limit', () => {
    expect(heavy.maxVs).toBeLessThanOrEqual(AIRCRAFT_TYPES.B77W.climbFpm + 1e-6);
    expect(regional.maxVs).toBeLessThanOrEqual(AIRCRAFT_TYPES.E75L.climbFpm + 1e-6);
    expect(regional.maxVs).toBeGreaterThan(heavy.maxVs + 400);
    expect(regional.timeTo4000).toBeLessThan(heavy.timeTo4000 - 15);
  });

  it('approach: each type flies its own final approach speed', () => {
    const speeds: Record<string, number> = {};
    for (const type of ['B77W', 'E75L']) {
      const sim = mkSim('ATL', { configName: 'West flow', ...CALM });
      const ac = placeFinal(sim, '27L', 5, { callsign: 'UAL1', type, landCleared: true });
      ac.ias = 170;
      until(sim, () => { const e = endRef(sim.ap, '27L')!; return Math.hypot(ac.x - e.end.x, ac.y - e.end.y) < 1.2 * NM; }, 300, '1.2 NM final');
      speeds[type] = ac.ias;
      expect(ac.ias).toBeCloseTo(typeOf(type).vref + 5, 0);
    }
    expect(speeds.B77W - speeds.E75L).toBeGreaterThan(20);
  });

  it('takeoff roll distance is plausible for every type and grows with aircraft size', () => {
    const dist: Record<string, number> = {};
    for (const type of Object.keys(AIRCRAFT_TYPES)) {
      const d = type === 'B77W' ? heavy : type === 'E75L' ? regional : departure(type);
      dist[type] = d.rollDist;
      const t = typeOf(type);
      const jet = t.family !== 'GA' && !t.turboprop;
      if (jet) {
        expect(d.rollDist, type).toBeGreaterThan(800);
        expect(d.rollDist, type).toBeLessThan(3500);
      } else {
        expect(d.rollDist, type).toBeGreaterThan(250);
        expect(d.rollDist, type).toBeLessThan(1800);
      }
      // never longer than the certified takeoff distance, and it fits on the runway used
      expect(d.rollDist, type).toBeLessThan(t.takeoffDist * 1.3);
      expect(d.rollDist + 60, type).toBeLessThan(endRef(d.sim.ap, '27R')!.rwy.length);
      expect(d.ac.alt, type).toBeGreaterThan(0);
    }
    for (const big of ['B77W', 'A388', 'B748', 'B772']) for (const small of ['E75L', 'E170', 'CRJ7', 'CRJ9', 'AT76']) expect(dist[big], `${big} vs ${small}`).toBeGreaterThan(dist[small] * 1.3);
    expect(dist.B738).toBeGreaterThan(dist.E75L);
  });

  it('a headwind shortens the takeoff roll', () => {
    const calm = departure('A321').rollDist;
    const sim = mkSim('ATL', { configName: 'West flow', customWeather: { windDir: 270, windKt: 20, gustKt: 0 } });
    const ac = placeOnRunway(sim, '27R', { callsign: 'DAL1', type: 'A321', along: 60 });
    ok(sim, 'DAL1 CLEARED TAKEOFF 27R');
    until(sim, () => ac.phase === 'departure', 120, 'airborne');
    expect(ac.rwyDist! - 60).toBeLessThan(calm * 0.85);
  });
});

describe('wind', () => {
  function fly(windDir: number, windKt: number) {
    const sim = mkSim('ATL', { customWeather: { windDir, windKt, gustKt: 0 } });
    const ac = placeAirborne(sim, { callsign: 'DAL1', x: X0, y: Y0, alt: 6000, hdg: 360, ias: 200 });
    sim.advance(120);
    return { ac, dx: ac.x - X0, dy: ac.y - Y0 };
  }
  it('no wind: the aircraft tracks its heading', () => {
    const { ac, dx, dy } = fly(270, 0);
    expect(Math.abs(dx)).toBeLessThan(1);
    expect(dy).toBeGreaterThan(10000);
    expect(ac.track).toBeCloseTo(0, 5);
    expect(ac.hdg).toBe(0);
  });
  it('a westerly crosswind drifts an aircraft on a fixed heading to the east (and vice versa)', () => {
    const w = fly(270, 30);
    expect(w.ac.hdg).toBe(0); // heading unchanged...
    expect(w.dx).toBeGreaterThan(1500); // ...but it is blown downwind
    expect(w.ac.track).toBeGreaterThan(5);
    expect(w.ac.track).toBeLessThan(30);
    const e = fly(90, 30);
    expect(e.dx).toBeLessThan(-1500);
    // stronger wind, more drift
    expect(fly(270, 45).dx).toBeGreaterThan(w.dx * 1.3);
  });
  it('headwind / tailwind change the ground speed, not the airspeed', () => {
    const calm = fly(270, 0), head = fly(360, 30), tail = fly(180, 30);
    expect(head.ac.ias).toBe(calm.ac.ias);
    expect(head.ac.gs).toBeLessThan(calm.ac.gs - 25);
    expect(tail.ac.gs).toBeGreaterThan(calm.ac.gs + 25);
    expect(head.dy).toBeLessThan(calm.dy);
    expect(tail.dy).toBeGreaterThan(calm.dy);
  });
  it('on the localiser the crew crabs into the wind and stays on the centreline', () => {
    const sim = mkSim('ATL', { configName: 'West flow', customWeather: { windDir: 360, windKt: 20, gustKt: 0 } }, { perfRealism: false });
    const ac = placeFinal(sim, '27L', 8, { callsign: 'UAL1', landCleared: true });
    const e = endRef(sim.ap, '27L')!;
    sim.advance(90);
    expect(ac.phase).toBe('final');
    expect(Math.abs(ac.y - e.end.y)).toBeLessThan(60);
    expect(angDiff(e.end.hdg, ac.hdg)).toBeGreaterThan(2); // nose pointing right of the runway heading, into the northerly wind
    until(sim, () => ac.phase === 'landing_roll', 300, 'touchdown');
    expect(cmd).toBeDefined();
  });
});
