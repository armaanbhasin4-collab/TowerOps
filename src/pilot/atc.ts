/**
 * Air traffic control as heard from the flight deck. A scripted controller chain (clearance
 * delivery → ground → tower → departure → centre → approach → tower → ground) answers the
 * pilot's requests, issues altitudes and handoffs, and watches for pilot deviations.
 *
 * It is a single-aircraft script: there is no other traffic to be sequenced behind, so clearances
 * are always available. Frequencies are synthetic.
 */
import { FT, KT, NM, alongCross, angDiff, dist, hdgOf, rand } from '../sim/util';
import { ACDEF } from './aircraft';
import { indicatedAlt, isJet } from './systems';
import { approachWps, planTaxiIn, runwayStripAt } from './world';
import type { AtcRequest, AtcStage, PilotState, PlacedAirport } from './types';

const f2 = (f: number) => f.toFixed(2);
const altSay = (ft: number) => (ft >= 18000 ? `flight level ${Math.round(ft / 100)}` : `${ft.toLocaleString('en-US')}`);
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const compass = (brg: number) => COMPASS[Math.round(brg / 45) % 8];

const depAp = (p: PilotState): PlacedAirport => p.airports[p.depRwy.apIdx];
const arrAp = (p: PilotState): PlacedAirport => p.airports[p.arrRwy.apIdx];
const vfr = (p: PilotState) => !isJet(p);
const windSay = (pa: PlacedAirport) => `wind ${String(pa.wind.dir).padStart(3, '0')} at ${pa.wind.kt}`;
const distToArr = (p: PilotState) => dist(p.ac.x, p.ac.y, p.arrRwy.thrX, p.arrRwy.thrY) / NM;
const distFromDep = (p: PilotState) => dist(p.ac.x, p.ac.y, depAp(p).ox, depAp(p).oy) / NM;

export function sys(p: PilotState, text: string) {
  p.atc.log.push({ t: p.t, from: 'sys', text });
}

function setStage(p: PilotState, stage: AtcStage) {
  const a = p.atc;
  a.stage = stage;
  const d = depAp(p), r = arrAp(p);
  const map: Partial<Record<AtcStage, [string, number]>> = {
    clearance: [`${d.ap.facility} Clearance`, d.freq.clearance],
    push: [`${d.ap.facility} Ground`, d.freq.ground],
    taxi: [`${d.ap.facility} Ground`, d.freq.ground],
    tower_dep: [`${d.ap.facility} Tower`, d.freq.tower],
    lineup: [`${d.ap.facility} Tower`, d.freq.tower],
    takeoff: [`${d.ap.facility} Tower`, d.freq.tower],
    departure: [`${d.ap.facility} Departure`, d.freq.departure],
    center: [vfr(p) ? 'Flight following' : 'Center', Math.round((132 + (p.rng % 30) * 0.1) * 20) / 20],
    approach: [`${r.ap.facility} Approach`, r.freq.approach],
    tower_arr: [`${r.ap.facility} Tower`, r.freq.tower],
    landing: [`${r.ap.facility} Tower`, r.freq.tower],
    ground_arr: [`${r.ap.facility} Ground`, r.freq.ground],
  };
  const m = map[stage];
  if (m) { a.station = m[0]; a.freq = m[1]; }
  a.foDelay = 3 + rand(p) * 3;
  if (p.cfg.assists.autoRadio || !p.cfg.assists.strictRadio) p.radios.com.act = a.freq;
}

/** ATC transmits after a short delay; `fx` is applied when the message is received */
function atcSay(p: PilotState, text: string, fx?: string, rb?: string, delay = 2.5) {
  p.atc.queue.push({ due: p.t + delay + rand(p) * 1.5, station: p.atc.station, text: `${p.radioName}, ${text}`, fx, rb });
}

