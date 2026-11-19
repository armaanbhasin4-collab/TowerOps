import type { ReactNode } from 'react';
import { useUI } from '../store';
import type { Aircraft, Request } from '../sim/types';
import type { Sim } from '../sim/sim';
import { NM, dist } from '../sim/util';
import { isAirborne } from '../sim/world';
import { curSeg } from '../sim/ground';
import { edgeBetween, endRef } from '../sim/airport/query';
import { airlineOf } from '../sim/data/airlines';

/** subscribe to the sim + UI tick */
export function useSim(): Sim {
  useUI((s) => s.tick);
  return useUI.getState().sim!;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function locationOf(sim: Sim, ac: Aircraft): string {
  const ap = sim.ap;
  if (isAirborne(ac)) {
    const e = endRef(ap, ac.rwy);
    if (ac.phase === 'final' && e) return `Final ${ac.rwy}, ${(dist(ac.x, ac.y, e.end.x, e.end.y) / NM).toFixed(1)} NM`;
    const d = dist(ac.x, ac.y, 0, 0) / NM;
    const b = COMPASS[Math.round((((Math.atan2(ac.x, ac.y) * 180) / Math.PI + 360) % 360) / 45) % 8];
    return `${d.toFixed(0)} NM ${b}, ${Math.round(ac.alt / 100) * 100} ft`;
  }
  switch (ac.phase) {
    case 'parked': return `Gate ${ac.gate}`;
    case 'pushback': return `Pushing from ${ac.gate ?? 'gate'}`;
    case 'holding_short': return `Holding short ${ac.rwy}`;
    case 'lining_up': case 'lined_up': return `On runway ${ac.rwy}`;
    case 'takeoff_roll': return `Rolling ${ac.rwy}`;
    case 'landing_roll': return ac.route.length > 1 ? `Exiting ${ac.rwy}` : `Rollout ${ac.rwy}`;
    case 'vacated': return `Clear of ${ac.lastRwy ?? ac.rwy ?? 'runway'}${ac.taxiNames[0] ? ` at ${ac.taxiNames[0]}` : ''}`;
    case 'crashed': return 'Accident site';
  }
  const seg = curSeg(ap, ac);
  const e = seg ? edgeBetween(ap, seg.a, seg.b) : undefined;
  return e?.name ? `Taxiway ${e.name}` : e?.kind === 'gate' ? `Stand ${ac.gate ?? ''}` : 'Apron';
}

const PHASE: Record<string, string> = {
  inbound: 'Inbound', approach: 'On approach', final: 'Final approach', landing_roll: 'Landing', vacated: 'Clear of runway', taxi_in: 'Taxi to gate',
  parked: 'At gate', pushback: 'Pushing back', push_done: 'Awaiting taxi', taxi_out: 'Taxi to runway', holding_short: 'Holding short',
  lining_up: 'Lining up', lined_up: 'Line up and wait', takeoff_roll: 'Taking off', departure: 'Departure climb', go_around: 'Going around',
  disabled: 'Disabled', crashed: 'Accident', gone: 'Left airspace',
};
export function phaseLabel(ac: Aircraft): string {
  if (ac.phase === 'inbound' && ac.latMode === 'hold') return 'Holding';
  if (ac.phase === 'parked' && ac.turn) return ac.turn.stage === 'ready' ? (ac.depCleared ? 'Awaiting pushback' : 'Ready for departure') : ac.turn.stage[0].toUpperCase() + ac.turn.stage.slice(1);
  if (ac.phase === 'gone') return ac.kind === 'departure' && !ac.flags.towed ? 'Departed' : ac.flags.towed ? 'Towed away' : 'Diverted';
  return PHASE[ac.phase] ?? ac.phase;
}
/** board status strings per the arrival/departure board specification */
export function boardStatus(ac: Aircraft): string {
  if (ac.kind === 'arrival') {
    switch (ac.phase) {
      case 'inbound': return ac.flags.diverting ? 'Diverted' : ac.latMode === 'hold' ? 'Holding' : 'In controlled airspace';
      case 'approach': case 'go_around': return ac.phase === 'go_around' ? 'Go-around' : 'On approach';
      case 'final': return 'Final approach';
      case 'landing_roll': case 'vacated': return 'Landed';
      case 'taxi_in': return 'Taxiing';
      case 'parked': return 'At gate';
      case 'gone': return 'Diverted';
    }
  } else {
    switch (ac.phase) {
      case 'parked': return !ac.depCleared ? 'Ready for departure' : 'Awaiting pushback';
      case 'pushback': return 'Pushing back';
      case 'push_done': case 'taxi_out': case 'vacated': return 'Taxiing';
      case 'holding_short': return 'Holding short';
      case 'lining_up': case 'lined_up': return 'Line up and wait';
      case 'takeoff_roll': return 'Taking off';
      case 'departure': case 'gone': return 'Departed';
    }
  }
  return phaseLabel(ac);
}

export const REQ_LABEL: Record<Request['type'], string> = {
  clearance: 'Requesting departure clearance', pushback: 'Requesting pushback', taxi: 'Requesting taxi instructions', crossing: 'Requesting runway crossing',
  takeoff: 'Ready for departure', approach: 'Requesting approach vectors', landing: 'Requesting landing clearance', taxi_in: 'Requesting taxi to gate',
  departure: 'Airborne – requesting climb / routing', emergency: 'EMERGENCY', tow: 'Blocked – needs re-route or tow',
};

export function AirlineChip({ ac }: { ac: Pick<Aircraft, 'airline'> }) {
  const al = airlineOf(ac.airline);
  return <span title={al.name} className="inline-block w-2.5 h-3.5 rounded-[2px] border border-black/40 align-middle shrink-0" style={{ background: `linear-gradient(180deg, ${al.tail} 0 45%, ${al.color} 45% 100%)` }} />;
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: [T, ReactNode][] }) {
  return (
    <div className="flex border-b border-navy-600 text-[11px] shrink-0">
      {items.map(([k, l]) => (
        <button key={k} onClick={() => onChange(k)} className={`px-2.5 py-1.5 uppercase tracking-wider border-b-2 -mb-px ${value === k ? 'border-cyan-a text-cyan-a' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>{l}</button>
      ))}
    </div>
  );
}
export const fmtDelay = (sec: number) => (sec < 60 ? '—' : `+${Math.round(sec / 60)}m`);
export const sevColor = (sev: string) => (sev === 'critical' ? 'text-red-a' : sev === 'warning' ? 'text-amber-a' : sev === 'advisory' ? 'text-cyan-a' : 'text-slate-400');
