import { useState } from 'react';
import { useUI } from '../store';
import type { Aircraft, Command, RequestType } from '../sim/types';
import { isActive, isAirborne, positionFor } from '../sim/world';
import { suggest } from '../sim/delegation';
import { gateUser } from '../sim/traffic';
import { cityOf } from '../sim/data/airlines';
import { fmtClock, fmtDur } from '../sim/util';
import { AirlineChip, REQ_LABEL, Tabs, boardStatus, fmtDelay, locationOf, phaseLabel, useSim } from './common';

type Tab = 'requests' | 'flights' | 'arrivals' | 'departures' | 'gates';

/** one-click answers for requests that need no extra parameters */
function quickAction(ac: Aircraft): { label: string; cmds: Command[] } | undefined {
  switch (ac.request?.type) {
    case 'clearance': return { label: 'Clearance', cmds: [{ t: 'DEP_CLEARANCE' }] };
    case 'pushback': return { label: 'Push', cmds: [{ t: 'PUSHBACK' }] };
    case 'crossing': return ac.request.rwy ? { label: `Cross ${ac.request.rwy.split('/')[0]}`, cmds: [{ t: 'CROSS', rwy: ac.request.rwy.split('/')[0] }] } : undefined;
    case 'takeoff': return { label: 'Takeoff', cmds: [{ t: 'TAKEOFF' }] };
    case 'landing': return { label: 'Land', cmds: [{ t: 'LAND' }] };
  }
}