export function initAtc(p: PilotState) {
  const a = p.atc;
  const s = p.cfg.assists.start;
  if (p.cfg.kind === 'approach' || s === 'final') {
    setStage(p, 'tower_arr');
    a.clearedIfr = a.clearedPush = a.clearedTaxi = a.clearedLineup = a.clearedTakeoff = a.clearedApproach = true;
    a.flags.needCheckin = 1;
    return;
  }
  if (s === 'runway') {
    setStage(p, 'takeoff');
    a.clearedIfr = a.clearedPush = a.clearedTaxi = a.clearedLineup = a.clearedTakeoff = true;
    a.alt = initialAlt(p);
    a.squawk = vfr(p) ? 1200 : 4200 + (p.rng % 500);
    p.radios.xpdr.code = a.squawk;
    a.log.push({ t: p.t, from: 'atc', station: a.station, text: `${p.radioName}, ${windSay(depAp(p))}, runway ${p.depRwy.name}, cleared for takeoff.${p.cfg.kind === 'pattern' ? ' Make left closed traffic.' : vfr(p) ? '' : ` Climb and maintain ${altSay(a.alt)}.`}` });
    return;
  }
  if (vfr(p)) { setStage(p, 'taxi'); a.clearedIfr = true; a.clearedPush = true; a.squawk = 1200; }
  else if (s === 'running') { setStage(p, 'taxi'); a.clearedIfr = true; a.clearedPush = true; a.alt = initialAlt(p); a.squawk = 4200 + (p.rng % 500); p.radios.xpdr.code = a.squawk; }
  else setStage(p, 'clearance');
}

export function initialAlt(p: PilotState): number {
  if (p.cfg.kind === 'pattern') return p.route[0].alt ?? 1500;
  if (vfr(p)) return p.cruiseAlt;
  return Math.min(p.cruiseAlt, Math.ceil((depAp(p).ap.elevation + 3500) / 1000) * 1000);
}

/** requests the pilot can make right now */
export function atcRequests(p: PilotState): AtcRequest[] {
  const a = p.atc, cs = p.radioName, d = depAp(p), r = arrAp(p);
  const out: AtcRequest[] = [];
  const dest = r.ap.icao;
  switch (a.stage) {
    case 'clearance':
      if (!a.clearedIfr) out.push({ id: 'ifr', label: 'Request IFR clearance', say: `${d.ap.facility} Clearance, ${cs}, gate ${p.depGate}, request IFR clearance to ${dest}.` });
      break;
    case 'push':
      if (!a.clearedPush) out.push({ id: 'push', label: 'Request pushback', say: `${d.ap.facility} Ground, ${cs}, gate ${p.depGate}, request pushback.` });
      else out.push({ id: 'taxi', label: 'Request taxi', say: `${d.ap.facility} Ground, ${cs}, ready to taxi.` });
      break;
    case 'taxi':
      if (!a.clearedTaxi) out.push({ id: 'taxi', label: 'Request taxi', say: vfr(p) ? `${d.ap.facility} Ground, ${cs}, at ${p.depGate}, ${p.cfg.kind === 'pattern' ? 'request taxi for closed traffic' : `VFR to ${dest}, request taxi`}.` : `${d.ap.facility} Ground, ${cs}, ready to taxi.` });
      break;
    case 'tower_dep':
    case 'lineup':
      if (!a.clearedTakeoff) out.push({ id: 'ready', label: 'Report ready for departure', say: `${d.ap.facility} Tower, ${cs}, holding short runway ${p.depRwy.name}, ready for departure.` });
      break;
    case 'takeoff':
      if (p.cfg.kind === 'pattern' && !p.ac.onGround && (p.phase === 'approach' || p.phase === 'landing')) out.push({ id: 'goaround', label: 'Report going around', say: `${cs}, going around.` });
      if (p.cfg.kind === 'pattern' && !a.clearedLand && !p.ac.onGround) out.push({ id: 'option', label: 'Request the option (downwind)', say: `${cs}, left downwind runway ${p.arrRwy.name}, request the option.` });
      break;
    case 'departure':
    case 'center':
    case 'approach':
      if (a.flags.needCheckin) out.push({ id: 'checkin', label: `Check in with ${a.station}`, say: `${a.station}, ${cs}, ${Math.abs(p.ac.vs) > 2.5 ? `passing ${altSay(Math.round(indicatedAlt(p) / 100) * 100)} ${p.ac.vs > 0 ? 'climbing' : 'descending'} ${altSay(p.ap.selAlt || a.alt)}` : `level ${altSay(Math.round(indicatedAlt(p) / 100) * 100)}`}.` });
      break;
    case 'tower_arr':
    case 'landing':
      if (a.flags.needCheckin) {
        const brg = hdgOf(p.ac.x - r.ox, p.ac.y - r.oy);
        out.push({ id: 'final', label: `Call ${a.station}`, say: vfr(p) ? `${r.ap.facility} Tower, ${cs}, ${Math.max(1, Math.round(distToArr(p)))} miles ${compass(brg)}, inbound for landing runway ${p.arrRwy.name}.` : `${r.ap.facility} Tower, ${cs}, ILS runway ${p.arrRwy.name}.` });
      }
      if (!p.ac.onGround) out.push({ id: 'goaround', label: 'Report going around', say: `${cs}, going around.` });
      break;
    case 'ground_arr':
      if (!a.clearedTaxiIn) out.push({ id: 'taxi_in', label: 'Request taxi to the gate', say: `${r.ap.facility} Ground, ${cs}, clear of runway ${p.arrRwy.name}, request taxi to ${vfr(p) ? 'parking' : 'the gate'}.` });
      break;
  }
  if (a.log.some((m) => m.from === 'atc')) out.push({ id: 'again', label: 'Say again', say: `${cs}, say again.` });
  return out;
}

