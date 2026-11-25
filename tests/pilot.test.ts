import { describe, expect, it } from 'vitest';
import { ASSIST_PRESETS, configProblems, createPilot, setInstructor, stepPilot } from '../src/pilot/sim';
import { apButton } from '../src/pilot/autopilot';
import { atcRequest, atcRequests } from '../src/pilot/atc';
import { activeChecklists, checklistsFor, missedItems } from '../src/pilot/checklists';
import { debrief, scoreLanding } from '../src/pilot/scoring';
import { indicatedAlt, setControl } from '../src/pilot/systems';
import { ACDEF, stallKt } from '../src/pilot/aircraft';
import { routeDistanceNm, surfaceAt } from '../src/pilot/world';
import type { Inputs, PilotConfig, PilotState, RealismPreset } from '../src/pilot/types';

const Z: Inputs = { pitch: 0, roll: 0, yaw: 0, brake: 0 };
const cfg = (aircraft: 'c172' | 'jet', preset: RealismPreset, over: Partial<PilotConfig> = {}): PilotConfig => ({ aircraft, kind: 'route', depId: 'LGA', destId: 'JFK', assists: { ...ASSIST_PRESETS[preset] }, hour: 14, weather: 'clear', seed: 42, ...over });
const run = (p: PilotState, sec: number, inp: Inputs | ((p: PilotState) => Inputs) = Z, dt = 1 / 30) => { for (let t = 0; t < sec && !p.over; t += dt) stepPilot(p, typeof inp === 'function' ? inp(p) : inp, dt); };
const until = (p: PilotState, cond: () => boolean, maxSec: number, label: string, inp: Inputs = Z) => { for (let t = 0; t < maxSec && !cond() && !p.over; t += 1 / 30) stepPilot(p, inp, 1 / 30); if (!cond()) throw new Error(`timeout: ${label} (phase ${p.phase}, t=${p.t.toFixed(0)})`); };
const fpm = (p: PilotState) => (p.ac.vs / 0.3048) * 60;

describe('setup', () => {
  it('places the destination at its great-circle distance', () => {
    expect(routeDistanceNm('ATL', 'JFK')).toBeGreaterThan(640);
    expect(routeDistanceNm('ATL', 'JFK')).toBeLessThan(680);
    expect(routeDistanceNm('LGA', 'JFK')).toBeLessThan(12);
  });
  it('rejects routes beyond the aircraft range and same-airport routes', () => {
    expect(configProblems(cfg('c172', 'study', { depId: 'ATL', destId: 'LAX' })).length).toBe(1);
    expect(configProblems(cfg('jet', 'study', { depId: 'EGLL', destId: 'LAX' })).length).toBe(1);
    expect(configProblems(cfg('jet', 'study', { depId: 'ATL', destId: 'ATL' })).length).toBe(1);
    expect(configProblems(cfg('jet', 'study', { depId: 'ATL', destId: 'JFK' }))).toEqual([]);
  });
  it('starts cold and dark on pavement at a stand', () => {
    for (const k of ['c172', 'jet'] as const) {
      const p = createPilot(cfg(k, 'study'));
      expect(p.sys.bus).toBe(false);
      expect(p.eng.some((e) => e.running)).toBe(false);
      expect(p.ac.onGround).toBe(true);
      expect(surfaceAt(p, p.ac.x, p.ac.y).kind).not.toBe('grass');
      expect(p.phase).toBe('preflight');
      expect(p.taxi!.pts.length).toBeGreaterThan(2);
    }
  });
  it('every start state produces a consistent aircraft', () => {
    for (const k of ['c172', 'jet'] as const) {
      for (const start of ['cold', 'ready', 'running', 'runway'] as const) {
        const p = createPilot(cfg(k, 'standard', { assists: { ...ASSIST_PRESETS.standard, start } }));
        run(p, 3);
        expect(p.ac.crashed).toBeNull();
        expect(p.eng.every((e) => e.running)).toBe(start === 'running' || start === 'runway');
      }
      const a = createPilot(cfg(k, 'standard', { kind: 'approach', destId: 'LGA' }));
      expect(a.ac.onGround).toBe(false);
      expect(a.phase).toBe('approach');
    }
  });
});

