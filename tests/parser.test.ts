/** Topic 2: typed-command parsing and clearance validation errors. */
import { describe, expect, it } from 'vitest';
import { getAirport } from '../src/sim/airport';
import { parseCommand, ParseError } from '../src/sim/parse';
import { spawnArrival } from '../src/sim/traffic';
import { mkSim, readyDeparture } from './helpers';

const ap = getAirport({ airportId: 'ATL' });
const known = ['DAL1426', 'UAL892', 'DAL892X'];
const p = (text: string) => parseCommand(ap, text, known);

describe('parseCommand: documented example phraseology (ATL)', () => {
  const cases: [string, string, unknown[]][] = [
    ['DAL1426 PUSHBACK APPROVED', 'DAL1426', [{ t: 'PUSHBACK' }]],
    ['DAL1426 TAXI VIA B M HOLD SHORT 27R', 'DAL1426', [{ t: 'TAXI', via: ['B', 'M'], holdShort: '27R', rwy: '27R' }]],
    ['DAL1426 LINE UP WAIT 27R', 'DAL1426', [{ t: 'LINE_UP', rwy: '27R' }]],
    ['DAL1426 CLEARED TAKEOFF 27R', 'DAL1426', [{ t: 'TAKEOFF', rwy: '27R' }]],
    ['UAL892 HEADING 240', 'UAL892', [{ t: 'HEADING', hdg: 240 }]],
    ['UAL892 DESCEND 4000', 'UAL892', [{ t: 'ALTITUDE', alt: 4000 }]],
    ['UAL892 SPEED 180', 'UAL892', [{ t: 'SPEED', spd: 180 }]],
    ['UAL892 CLEARED ILS 26L', 'UAL892', [{ t: 'APPROACH', rwy: '26L' }]],
    ['UAL892 CLEARED LAND 26L', 'UAL892', [{ t: 'LAND', rwy: '26L' }]],
    ['UAL892 GO AROUND', 'UAL892', [{ t: 'GO_AROUND' }]],
    ['UAL892 TAXI GATE C12 VIA N B', 'UAL892', [{ t: 'TAXI', gate: 'C12', via: ['N', 'B'] }]],
  ];
  it.each(cases)('%s', (text, callsign, cmds) => {
    const r = p(text);
    expect(r.callsign).toBe(callsign);
    expect(r.cmds).toHaveLength(cmds.length);
    r.cmds.forEach((c, i) => expect(c).toMatchObject(cmds[i] as object));
  });

  it('is case-insensitive, tolerates punctuation and chains several instructions', () => {
    const r = p('ual892 descend 4000, heading 240; speed 180.');
    expect(r.cmds.map((c) => c.t)).toEqual(['ALTITUDE', 'HEADING', 'SPEED']);
    expect(p('UAL892 TURN LEFT HEADING 090').cmds[0]).toMatchObject({ t: 'HEADING', hdg: 90, dir: 'L' });
    expect(p('UAL892 HEADING 360').cmds[0]).toMatchObject({ t: 'HEADING', hdg: 0 });
    expect(p('UAL892 CLIMB FL120').cmds[0]).toMatchObject({ t: 'ALTITUDE', alt: 12000 });
    expect(p('UAL892 DESCEND 40').cmds[0]).toMatchObject({ t: 'ALTITUDE', alt: 4000 });
  });

  it('normalises runway names ("8L" → "08L") and accepts common variants', () => {
    expect(p('UAL892 CLEARED ILS 8L').cmds[0]).toMatchObject({ t: 'APPROACH', rwy: '08L' });
    expect(p('UAL892 CLEARED TO LAND RUNWAY 26L').cmds[0]).toMatchObject({ t: 'LAND', rwy: '26L' });
    expect(p('DAL1426 CLEARED FOR TAKEOFF').cmds[0]).toMatchObject({ t: 'TAKEOFF' });
    expect(p('DAL1426 CROSS 26L').cmds[0]).toMatchObject({ t: 'CROSS', rwy: '26L' });
    expect(p('DAL1426 HOLD POSITION').cmds[0]).toMatchObject({ t: 'HOLD_POSITION' });
    expect(p('DAL1426 CANCEL TAKEOFF CLEARANCE').cmds[0]).toMatchObject({ t: 'CANCEL_TAKEOFF' });
    expect(p('DAL1426 PUSHBACK APPROVED FACE EAST').cmds[0]).toMatchObject({ t: 'PUSHBACK', face: 'E' });
    expect(p('DAL1426 CLEARED AS FILED').cmds[0]).toMatchObject({ t: 'DEP_CLEARANCE' });
    expect(p('UAL892 DIRECT LOGEN').cmds[0]).toMatchObject({ t: 'DIRECT', fix: 'LOGEN' });
    expect(p('UAL892 HOLD LOGEN').cmds[0]).toMatchObject({ t: 'HOLD', fix: 'LOGEN' });
    expect(p('UAL892 TOW').cmds[0]).toMatchObject({ t: 'TOW' });
  });

  it('"RUNWAY 27R" prefix applies to the following clearance; "VIA B AND M" is accepted', () => {
    expect(p('DAL1426 RUNWAY 27R CLEARED TAKEOFF').cmds).toEqual([expect.objectContaining({ t: 'TAKEOFF', rwy: '27R' })]);
    expect(p('DAL1426 RUNWAY 27R LINE UP WAIT').cmds).toEqual([expect.objectContaining({ t: 'LINE_UP', rwy: '27R' })]);
    expect(p('UAL892 RUNWAY 26L CLEARED LAND').cmds).toEqual([expect.objectContaining({ t: 'LAND', rwy: '26L' })]);
    expect(p('DAL1426 TAXI 27R VIA B AND M').cmds[0]).toMatchObject({ t: 'TAXI', rwy: '27R', via: ['B', 'M'] });
    expect(p('UAL892 EXPECT 26L').cmds[0]).toMatchObject({ t: 'ASSIGN_RUNWAY', rwy: '26L' });
  });

  it('accepts a unique flight-number shorthand and rejects ambiguous ones', () => {
    expect(p('1426 PUSHBACK APPROVED').callsign).toBe('DAL1426');
    expect(() => parseCommand(ap, '892 GO AROUND', ['UAL892', 'DAL892'])).toThrow(/ambiguous/i);
  });
});