function Requests() {
  const sim = useSim();
  const { select, selectedId, issue, doSuggestion } = useUI.getState();
  const [filter, setFilter] = useState<'all' | 'ground' | 'tower' | 'air' | 'emergency'>('all');
  const s = sim.s;
  const guidance = s.cfg.difficulty.atcGuidance;
  let list = s.aircraft.filter((a) => a.request && isActive(a));
  const match = (a: Aircraft) => {
    const p = positionFor(a);
    if (filter === 'all') return true;
    if (filter === 'emergency') return !!a.emergency && !a.emergency.resolved;
    if (filter === 'ground') return p === 'ground' || p === 'delivery';
    if (filter === 'tower') return p === 'tower';
    return p === 'approach' || p === 'departure';
  };
  list = list.filter(match).sort((a, b) => {
    const da = (a.request!.deferredUntil ?? 0) > s.t ? 1 : 0, db = (b.request!.deferredUntil ?? 0) > s.t ? 1 : 0;
    const ea = a.emergency && !a.emergency.resolved ? 0 : 1, eb = b.emergency && !b.emergency.resolved ? 0 : 1;
    return da - db || ea - eb || a.request!.since - b.request!.since;
  });
  const order: RequestType[] = ['emergency', 'landing', 'takeoff', 'crossing', 'taxi_in', 'taxi', 'pushback', 'clearance', 'approach', 'departure', 'tow'];
  void order;
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex gap-1 p-1.5 flex-wrap shrink-0">
        {(['all', 'ground', 'tower', 'air', 'emergency'] as const).map((f) => (
          <button key={f} className={`btn !py-0.5 !px-1.5 !text-[10px] uppercase ${filter === f ? 'btn-on' : ''}`} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <span className="ml-auto text-[11px] text-slate-500 self-center">{list.length} pending</span>
      </div>
      <div className="overflow-y-auto flex-1 min-h-0">
        {!list.length && <div className="p-3 text-slate-500 text-xs">No pending requests. Aircraft will call when they need a clearance.</div>}
        {list.map((ac) => {
          const r = ac.request!;
          const deferred = (r.deferredUntil ?? 0) > s.t;
          const em = ac.emergency && !ac.emergency.resolved;
          const qa = quickAction(ac);
          const sg = guidance ? suggest(sim, ac) : undefined;
          return (
            <div key={ac.id} onClick={() => select(ac.id, true)}
              className={`px-2 py-1.5 border-b border-navy-700 cursor-pointer ${selectedId === ac.id ? 'bg-navy-700' : 'hover:bg-navy-800'} ${deferred ? 'opacity-50' : ''} ${em ? 'border-l-2 border-l-red-a' : r.type === 'landing' || r.type === 'takeoff' || r.type === 'crossing' ? 'border-l-2 border-l-amber-a' : 'border-l-2 border-l-transparent'}`}>
              <div className="flex items-center gap-1.5">
                <AirlineChip ac={ac} />
                <span className={`mono font-semibold ${em ? 'text-red-a' : 'text-slate-100'}`}>{ac.callsign}</span>
                <span className="text-[10px] text-slate-500 mono">{ac.type}</span>
                <span className="ml-auto mono text-[10px] text-slate-500">{fmtDur(s.t - r.since)}</span>
              </div>
              <div className="text-[11px] text-slate-400 truncate">{locationOf(sim, ac)} — <span className={em ? 'text-red-a' : 'text-amber-a'}>{r.type === 'emergency' ? r.text : REQ_LABEL[r.type]}</span></div>
              <div className="flex gap-1 mt-1" onClick={(e) => e.stopPropagation()}>
                {qa && <button className="btn btn-go !py-0.5" onClick={() => issue(ac.id, qa.cmds)}>{qa.label}</button>}
                {sg && sg.cmds.length > 0 && (!qa || sg.cmds[0].t !== qa.cmds[0].t) && <button className="btn btn-primary !py-0.5 truncate max-w-[170px]" title={`Suggested: ${sg.label}`} onClick={() => doSuggestion(ac.id)}>★ {sg.label}</button>}
                {sg && !sg.cmds.length && sg.wait && <span className="text-[10px] text-slate-500 self-center truncate">hint: wait – {sg.wait}</span>}
                <button className="btn !py-0.5 ml-auto" title="Defer this request for 60 seconds" onClick={() => { sim.deferRequest(ac.id, deferred ? 0 : 60); useUI.setState({ tick: useUI.getState().tick + 1 }); }}>{deferred ? 'Recall' : 'Defer'}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Flights() {
  const sim = useSim();
  const { select, selectedId } = useUI.getState();
  const acs = sim.s.aircraft.filter((a) => isActive(a));
  const groups: [string, Aircraft[]][] = [
    ['Airborne arrivals', acs.filter((a) => isAirborne(a) && a.kind === 'arrival')],
    ['Runway / surface movement', acs.filter((a) => !isAirborne(a) && a.phase !== 'parked')],
    ['Airborne departures', acs.filter((a) => isAirborne(a) && a.kind === 'departure')],
    ['At gates', acs.filter((a) => a.phase === 'parked')],
  ];
  return (
    <div className="overflow-y-auto flex-1 min-h-0">
      {groups.map(([title, list]) => (
        <div key={title}>
          <div className="panel-h px-2 py-1 bg-navy-850 sticky top-0 flex justify-between"><span>{title}</span><span>{list.length}</span></div>
          {list.map((ac) => {
            const em = ac.emergency && !ac.emergency.resolved;
            return (
              <div key={ac.id} onClick={() => select(ac.id, true)} className={`px-2 py-1 border-b border-navy-800 cursor-pointer flex items-center gap-1.5 ${selectedId === ac.id ? 'bg-navy-700' : 'hover:bg-navy-800'}`}>
                <AirlineChip ac={ac} />
                <span className={`mono w-[62px] shrink-0 ${em ? 'text-red-a' : ac.kind === 'arrival' ? 'text-radar' : 'text-cyan-a'}`}>{ac.callsign}</span>
                <span className="mono text-[10px] text-slate-500 w-8 shrink-0">{ac.type}</span>
                <span className="text-[11px] text-slate-300 truncate flex-1">{phaseLabel(ac)}</span>
                <span className="mono text-[10px] text-slate-400 shrink-0">{isAirborne(ac) ? `${String(Math.round(ac.alt / 100)).padStart(3, '0')} ${Math.round(ac.gs)}` : ac.rwy && ac.kind === 'departure' ? ac.rwy : ac.gate ?? ''}</span>
                {ac.request && <span className="w-1.5 h-1.5 rounded-full bg-amber-a blink shrink-0" />}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function Board({ kind }: { kind: 'arrival' | 'departure' }) {
  const sim = useSim();
  const { select, selectedId } = useUI.getState();
  const s = sim.s;
  const clock = (t: number) => fmtClock(s.cfg.startClock + t);
  const rows = s.aircraft
    .filter((a) => (kind === 'arrival' ? a.kind === 'arrival' && !(a.phase === 'parked' && s.t - (a.actual ?? 0) > 240) : a.kind === 'departure' || (a.phase === 'parked' && a.nextLeg && (a.turn?.progress ?? 0) > 0.35)))
    .sort((a, b) => (kind === 'arrival' ? a.sched - b.sched : (a.kind === 'departure' ? a.sched : a.nextLeg!.sched) - (b.kind === 'departure' ? b.sched : b.nextLeg!.sched)));
  return (
    <div className="overflow-auto flex-1 min-h-0">
      <table className="w-full text-[11px] mono">
        <thead className="sticky top-0 bg-navy-850 text-slate-500 text-[10px] uppercase">
          <tr><th className="text-left pl-2 py-1 font-normal">Flight</th><th className="text-left font-normal">Type</th><th className="text-left font-normal">{kind === 'arrival' ? 'From' : 'To'}</th><th className="font-normal">Sch</th><th className="font-normal">Est</th><th className="font-normal">Rwy</th><th className="font-normal">Gate</th><th className="font-normal">Dly</th></tr>
        </thead>
        <tbody>
          {rows.map((ac) => {
            const boarding = kind === 'departure' && ac.kind !== 'departure';
            const cs = boarding ? ac.nextLeg!.callsign : ac.callsign;
            const place = kind === 'arrival' ? ac.origin : boarding ? ac.nextLeg!.dest : ac.dest;
            const sch = boarding ? ac.nextLeg!.sched : ac.sched;
            const status = boarding ? 'Boarding' : boardStatus(ac);
            const delayed = ac.delay > 300 && !boarding;
            return (
              <tr key={ac.id} onClick={() => select(ac.id, true)} className={`cursor-pointer border-b border-navy-800 ${selectedId === ac.id ? 'bg-navy-700' : 'hover:bg-navy-800'} ${ac.phase === 'gone' ? 'opacity-40' : ''}`} title={`${cityOf(place)} — ${status}${ac.source === 'simulated' ? ' (simulated flight)' : ''}`}>
                <td className="pl-2 py-1 whitespace-nowrap"><AirlineChip ac={ac} /> <span className="text-slate-100">{cs}</span><div className={`text-[10px] font-sans ${/Final|Taking|Landed|Holding short|Line up/.test(status) ? 'text-amber-a' : 'text-slate-500'}`}>{status}</div></td>
                <td className="text-slate-400">{ac.type}</td>
                <td className="text-slate-300">{place}</td>
                <td className="text-center text-slate-400">{clock(sch)}</td>
                <td className={`text-center ${delayed ? 'text-amber-a' : 'text-slate-300'}`}>{boarding ? clock(sch) : clock(ac.actual ?? ac.est)}</td>
                <td className="text-center text-slate-300">{(kind === 'departure' && boarding ? '' : ac.rwy ?? ac.lastRwy) || '—'}</td>
                <td className="text-center text-slate-300">{ac.gate ?? '—'}</td>
                <td className={`text-center pr-1 ${delayed ? 'text-amber-a' : 'text-slate-500'}`}>{boarding ? '—' : fmtDelay(ac.delay)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!rows.length && <div className="p-3 text-slate-500 text-xs font-sans">No flights.</div>}
    </div>
  );
}

function Gates() {
  const sim = useSim();
  const { select, selectedId, focusOn } = useUI.getState();
  const terms = [...new Set(sim.ap.gates.map((g) => g.terminal))];
  const occ = sim.ap.gates.filter((g) => { const u = gateUser(sim, g.name); return u && (u.phase === 'parked' || u.phase === 'pushback'); }).length;
  return (
    <div className="overflow-y-auto flex-1 min-h-0 p-2">
      <div className="text-[11px] text-slate-400 mb-1">{occ} / {sim.ap.gates.length} gates occupied · <span className="text-amber-a">■</span> ready/pending <span className="text-cyan-a">■</span> turnaround <span className="text-slate-500">□</span> reserved</div>
      {terms.map((t) => (
        <div key={t} className="mb-2">
          <div className="panel-h mb-1">{/^[A-Z0-9]$/.test(t) ? `Concourse / Terminal ${t}` : t}</div>
          <div className="grid grid-cols-6 gap-1">
            {sim.ap.gates.filter((g) => g.terminal === t).map((g) => {
              const u = gateUser(sim, g.name);
              const on = u && (u.phase === 'parked' || u.phase === 'pushback');
              const ready = on && u!.turn?.stage === 'ready';
              const n = sim.ap.nodes[g.node];
              return (
                <button key={g.name} title={u ? `${g.name} (${g.size}) – ${u.callsign} ${u.type}: ${on ? phaseLabel(u) : 'assigned, inbound'}` : `${g.name} – free, max size ${g.size}`}
                  onClick={() => { if (u) select(u.id, true); else focusOn(n.x, n.y); }}
                  className={`relative h-8 rounded-sm border text-[10px] mono leading-tight overflow-hidden ${u && selectedId === u.id ? 'border-white' : on ? (ready ? 'border-amber-a/70' : 'border-cyan-a/50') : u ? 'border-slate-500 border-dashed' : 'border-navy-600'} ${on ? 'bg-navy-700 text-slate-100' : 'bg-navy-900 text-slate-500'}`}>
                  <div>{g.name}{g.size === 'XL' || g.size === 'L' ? <sup className="text-[8px] text-slate-500">{g.size}</sup> : null}</div>
                  {u && <div className="text-[8px] truncate px-0.5">{u.callsign}</div>}
                  {on && u!.turn && <div className={`absolute bottom-0 left-0 h-[3px] ${ready ? 'bg-amber-a' : 'bg-cyan-a'}`} style={{ width: `${Math.round((u!.turn.progress ?? 0) * 100)}%` }} />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function LeftPanel() {
  const [tab, setTab] = useState<Tab>('requests');
  const sim = useSim();
  const n = sim.s.aircraft.filter((a) => a.request && isActive(a) && (a.request.deferredUntil ?? 0) < sim.s.t).length;
  return (
    <div className="flex flex-col h-full min-h-0 bg-navy-900">
      <Tabs value={tab} onChange={setTab} items={[['requests', <span>Requests {n > 0 && <span className="ml-1 px-1 rounded bg-amber-a text-black font-bold">{n}</span>}</span>], ['flights', 'Flights'], ['arrivals', 'Arr'], ['departures', 'Dep'], ['gates', 'Gates']]} />
      {tab === 'requests' && <Requests />}
      {tab === 'flights' && <Flights />}
      {tab === 'arrivals' && <Board kind="arrival" />}
      {tab === 'departures' && <Board kind="departure" />}
      {tab === 'gates' && <Gates />}
    </div>
  );
}