describe('jet systems', () => {
  it('needs electrics, bleed air and fuel in the right order to start an engine', () => {
    const p = createPilot(cfg('jet', 'study'));
    setControl(p, 'start2', 1);
    setControl(p, 'fuelLever2', 1);
    run(p, 20);
    expect(p.eng[1].n2).toBeLessThan(1); // no power, no air
    setControl(p, 'batt', 1);
    setControl(p, 'apu', 2);
    until(p, () => p.sys.apuRunning, 60, 'APU start');
    setControl(p, 'apuGen', 1);
    run(p, 10);
    expect(p.eng[1].n2).toBeLessThan(1); // still no bleed air
    setControl(p, 'fuelLever2', 0);
    setControl(p, 'bleedApu', 1);
    until(p, () => p.eng[1].n2 >= 24, 40, 'motoring to 25% N2');
    expect(p.eng[1].running).toBe(false);
    setControl(p, 'fuelLever2', 1);
    until(p, () => p.eng[1].running, 60, 'engine 2 running');
    expect(p.sw.start2).toBe(0); // starter cut-out
    expect(p.eng[0].running).toBe(false);
    expect(p.findings.some((f) => /Hot start/.test(f.text))).toBe(false);
  });
  it('records a hot start when fuel is introduced too early', () => {
    const p = createPilot(cfg('jet', 'standard'));
    setControl(p, 'fuelLever2', 1);
    setControl(p, 'start2', 1);
    until(p, () => p.eng[1].running, 90, 'engine running');
    expect(p.findings.some((f) => /Hot start/.test(f.text))).toBe(true);
  });
  it('battery alone drains and hydraulics need a pump', () => {
    const p = createPilot(cfg('jet', 'study'));
    setControl(p, 'batt', 1);
    run(p, 5);
    expect(p.sys.source).toBe('battery');
    expect(p.sys.cautions).toContain('ON BATTERY');
    expect(p.sys.hyd[0]).toBeLessThan(100);
    setControl(p, 'gpu', 1);
    setControl(p, 'hydElec1', 1);
    run(p, 5);
    expect(p.sys.source).toBe('ext');
    expect(p.sys.hyd[0]).toBeGreaterThan(2500);
  });
  it('IRS alignment takes time and resets if switched off', () => {
    const p = createPilot(cfg('jet', 'study'));
    setControl(p, 'batt', 1); setControl(p, 'gpu', 1); setControl(p, 'irsL', 1); setControl(p, 'irsR', 1);
    run(p, 30);
    expect(p.sys.align).toBeGreaterThan(0.2);
    expect(p.sys.align).toBeLessThan(1);
    expect(apButton(p, 'cmd')).not.toBe('');
    until(p, () => p.sys.align >= 1, 100, 'alignment');
    setControl(p, 'irsL', 0);
    run(p, 1);
    expect(p.sys.align).toBe(0);
  });
});

describe('piston engine', () => {
  const powered = () => { const p = createPilot(cfg('c172', 'study')); setControl(p, 'batt', 1); setControl(p, 'alt', 1); return p; };
  it('will not start without priming, starts after priming', () => {
    const p = powered();
    setControl(p, 'mixture', 1); setControl(p, 'throttle', 0.1);
    setControl(p, 'magnetos', 4);
    run(p, 6);
    expect(p.eng[0].running).toBe(false);
    setControl(p, 'pumpAux', 1);
    run(p, 3);
    setControl(p, 'magnetos', 4);
    until(p, () => p.eng[0].running, 8, 'engine start');
    expect(p.sw.magnetos).toBe(3);
  });
  it('magneto check drops RPM, mixture cut-off and magnetos off stop the engine', () => {
    const p = createPilot(cfg('c172', 'standard', { assists: { ...ASSIST_PRESETS.study, start: 'running' } }));
    setControl(p, 'throttle', 0.45);
    run(p, 5);
    const both = p.eng[0].rpm;
    setControl(p, 'magnetos', 1);
    run(p, 3);
    expect(both - p.eng[0].rpm).toBeGreaterThan(30);
    expect(both - p.eng[0].rpm).toBeLessThan(250);
    expect(p.flags.magR).toBe(1);
    setControl(p, 'magnetos', 3);
    setControl(p, 'mixture', 0);
    run(p, 2);
    expect(p.eng[0].running).toBe(false);
  });
  it('too rich a mixture at altitude costs power; leaning restores it', () => {
    const p = createPilot(cfg('c172', 'standard', { kind: 'approach', destId: 'LGA' }));
    p.ac.z = 2600; // about 8500 ft
    setControl(p, 'throttle', 1);
    setControl(p, 'mixture', 1);
    run(p, 3);
    const rich = p.eng[0].thrust;
    setControl(p, 'mixture', 0.65);
    run(p, 3);
    expect(p.eng[0].thrust).toBeGreaterThan(rich * 1.05);
  });
});