describe('parseCommand: error cases', () => {
  const bad = (text: string, re: RegExp) => {
    let err: unknown;
    try { p(text); } catch (e) { err = e; }
    expect(err, `"${text}" should not parse`).toBeInstanceOf(ParseError);
    expect((err as Error).message).toMatch(re);
  };
  it('unknown callsign', () => bad('XYZ999 HEADING 240', /unknown callsign/i));
  it('nonexistent runway', () => {
    bad('UAL892 CLEARED ILS 36', /runway 36 does not exist/i);
    bad('DAL1426 CLEARED TAKEOFF 99', /runway 99 does not exist/i);
    bad('DAL1426 CROSS 18C', /does not exist/i);
  });
  it('nonexistent gate', () => {
    bad('UAL892 TAXI GATE Z99', /gate Z99 does not exist/i);
    bad('UAL892 GATE Q1', /gate Q1 does not exist/i);
  });
  it('garbage text', () => {
    bad('DAL1426 FLIBBERTIGIBBET', /did not understand/i);
    bad('DAL1426 PLEASE THE', /no instruction/i);
    bad('DAL1426', /callsign followed by an instruction/i);
    bad('', /callsign followed by an instruction/i);
  });
  it('missing or invalid values', () => {
    bad('UAL892 HEADING', /heading needs a value/i);
    bad('UAL892 HEADING 400', /between 001 and 360/i);
    bad('UAL892 DESCEND SOON', /altitude needs a value/i);
    bad('UAL892 SPEED FAST', /speed needs a value/i);
    bad('UAL892 CLEARED ILS', /needs a runway/i);
    bad('DAL1426 CROSS', /cross needs a runway/i);
    bad('DAL1426 TAXI VIA', /at least one taxiway/i);
  });
});

describe('Sim.commandText: validation errors come back as messages, never exceptions', () => {
  const sim = mkSim('ATL', { configName: 'West flow' });
  const dal = readyDeparture(sim, 'B18', { callsign: 'DAL1426' });
  const ual = spawnArrival(sim, { airline: 'UAL', type: 'B738', callsign: 'UAL892', fix: 'LOGEN', distNm: 20, alt: 8000 })!;
  const fail = (text: string, re: RegExp) => {
    const r = sim.commandText(text);
    expect(r.ok, `"${text}" should be rejected`).toBe(false);
    expect(r.message ?? '').toMatch(re);
  };
  it('has the two scripted aircraft', () => {
    expect(dal.callsign).toBe('DAL1426');
    expect(ual.callsign).toBe('UAL892');
  });
  it('empty / garbage / unknown callsign', () => {
    fail('', /empty/i);
    fail('asdf qwer zxcv', /unknown callsign/i);
    fail('DAL1426 ASDF', /did not understand/i);
    fail('SWA1 HEADING 240', /unknown callsign/i);
  });
  it('nonexistent runway, gate, taxiway and fix', () => {
    fail('UAL892 CLEARED ILS 36', /runway 36 does not exist/i);
    fail('UAL892 TAXI GATE Z99', /gate Z99 does not exist/i);
    fail('UAL892 DIRECT NOWHR', /unknown fix NOWHR/i);
    fail('UAL892 HOLD ZZZZZ', /did not understand|unknown fix/i);
    fail('RWY 36 CLOSE', /does not exist/i);
  });
  it('nonexistent taxiway in a taxi route', () => {
    const s2 = mkSim('ATL', { configName: 'West flow' });
    const a = readyDeparture(s2, 'B18', { callsign: 'DAL1426' });
    expect(s2.commandText('DAL1426 CLEARED AS FILED, PUSHBACK APPROVED').ok).toBe(true);
    for (let i = 0; i < 300 && a.phase !== 'push_done'; i++) s2.advance(1);
    expect(a.phase).toBe('push_done');
    const r = s2.commandText('DAL1426 TAXI 27R VIA QQ M');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/taxiway QQ does not exist/i);
    expect(a.phase).toBe('push_done');
  });
  it('out-of-range values', () => {
    fail('UAL892 DESCEND 1000', /minimum vectoring altitude/i);
    fail('UAL892 CLIMB 30000', /airspace tops out/i);
    fail('UAL892 DESCEND 4050', /hundreds of feet/i);
    fail('UAL892 SPEED 50', /between 100 and 290/i);
  });
  it('rejected commands are counted and change nothing', () => {
    const before = sim.s.stats.rejectedCommands;
    const snap = JSON.stringify(ual);
    fail('UAL892 DESCEND 1000', /minimum/i);
    expect(sim.s.stats.rejectedCommands).toBe(before + 1);
    expect(JSON.stringify(ual)).toBe(snap);
    expect(sim.s.pending.filter((x) => x.ac === ual.id)).toHaveLength(0);
  });
});