const tuned = (p: PilotState) => !p.cfg.assists.strictRadio || Math.abs(p.radios.com.act - p.atc.freq) < 0.011;

/** the pilot (or first officer) transmits a request */
export function atcRequest(p: PilotState, id: string, from: 'me' | 'fo' = 'me'): string {
  const a = p.atc;
  const req = atcRequests(p).find((r) => r.id === id);
  if (!req) return 'that request is not available right now';
  if (!p.sys.bus || (!isJet(p) && !p.sys.avionics)) return 'the radios have no power';
  a.log.push({ t: p.t, from, text: req.say });
  if (!tuned(p)) { sys(p, `No reply. COM1 is on ${f2(p.radios.com.act)}; ${a.station} is on ${f2(a.freq)}.`); return ''; }
  const d = depAp(p), r = arrAp(p);
  switch (id) {
    case 'ifr': {
      const init = initialAlt(p), code = 4200 + (p.rng % 500);
      a.flags.code = code;
      a.flags.init = init;
      atcSay(p, `cleared to ${r.ap.name} via radar vectors then as filed. Runway ${p.depRwy.name}. Climb and maintain ${altSay(init)}, expect ${altSay(p.cruiseAlt)} ten minutes after departure. Departure frequency ${f2(d.freq.departure)}. Squawk ${code}.`, 'ifr', `Cleared to ${r.ap.icao}, runway ${p.depRwy.name}, ${altSay(init)}, departure ${f2(d.freq.departure)}, squawk ${code}`, 4);
      break;
    }
    case 'push':
      atcSay(p, `pushback approved, expect runway ${p.depRwy.name}.`, 'push', 'Push approved');
      break;
    case 'taxi': {
      const via = p.taxi?.names.length ? ` via ${[...new Set(p.taxi.names)].slice(0, 6).join(', ')}` : '';
      const cross = p.taxi?.crosses.length ? `, cross runway ${p.taxi.crosses.map((c) => c.split('/')[0]).join(' and ')}` : '';
      const extra = vfr(p) ? ` Altimeter ${d.qnh}.${p.cfg.kind === 'pattern' ? '' : ' Squawk VFR.'}` : '';
      atcSay(p, `runway ${p.depRwy.name}, taxi${via}${cross}.${extra}`, 'taxi', `Runway ${p.depRwy.name}${via}${cross}`);
      break;
    }
    case 'ready': {
      const tail = p.cfg.kind === 'pattern' ? ' Make left closed traffic.' : vfr(p) ? ' On-course heading approved.' : '';
      if (rand(p) < 0.35) {
        atcSay(p, `runway ${p.depRwy.name}, line up and wait.`, 'lineup', `Line up and wait runway ${p.depRwy.name}`);
        p.atc.queue.push({ due: p.t + 22 + rand(p) * 14, station: a.station, text: `${p.radioName}, ${windSay(d)}, runway ${p.depRwy.name}, cleared for takeoff.${tail}`, fx: 'takeoff', rb: `Cleared for takeoff runway ${p.depRwy.name}` });
      } else atcSay(p, `${windSay(d)}, runway ${p.depRwy.name}, cleared for takeoff.${tail}`, 'takeoff', `Cleared for takeoff runway ${p.depRwy.name}`);
      break;
    }
    case 'checkin': {
      a.flags.needCheckin = 0;
      if (a.stage === 'departure') {
        if (vfr(p)) atcSay(p, `radar contact. Altitude your discretion, altimeter ${d.qnh}.`, undefined, 'Roger');
        else atcSay(p, `radar contact. Climb and maintain ${altSay(p.cruiseAlt)}, proceed on course.`, 'cruiseAlt', `Climb and maintain ${altSay(p.cruiseAlt)}`);
      } else if (a.stage === 'center') {
        if (a.alt < p.cruiseAlt && !a.flags.descending) atcSay(p, `radar contact, climb and maintain ${altSay(p.cruiseAlt)}.`, 'cruiseAlt', `Climb and maintain ${altSay(p.cruiseAlt)}`);
        else atcSay(p, 'radar contact.', undefined, 'Roger');
      } else {
        const base = baseAlt(p);
        atcSay(p, `radar contact. ${base < indicatedAlt(p) - 300 ? `Descend and maintain ${altSay(base)}. ` : ''}Altimeter ${r.qnh}. Expect ${vfr(p) ? 'a visual' : 'the ILS'} approach runway ${p.arrRwy.name}${vfr(p) ? '' : `, localiser frequency ${f2(p.arrRwy.ilsFreq)}`}.`, 'baseAlt', base < indicatedAlt(p) - 300 ? `Descend and maintain ${altSay(base)}, altimeter ${r.qnh}` : `Altimeter ${r.qnh}`);
      }
      break;
    }
    case 'final':
      a.flags.needCheckin = 0;
      if (vfr(p) && distToArr(p) > 4 && p.cfg.kind !== 'approach') {
        atcSay(p, `${windSay(r)}, altimeter ${r.qnh}. Make straight-in runway ${p.arrRwy.name}, report three mile final.`, 'inbound', `Straight-in runway ${p.arrRwy.name}, will report three mile final`);
        a.flags.report3 = 1;
      } else atcSay(p, `${windSay(r)}, runway ${p.arrRwy.name}, cleared to land.`, 'land', `Cleared to land runway ${p.arrRwy.name}`);
      break;
    case 'option':
      atcSay(p, `${windSay(r)}, runway ${p.arrRwy.name}, cleared for the option.`, 'land', `Cleared for the option runway ${p.arrRwy.name}`);
      break;
    case 'goaround': {
      const alt = Math.round((r.ap.elevation + (isJet(p) ? 3000 : 1500)) / 500) * 500;
      a.flags.gaAlt = alt;
      atcSay(p, `roger, fly runway heading, climb and maintain ${altSay(alt)}. ${p.cfg.kind === 'pattern' || vfr(p) ? 'Make left traffic' : 'Expect vectors'} for runway ${p.arrRwy.name}.`, 'goaround', `Runway heading, ${altSay(alt)}`, 1.5);
      break;
    }
    case 'taxi_in': {
      const t = planTaxiIn(p);
      p.taxi = t;
      const via = t?.names.length ? ` via ${[...new Set(t.names)].slice(0, 6).join(', ')}` : '';
      const cross = t?.crosses.length ? `, cross runway ${t.crosses.map((c) => c.split('/')[0]).join(' and ')}` : '';
      atcSay(p, `taxi to ${vfr(p) ? 'parking' : 'gate'} ${p.arrGate}${via}${cross}.`, 'taxi_in', `${vfr(p) ? 'Parking' : 'Gate'} ${p.arrGate}${via}`);
      break;
    }
    case 'again': {
      const last = [...a.log].reverse().find((m) => m.from === 'atc');
      if (last) a.queue.push({ due: p.t + 2, station: last.station ?? a.station, text: `I say again: ${last.text}` });
      break;
    }
  }
  return '';
}