describe('flight model', () => {
  it('stall speeds are in a believable range', () => {
    expect(stallKt(ACDEF.c172, 1100, 0)).toBeGreaterThan(45);
    expect(stallKt(ACDEF.c172, 1100, 3)).toBeLessThan(48);
    expect(stallKt(ACDEF.jet, 62000, 4)).toBeGreaterThan(95);
    expect(stallKt(ACDEF.jet, 62000, 4)).toBeLessThan(120);
  });
  it('holding the nose up without power ends in a stall warning; protection prevents the stall', () => {
    const fly = (protection: boolean) => {
      const p = createPilot(cfg('c172', 'study', { kind: 'approach', destId: 'LGA' }));
      p.cfg.assists.protection = protection;
      p.cfg.assists.forgiving = true;
      p.ac.z += 900;
      setControl(p, 'throttle', 0);
      run(p, 25, { pitch: 1, roll: 0, yaw: 0, brake: 0 });
      return p;
    };
    const raw = fly(false);
    expect(raw.findings.some((f) => /Stall warning/.test(f.text))).toBe(true);
    const prot = fly(true);
    expect(prot.ac.stalled).toBe(false);
  });
  it('is speed-stable: trimmed flight returns toward its trim speed', () => {
    const p = createPilot(cfg('c172', 'study', { kind: 'approach', destId: 'LGA' }));
    p.ac.z += 1500;
    run(p, 60);
    const v = p.ac.ias;
    expect(v).toBeGreaterThan(60);
    expect(v).toBeLessThan(120);
    expect(Math.abs(p.ac.bank)).toBeLessThan(10);
  });
  it('aileron rolls, bank turns the aircraft', () => {
    const p = createPilot(cfg('jet', 'study', { kind: 'approach', destId: 'JFK' }));
    p.ac.z += 2000;
    const h0 = p.ac.hdg;
    run(p, 2, { pitch: 0, roll: 0.5, yaw: 0, brake: 0 });
    expect(p.ac.bank).toBeGreaterThan(8);
    run(p, 6, { pitch: 0.15, roll: 0, yaw: 0, brake: 0 });
    expect(((p.ac.hdg - h0 + 540) % 360) - 180).toBeGreaterThan(3);
  });
  it('a wrong altimeter setting shows a wrong altitude', () => {
    const p = createPilot(cfg('jet', 'standard'));
    setControl(p, 'baroQnh', 1);
    const good = indicatedAlt(p);
    expect(Math.abs(good - p.airports[0].ap.elevation)).toBeLessThan(5);
    setControl(p, 'baro', p.radios.baro + 10);
    expect(indicatedAlt(p) - good).toBeGreaterThan(200);
  });
  it('gear lever is locked on the ground and reverse in the air', () => {
    const p = createPilot(cfg('jet', 'standard'));
    expect(setControl(p, 'gear', 0)).not.toBe('');
    const a = createPilot(cfg('jet', 'standard', { kind: 'approach', destId: 'JFK' }));
    expect(setControl(a, 'reverse', 1)).not.toBe('');
  });
  it('takeoff with the wrong configuration triggers the config warning', () => {
    const p = createPilot(cfg('jet', 'standard', { assists: { ...ASSIST_PRESETS.study, start: 'runway' } }));
    setControl(p, 'flaps', 0);
    setControl(p, 'parkBrake', 0);
    setControl(p, 'throttle', 0.9);
    run(p, 6);
    expect(p.findings.some((f) => /configuration warning/.test(f.text))).toBe(true);
  });
});

