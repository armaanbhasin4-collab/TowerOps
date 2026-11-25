/** Debrief: turns the recorded findings and landing data into scores and instructor comments. */
import { ACDEF } from './aircraft';
import type { Finding, LandingData, PilotState } from './types';

export interface LandingScore { data: LandingData; score: number; notes: string[]; verdict: string }
export interface Debrief {
  overall: number;
  grade: string;
  cats: { id: Finding['cat']; name: string; score: number; items: Finding[] }[];
  landings: LandingScore[];
  notes: string[];
  minutes: number;
  nm: number;
}

export function scoreLanding(p: PilotState, L: LandingData): LandingScore {
  const def = ACDEF[p.cfg.aircraft];
  const jet = p.cfg.aircraft === 'jet';
  const notes: string[] = [];
  let s = 100;
  const fpm = Math.round(L.fpm);
  if (L.fpm > def.hardFpm) { s -= 45; notes.push(`Hard landing: ${fpm} ft/min (limit ${def.hardFpm}). Flare earlier and hold the attitude.`); }
  else if (L.fpm > def.hardFpm * 0.55) { s -= 22; notes.push(`Firm touchdown at ${fpm} ft/min.`); }
  else if (L.fpm > 220) { s -= 8; notes.push(`Touchdown at ${fpm} ft/min – acceptable, a little firm.`); }
  else notes.push(`Smooth touchdown at ${fpm} ft/min.`);
  if (L.offRunway) { s -= 60; notes.push('Touched down off the runway.'); }
  else {
    const half = (p.arrRwy.width / 2) * 0.35;
    const off = Math.abs(L.offset);
    if (off > half * 2) { s -= 18; notes.push(`${off.toFixed(0)} m from the centreline – close to the edge.`); }
    else if (off > half) { s -= 8; notes.push(`${off.toFixed(0)} m off the centreline.`); }
    else notes.push(`On the centreline (${off.toFixed(1)} m).`);
    const zone: [number, number] = jet ? [200, 750] : [30, 350];
    if (L.dist < 0) { s -= 30; notes.push('Touched down short of the threshold.'); }
    else if (L.dist < zone[0]) { s -= 6; notes.push(`Touched down early (${Math.round(L.dist)} m past the threshold).`); }
    else if (L.dist > zone[1] * 1.6) { s -= 20; notes.push(`Landed long: ${Math.round(L.dist)} m down the runway. Floating usually means too much speed.`); }
    else if (L.dist > zone[1]) { s -= 9; notes.push(`A little long: ${Math.round(L.dist)} m past the threshold.`); }
    else notes.push(`In the touchdown zone (${Math.round(L.dist)} m).`);
  }
  const dv = L.ias - L.vref;
  if (dv > 20) { s -= 14; notes.push(`${Math.round(dv)} kt above Vref at touchdown.`); }
  else if (dv > 10) { s -= 6; notes.push(`${Math.round(dv)} kt fast at touchdown.`); }
  else if (dv < -8) { s -= 8; notes.push(`${Math.round(-dv)} kt below Vref – close to the stall.`); }
  if (Math.abs(L.crab) > 8) { s -= 12; notes.push(`Landed with ${Math.abs(L.crab).toFixed(0)}° of crab – straighten the nose with rudder just before touchdown.`); }
  else if (Math.abs(L.crab) > 4) { s -= 5; notes.push(`${Math.abs(L.crab).toFixed(0)}° of crab at touchdown.`); }
  if (Math.abs(L.bank) > 6) { s -= 10; notes.push(`${Math.abs(L.bank).toFixed(0)}° of bank at touchdown.`); }
  if (L.pitch < (jet ? 0.5 : 1)) { s -= 10; notes.push('Flat or nose-first touchdown – the main wheels must touch first.'); }
  s = Math.max(0, Math.round(s));
  return { data: L, score: s, notes, verdict: s >= 90 ? 'Excellent' : s >= 75 ? 'Good' : s >= 55 ? 'Acceptable' : s >= 35 ? 'Poor' : 'Unsafe' };
}

const NAMES: Record<Finding['cat'], string> = { procedure: 'Procedures & checklists', atc: 'ATC & radio', flying: 'Flying accuracy', landing: 'Landing', safety: 'Safety' };
const WEIGHT: Record<Finding['cat'], number> = { procedure: 0.2, atc: 0.15, flying: 0.15, landing: 0.25, safety: 0.25 };

export function debrief(p: PilotState): Debrief {
  const landings = p.landings.map((l) => scoreLanding(p, l));
  const cats = (Object.keys(NAMES) as Finding['cat'][]).map((id) => {
    const items = p.findings.filter((f) => f.cat === id);
    let score = 100 + items.reduce((s, f) => s + Math.min(0, f.pts), 0);
    if (id === 'landing') score = landings.length ? landings.reduce((s, l) => s + l.score, 0) / landings.length + items.reduce((s, f) => s + Math.min(0, f.pts), 0) : p.phase === 'complete' || p.over ? 0 : 100;
    return { id, name: NAMES[id], score: Math.max(0, Math.min(100, Math.round(score))), items };
  });
  const used = cats.filter((c) => c.id !== 'landing' || landings.length || p.over);
  const wsum = used.reduce((s, c) => s + WEIGHT[c.id], 0);
  let overall = Math.round(used.reduce((s, c) => s + c.score * WEIGHT[c.id], 0) / wsum);
  if (p.ac.crashed) overall = Math.min(overall, 20);
  const notes: string[] = [];
  const A = p.cfg.assists;
  if (p.flags.instructorUsed) notes.push('The instructor flew part of this flight, so the score does not reflect your flying alone.');
  if (A.autoSystems) notes.push('The first officer ran the switch flows (procedures were not all yours).');
  if (A.protection || A.autoRudder || A.autoTrim) notes.push(`Flying assists were on: ${[A.protection && 'stall/bank protection', A.autoRudder && 'auto-rudder', A.autoTrim && 'auto-trim'].filter(Boolean).join(', ')}.`);
  if (p.flags.forgiven) notes.push(`${p.flags.forgiven} event(s) that would have ended a real flight were forgiven.`);
  if (!landings.length && !p.over) notes.push('No landing yet – the flight is still in progress.');
  const grade = overall >= 93 ? 'A' : overall >= 85 ? 'B' : overall >= 72 ? 'C' : overall >= 58 ? 'D' : 'F';
  return { overall, grade, cats, landings, notes, minutes: p.t / 60, nm: p.distFlown / 1852 };
}