function baseAlt(p: PilotState): number {
  const w = p.route.find((x) => x.kind === 'base') ?? p.route.find((x) => x.kind === 'final');
  return w?.alt ?? Math.round(arrAp(p).ap.elevation + 3000);
}
function finalAlt(p: PilotState): number {
  return p.route.find((x) => x.kind === 'final')?.alt ?? Math.round(arrAp(p).ap.elevation + 2000);
}

function applyFx(p: PilotState, fx: string) {
  const a = p.atc;
  switch (fx) {
    case 'ifr': a.clearedIfr = true; a.alt = a.flags.init; a.squawk = a.flags.code; setStage(p, 'push'); break;
    case 'push': a.clearedPush = true; break;
    case 'taxi': a.clearedTaxi = true; if (a.stage === 'push') setStage(p, 'taxi'); if (!a.alt) a.alt = initialAlt(p); break;
    case 'lineup': a.clearedLineup = true; setStage(p, 'lineup'); break;
    case 'takeoff': a.clearedLineup = true; a.clearedTakeoff = true; setStage(p, 'takeoff'); break;
    case 'cruiseAlt': a.alt = p.cruiseAlt; break;
    case 'baseAlt': a.alt = Math.min(a.alt || 99999, baseAlt(p)); a.flags.descending = 1; break;
    case 'descend': a.alt = a.flags.descTo; a.flags.descending = 1; break;
    case 'approach': a.clearedApproach = true; a.alt = finalAlt(p); break;
    case 'inbound': a.clearedApproach = true; break;
    case 'land': a.clearedLand = true; a.clearedApproach = true; if (a.stage === 'tower_arr') setStage(p, 'landing'); break;
    case 'goaround': {
      a.clearedLand = false;
      a.alt = a.flags.gaAlt;
      p.ap.locArmed = p.ap.gsArmed = false;
      if (p.ap.lat === 'loc') { p.ap.lat = 'hdg'; p.ap.selHdg = Math.round(p.arrRwy.hdg) % 360; }
      if (p.ap.vert === 'gs') { p.ap.vert = 'flch'; p.ap.selAlt = a.alt; }
      p.flags.goAround = p.t;
      // rebuild the approach from where the aircraft is
      if (p.cfg.kind !== 'pattern') {
        const app = approachWps(p.cfg.aircraft, p.arrRwy, p.ac.x, p.ac.y);
        const keep = p.route.filter((w) => w.kind === 'dep' || w.kind === 'enroute');
        p.route = [...keep, ...app];
        p.leg = keep.length;
      } else { p.leg = 0; p.flags.gatedLanding = 0; }
      a.flags.needCheckin = 0;
      break;
    }
    case 'taxi_in': a.clearedTaxiIn = true; break;
    case 'tower_arr': setStage(p, 'tower_arr'); a.flags.needCheckin = 1; break;
    case 'departure': setStage(p, 'departure'); a.flags.needCheckin = 1; break;
    case 'center': setStage(p, 'center'); a.flags.needCheckin = 1; break;
    case 'approachCtl': setStage(p, 'approach'); a.flags.needCheckin = 1; break;
    case 'ground_arr': setStage(p, 'ground_arr'); break;
    case 'freqChange': setStage(p, 'center'); break;
  }
}