describe('autopilot', () => {
  it('cannot be engaged on the ground', () => {
    const p = createPilot(cfg('jet', 'simplified'));
    expect(apButton(p, 'cmd')).toMatch(/ground/);
  });
  it('holds altitude and a selected heading', () => {
    const p = createPilot(cfg('jet', 'study', { kind: 'approach', destId: 'JFK' }));
    p.ac.z += 1500;
    p.ap.at = true;
    expect(apButton(p, 'cmd')).toBe('');
    apButton(p, 'alt');
    apButton(p, 'hdg');
    expect(p.ap.lat).toBe('hdg');
    const tgt = (Math.round(p.ac.hdg) + 40) % 360;
    setControl(p, 'selHdg', tgt);
    const alt = p.ap.selAlt;
    run(p, 70);
    expect(p.ap.cmd).toBe(true);
    expect(Math.abs(indicatedAlt(p) - alt)).toBeLessThan(120);
    expect(Math.abs(((p.ac.hdg - tgt + 540) % 360) - 180)).toBeLessThan(4);
    expect(Math.abs(p.ac.ias - p.ap.selSpd)).toBeLessThan(12);
  });
  it('climbs to a selected altitude in level change and captures it', () => {
    const p = createPilot(cfg('jet', 'study', { kind: 'approach', destId: 'JFK' }));
    p.ap.at = true;
    apButton(p, 'cmd');
    setControl(p, 'selAlt', p.ap.selAlt + 2000);
    setControl(p, 'selSpd', 190);
    apButton(p, 'flch');
    const tgt = p.ap.selAlt;
    run(p, 12);
    expect(fpm(p)).toBeGreaterThan(500);
    until(p, () => p.ap.vert === 'alt', 120, 'altitude capture');
    run(p, 20);
    expect(Math.abs(indicatedAlt(p) - tgt)).toBeLessThan(150);
  });
  it('a big control input disconnects it', () => {
    const p = createPilot(cfg('jet', 'study', { kind: 'approach', destId: 'JFK' }));
    apButton(p, 'cmd');
    run(p, 1, { pitch: 0.9, roll: 0, yaw: 0, brake: 0 });
    expect(p.ap.cmd).toBe(false);
  });
});

describe('ATC from the flight deck', () => {
  it('walks the clearance chain: IFR clearance, pushback, taxi', () => {
    const p = createPilot(cfg('jet', 'standard', { depId: 'ATL', destId: 'REG' }));
    p.cfg.assists.autoSystems = false;
    expect(atcRequests(p).map((r) => r.id)).toContain('ifr');
    atcRequest(p, 'ifr');
    until(p, () => p.atc.clearedIfr, 15, 'IFR clearance');
    expect(p.atc.squawk).toBeGreaterThan(0);
    expect(p.atc.alt).toBeGreaterThan(0);
    expect(atcRequests(p).map((r) => r.id)).toContain('push');
    atcRequest(p, 'push');
    until(p, () => p.atc.clearedPush, 15, 'push clearance');
    setControl(p, 'parkBrake', 0);
    until(p, () => !!p.push?.done, 120, 'pushback complete');
    expect(surfaceAt(p, p.ac.x, p.ac.y).kind).not.toBe('grass');
    atcRequest(p, 'taxi');
    until(p, () => p.atc.clearedTaxi, 15, 'taxi clearance');
    expect(p.atc.log.some((m) => m.from === 'atc' && /taxi/.test(m.text))).toBe(true);
  });
  it('with strict radios ATC only answers on the right frequency', () => {
    const p = createPilot(cfg('jet', 'study', { depId: 'ATL', destId: 'REG' }));
    setControl(p, 'batt', 1);
    run(p, 1);
    p.radios.com.act = 118.0;
    atcRequest(p, 'ifr');
    run(p, 10);
    expect(p.atc.clearedIfr).toBe(false);
    expect(p.atc.log.some((m) => /No reply/.test(m.text))).toBe(true);
    p.radios.com.act = p.atc.freq;
    atcRequest(p, 'ifr');
    until(p, () => p.atc.clearedIfr, 15, 'clearance on frequency');
  });
  it('taking off without a clearance is recorded as a deviation', () => {
    const p = createPilot(cfg('c172', 'standard', { assists: { ...ASSIST_PRESETS.study, start: 'runway', autoRudder: true } }));
    p.atc.clearedTakeoff = false;
    p.atc.clearedLineup = false;
    setControl(p, 'parkBrake', 0);
    setControl(p, 'throttle', 1);
    run(p, 25);
    expect(p.findings.some((f) => /without a takeoff clearance/.test(f.text))).toBe(true);
  });
});

describe('checklists', () => {
  it('items are verified against the aircraft state', () => {
    const p = createPilot(cfg('jet', 'study'));
    const pre = checklistsFor(p).find((c) => c.id === 'preflight')!;
    const batt = pre.items.find((i) => i.ctl === 'batt')!;
    expect(batt.ok(p)).toBe(false);
    setControl(p, 'batt', 1);
    expect(batt.ok(p)).toBe(true);
    expect(activeChecklists(p).map((c) => c.id)).toContain('preflight');
  });
  it('the first officer completes the flows through to engines running', () => {
    for (const k of ['c172', 'jet'] as const) {
      const p = createPilot(cfg(k, 'study', { depId: 'ATL', destId: 'REG' }));
      p.cfg.assists.autoSystems = true;
      p.cfg.assists.autoRadio = true;
      until(p, () => p.eng.every((e) => e.running) && p.atc.clearedTaxi, 420, `${k} flows to taxi clearance`);
      expect(missedItems(p, k === 'jet' ? 'start' : 'preflight').filter((i) => i.ctl !== 'atc')).toEqual([]);
      expect(p.findings.filter((f) => f.pts < 0)).toEqual([]);
    }
  });
  it('skipping the checklists is penalised in the debrief', () => {
    const p = createPilot(cfg('jet', 'standard', { assists: { ...ASSIST_PRESETS.study, start: 'runway' } }));
    setControl(p, 'ltLanding', 0);
    setControl(p, 'ltStrobe', 0);
    setControl(p, 'parkBrake', 0);
    setControl(p, 'throttle', 0.95);
    until(p, () => p.phase === 'takeoff', 20, 'takeoff roll');
    expect(p.findings.some((f) => f.cat === 'procedure' && /Before takeoff/.test(f.text))).toBe(true);
    expect(debrief(p).cats.find((c) => c.id === 'procedure')!.score).toBeLessThan(100);
  });
});

describe('landing score', () => {
  it('grades touchdowns', () => {
    const p = createPilot(cfg('jet', 'standard', { kind: 'approach', destId: 'JFK' }));
    const base = { ias: p.vspeeds.vref + 3, vref: p.vspeeds.vref, offset: 1, dist: 450, pitch: 5, bank: 0, crab: 1, g: 1.2, rwy: p.arrRwy.name, offRunway: false };
    expect(scoreLanding(p, { ...base, fpm: 150 }).score).toBeGreaterThanOrEqual(90);
    expect(scoreLanding(p, { ...base, fpm: 700 }).score).toBeLessThan(60);
    expect(scoreLanding(p, { ...base, fpm: 150, dist: 1900, ias: p.vspeeds.vref + 25 }).score).toBeLessThan(75);
    expect(scoreLanding(p, { ...base, fpm: 150, offRunway: true }).score).toBeLessThan(45);
  });
});

describe('complete flights flown by the instructor', () => {
  const flight = (c: PilotConfig, maxMin: number) => {
    const p = createPilot(c);
    setInstructor(p, true);
    run(p, maxMin * 60);
    return p;
  };
  const good = (p: PilotState, n = 1) => {
    expect(p.ac.crashed).toBeNull();
    expect(p.phase).toBe('complete');
    expect(p.landings.length).toBe(n);
    const def = ACDEF[p.cfg.aircraft];
    for (const l of p.landings) {
      expect(l.offRunway).toBe(false);
      expect(l.fpm).toBeLessThan(def.hardFpm * 0.6);
      expect(Math.abs(l.offset)).toBeLessThan(10);
      expect(l.dist).toBeGreaterThan(0);
      expect(l.dist).toBeLessThan(p.arrRwy.length * 0.45);
    }
    expect(p.findings.filter((f) => f.cat === 'safety')).toEqual([]);
    expect(p.findings.filter((f) => f.cat === 'atc')).toEqual([]);
    expect(debrief(p).overall).toBeGreaterThan(80);
  };
  it('trainer, cold and dark, LGA to JFK, gate to gate', () => good(flight(cfg('c172', 'study'), 50)), 120000);
  it('jet, cold and dark, Atlanta to the regional field, gate to gate', () => {
    const p = flight(cfg('jet', 'study', { depId: 'ATL', destId: 'REG' }), 70);
    good(p);
    expect(p.atc.log.filter((m) => m.from === 'atc').length).toBeGreaterThan(8);
    expect(p.distFlown / 1852).toBeGreaterThan(80);
  }, 180000);
  it('jet approach in low visibility and a breezy trainer approach', () => {
    good(flight(cfg('jet', 'standard', { kind: 'approach', depId: 'LAX', destId: 'LAX', weather: 'lowvis' }), 20));
    good(flight(cfg('c172', 'standard', { kind: 'approach', depId: 'REG', destId: 'REG', weather: 'breezy' }), 20));
  }, 120000);
  it('trainer traffic pattern with touch-and-goes', () => good(flight(cfg('c172', 'simplified', { kind: 'pattern', depId: 'REG', destId: 'REG' }), 40), 3), 120000);
});