function penalise(p: PilotState, key: string, pts: number, text: string, atcText?: string, cool = 90) {
  if (p.t - (p.atc.flags[key] ?? -1e9) < cool) return;
  p.atc.flags[key] = p.t;
  p.findings.push({ t: p.t, cat: 'atc', pts, text });
  if (atcText) p.atc.queue.push({ due: p.t + 1.5, station: p.atc.station, text: `${p.radioName}, ${atcText}` });
}

/** which request the first officer would make now (autoRadio) */
function foRequest(p: PilotState): string | null {
  const a = p.atc, ac = p.ac;
  const running = p.eng.every((e) => e.running);
  switch (a.stage) {
    case 'clearance': return p.sys.bus && !a.clearedIfr && p.phase !== 'preflight' ? 'ifr' : null;
    case 'push':
      if (!a.clearedPush) return p.sw.ltBeacon && p.sys.hyd[0] > 1500 && Math.abs(ac.trim) > 0.05 ? 'push' : null;
      return running && (!p.push || p.push.done) && !a.clearedTaxi ? 'taxi' : null;
    case 'taxi': return !a.clearedTaxi && running && (isJet(p) || p.sys.avionics) ? 'taxi' : null;
    case 'tower_dep': case 'lineup': return !a.clearedTakeoff && !a.clearedLineup && ac.gs < 0.5 && p.phase === 'before_takeoff' && (isJet(p) || (!!p.flags.magL && !!p.flags.magR)) ? 'ready' : null;
    case 'takeoff': return p.cfg.kind === 'pattern' && !a.clearedLand && !ac.onGround && p.leg >= 2 ? 'option' : null;
    case 'departure': case 'center': case 'approach': return a.flags.needCheckin ? 'checkin' : null;
    case 'tower_arr': case 'landing': return a.flags.needCheckin ? 'final' : null;
    case 'ground_arr': return !a.clearedTaxiIn && ac.gs < 12 && ac.surface !== 'runway' ? 'taxi_in' : null;
  }
  return null;
}

export function stepAtc(p: PilotState, dt: number) {
  const a = p.atc, ac = p.ac;
  const jet = isJet(p);
  // deliver queued transmissions
  for (let i = 0; i < a.queue.length; i++) {
    const m = a.queue[i];
    if (m.due > p.t) continue;
    a.queue.splice(i--, 1);
    a.log.push({ t: p.t, from: 'atc', station: m.station, text: m.text });
    if (m.fx) applyFx(p, m.fx);
    if (m.rb) a.log.push({ t: p.t + 0.01, from: p.cfg.assists.autoRadio ? 'fo' : 'me', text: `${m.rb}, ${p.radioName}.` });
  }
  if (a.log.length > 200) a.log.splice(0, a.log.length - 200);

  const alt = indicatedAlt(p);
  const d = depAp(p), r = arrAp(p);
  const dArr = distToArr(p);
  const route = p.cfg.kind === 'route';

  // ── controller-initiated handoffs and clearances ──
  const once = (key: string) => { if (a.flags[key]) return false; a.flags[key] = 1; return true; };
  if (a.stage === 'taxi' && a.clearedTaxi && p.taxi?.hold && dist(ac.x, ac.y, p.taxi.hold[0], p.taxi.hold[1]) < 220 && once('toTower')) {
    setStage(p, 'tower_dep');
    a.log.push({ t: p.t, from: 'atc', station: `${d.ap.facility} Ground`, text: `${p.radioName}, contact tower ${f2(d.freq.tower)}.` });
  }
  if (a.stage === 'takeoff' && !ac.onGround && route) {
    if (jet && ac.agl / FT > 1200 && once('toDep')) { a.queue.push({ due: p.t + 1, station: a.station, text: `${p.radioName}, contact departure ${f2(d.freq.departure)}.`, fx: 'departure', rb: `Departure ${f2(d.freq.departure)}` }); }
    if (!jet && distFromDep(p) > 5 && once('toDep')) { a.queue.push({ due: p.t + 1, station: a.station, text: `${p.radioName}, leaving my airspace, frequency change approved.`, fx: 'freqChange', rb: 'Frequency change approved' }); }
  }
  if (a.stage === 'departure' && jet && route && (distFromDep(p) > 40 || alt > 17000) && dArr > 70 && !a.flags.needCheckin && once('toCenter')) {
    a.queue.push({ due: p.t + 1, station: a.station, text: `${p.radioName}, contact Center ${f2(132 + (p.rng % 30) * 0.1)}.`, fx: 'center', rb: 'Over to Center' });
  }
  if (route && (a.stage === 'departure' || a.stage === 'center')) {
    // top of descent: 3 NM per 1000 ft plus a margin
    const tod = ((alt - baseAlt(p)) / 1000) * 3.3 + (jet ? 22 : 6);
    if (jet && dArr < tod && alt > baseAlt(p) + 1500 && !a.flags.needCheckin && once('tod')) {
      const to = Math.max(baseAlt(p), Math.min(11000, Math.round((alt - 2000) / 1000) * 1000));
      a.flags.descTo = alt > 12500 ? to : baseAlt(p);
      a.queue.push({ due: p.t + 1, station: a.station, text: `${p.radioName}, descend and maintain ${altSay(a.flags.descTo)}.`, fx: 'descend', rb: `Descend and maintain ${altSay(a.flags.descTo)}` });
      p.callouts.push('tod');
    }
    if (jet && dArr < 48 && !a.flags.needCheckin && once('toApp')) {
      a.queue.push({ due: p.t + 1, station: a.station, text: `${p.radioName}, contact ${r.ap.facility} Approach ${f2(r.freq.approach)}.`, fx: 'approachCtl', rb: `Approach ${f2(r.freq.approach)}` });
    }
    if (!jet && dArr < 12 && once('toTwrArr')) { setStage(p, 'tower_arr'); a.flags.needCheckin = 1; sys(p, `12 NM from ${r.ap.icao}: call ${a.station} on ${f2(a.freq)} before entering the airspace.`); }
  }
  if (a.stage === 'approach' && !a.flags.needCheckin) {
    const baseIdx = p.route.findIndex((w) => w.kind === 'base');
    const finIdx = p.route.findIndex((w) => w.kind === 'final');
    if (!a.clearedApproach && (p.leg > baseIdx || dArr < 21) && once('appClr')) {
      const [along, cross] = alongCross(ac.x, ac.y, p.arrRwy.thrX, p.arrRwy.thrY, p.arrRwy.hdg);
      const side = cross > 0 ? 'right' : 'left';
      void along;
      atcSay(p, `${Math.round(dArr)} miles from the runway, ${Math.abs(cross) > 1500 ? `intercept the localiser from the ${side}, ` : ''}maintain ${altSay(finalAlt(p))} until established, cleared ILS runway ${p.arrRwy.name} approach.`, 'approach', `Cleared ILS runway ${p.arrRwy.name}, ${altSay(finalAlt(p))} until established`, 0.5);
    }
    if (a.clearedApproach && (dArr < 8.5 || p.leg > finIdx) && once('toTwr')) {
      a.queue.push({ due: p.t + 1, station: a.station, text: `${p.radioName}, contact tower ${f2(r.freq.tower)}.`, fx: 'tower_arr', rb: `Tower ${f2(r.freq.tower)}` });
    }
  }
  if ((a.stage === 'tower_arr' || a.stage === 'landing') && a.flags.report3 && dArr < 3.2 && !a.clearedLand) {
    a.flags.report3 = 0;
    a.log.push({ t: p.t, from: p.cfg.assists.autoRadio ? 'fo' : 'me', text: `${p.radioName}, three mile final runway ${p.arrRwy.name}.` });
    atcSay(p, `${windSay(r)}, runway ${p.arrRwy.name}, cleared to land.`, 'land', `Cleared to land runway ${p.arrRwy.name}`, 1);
  }
  if ((a.stage === 'landing' || a.stage === 'tower_arr' || a.stage === 'takeoff') && p.phase === 'rollout' && ac.gs < (p.cfg.kind === 'pattern' ? 3 : 22) && once('toGndArr')) {
    a.queue.push({ due: p.t + 1, station: a.station, text: `${p.radioName}, exit when able, contact ground ${f2(r.freq.ground)} clear of the runway.`, fx: 'ground_arr', rb: `Ground ${f2(r.freq.ground)}` });
  }
  // pattern work: the option clearance is used up by each landing
  if (p.cfg.kind === 'pattern' && a.clearedLand && p.flags.liftoff && p.flags.touchdown && p.flags.liftoff > p.flags.touchdown && p.t - p.flags.liftoff > 5) { a.clearedLand = false; p.flags.touchdown = 0; }

  // ── first officer on the radio ──
  if (p.cfg.assists.autoRadio && !a.queue.length) {
    a.foDelay -= dt;
    if (a.foDelay <= 0) {
      const id = foRequest(p);
      if (id) { p.radios.com.act = a.freq; atcRequest(p, id, 'fo'); a.foDelay = 6; }
      else a.foDelay = 1;
    }
  }

  // ── pilot deviations ──
  if (ac.onGround) {
    const strip = runwayStripAt(p, ac.x, ac.y);
    const taxiPhase = p.phase === 'taxi_out' || p.phase === 'before_takeoff' || p.phase === 'engine_start' || p.phase === 'before_start';
    if (taxiPhase && ac.gs > 2.5 && !a.clearedTaxi && !(p.push && !p.push.done)) penalise(p, 'noTaxiClr', -8, 'Taxied without a taxi clearance.', 'hold position. You are not cleared to taxi.');
    if (strip && taxiPhase && strip === p.depRwy.rwyId && !a.clearedLineup && !a.clearedTakeoff) penalise(p, 'incursion', -20, `Runway incursion: entered runway ${p.depRwy.name} without a clearance.`, `hold position! You were not cleared onto runway ${p.depRwy.name}.`, 1e9);
    if (p.phase === 'takeoff' && ac.gs > 30 * KT && !a.clearedTakeoff) penalise(p, 'noToClr', -20, 'Took off without a takeoff clearance.', 'you were not cleared for takeoff. Possible pilot deviation, advise ready to copy a phone number.', 1e9);
    if ((p.phase === 'taxi_out' || p.phase === 'taxi_in') && ac.gs > (ACDEF[p.cfg.aircraft].taxiKt + 8) * KT && ac.surface !== 'runway') penalise(p, 'taxiFast', -4, `Taxi speed above ${ACDEF[p.cfg.aircraft].taxiKt + 8} kt.`, undefined, 45);
  } else {
    const climbing = a.alt && !a.flags.descending;
    if (a.alt && p.phase !== 'approach' && p.phase !== 'landing' && p.phase !== 'takeoff' && !vfr(p)) {
      if (climbing && alt > a.alt + 300) penalise(p, 'bustHi', -10, `Altitude deviation: climbed through the cleared altitude of ${altSay(a.alt)}.`, `check altitude, you were cleared to ${altSay(a.alt)}.`);
      if (a.flags.descending && alt < a.alt - 300 && !a.clearedApproach) penalise(p, 'bustLo', -10, `Altitude deviation: descended below the cleared altitude of ${altSay(a.alt)}.`, `check altitude, maintain ${altSay(a.alt)}.`);
    }
    if (jet && alt < 9700 && ac.ias > 262 && (p.flags.airTime ?? 0) > 30) penalise(p, 'fast250', -5, 'Exceeded 250 kt below 10,000 ft.', 'say airspeed. Maintain 250 knots or less below ten thousand.', 120);
    if ((p.flags.airTime ?? 0) > 60 && p.sys.avionics && (p.radios.xpdr.mode === 0 || (a.squawk && p.radios.xpdr.code !== a.squawk))) penalise(p, 'xpdr', -4, 'Transponder not on the assigned code / not in ALT.', a.squawk ? `squawk ${a.squawk} and ident.` : 'check transponder.', 1e9);
    void angDiff;
  }
}
