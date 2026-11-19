import { useEffect, useState } from 'react';
import { useUI } from '../store';
import type { Aircraft, Command, Position } from '../sim/types';
import type { Sim } from '../sim/sim';
import { isAirborne } from '../sim/world';
import { typeOf } from '../sim/data/aircraft';
import { airlineOf, cityOf } from '../sim/data/airlines';
import { allEnds, endRef, windComponents } from '../sim/airport/query';
import { planTaxi } from '../sim/commands';
import { suggest } from '../sim/delegation';
import { gateOptions } from '../sim/traffic';
import { computeScore } from '../sim/scoring';
import { metar, fmtWind } from '../sim/weather';
import { emergencyLabel } from '../sim/emergencies';
import { squawkOf } from '../sim/phraseology';
import { fmtClock, fmtDur } from '../sim/util';
import { cumOf, nextHoldAhead } from '../sim/ground';
import { AirlineChip, Tabs, fmtDelay, locationOf, phaseLabel, useSim } from './common';

const Row = ({ k, v, c }: { k: string; v: React.ReactNode; c?: string }) => (
  <div className="flex justify-between gap-2 py-[1px]"><span className="text-slate-500">{k}</span><span className={`mono text-right ${c ?? 'text-slate-200'}`}>{v}</span></div>
);

function clearances(ac: Aircraft): string[] {
  const c: string[] = [];
  if (ac.depCleared) c.push(`IFR clearance${ac.depFix ? ` (${ac.depFix})` : ''}`);
  if (ac.pushApproved && (ac.phase === 'pushback' || ac.phase === 'push_done')) c.push('Pushback approved');
  if ((ac.phase === 'taxi_out' || ac.phase === 'taxi_in') && ac.taxiNames.length) c.push(`Taxi ${ac.kind === 'departure' ? `rwy ${ac.rwy}` : `gate ${ac.gate}`} via ${ac.taxiNames.join(' ')}`);
  for (const r of ac.crossCleared) c.push(`Cross ${r}`);
  if (ac.holdPos) c.push('HOLD POSITION');
  if (ac.takeoffCleared) c.push(`Cleared takeoff ${ac.rwy}`);
  else if (ac.lineUpCleared) c.push(`Line up & wait ${ac.rwy}`);
  if (isAirborne(ac)) {
    c.push(ac.latMode === 'hdg' ? `Heading ${String(Math.round(ac.tgtHdg) || 360).padStart(3, '0')}` : ac.latMode === 'fix' ? `Direct ${ac.fix}` : ac.latMode === 'hold' ? `Hold ${ac.fix ?? ''}` : `Localizer ${ac.rwy}`);
    c.push(`Altitude ${ac.tgtAlt}`);
    if (ac.tgtSpd) c.push(`Speed ${ac.tgtSpd}`);
  }
  if (ac.apprCleared) c.push(`Cleared ILS ${ac.rwy}`);
  if (ac.landCleared) c.push(`Cleared to land ${ac.rwy}`);
  if (ac.handedOff) c.push('Handed off to center');
  return c;
}

function nextMove(sim: Sim, ac: Aircraft): string {
  if (ac.flags.pending) return 'Reading back clearance…';
  switch (ac.phase) {
    case 'parked': return ac.turn?.stage !== 'ready' ? `Turnaround ${Math.round((ac.turn?.progress ?? 0) * 100)}% – ${ac.turn?.stage}` : !ac.depCleared ? 'Waiting for departure clearance' : 'Waiting for pushback approval';
    case 'pushback': return 'Tug pushing onto the taxilane';
    case 'push_done': return 'Waiting for taxi instructions';
    case 'vacated': return 'Waiting for taxi instructions';
    case 'taxi_out': case 'taxi_in': {
      if (ac.holdPos) return 'Holding position as instructed';
      if (ac.blockedBy !== undefined && ac.gs < 0.5) return `Giving way to ${sim.s.aircraft.find((a) => a.id === ac.blockedBy)?.callsign ?? 'traffic'}`;
      const h = nextHoldAhead(sim, ac, cumOf(sim.ap, ac.route));
      if (h && !h.final) return `Will hold short of runway ${h.rwy} (needs crossing clearance)`;
      return ac.kind === 'departure' ? `Taxi to holding point ${ac.rwy}` : `Taxi to gate ${ac.gate}`;
    }
    case 'holding_short': return 'Waiting for line-up / takeoff clearance';
    case 'lining_up': return 'Entering the runway';
    case 'lined_up': return ac.takeoffCleared ? 'Starting takeoff roll' : 'Waiting for takeoff clearance';
    case 'takeoff_roll': return 'Accelerating to rotation';
    case 'landing_roll': return ac.route.length > 1 ? 'Vacating the runway' : 'Decelerating, will take next suitable exit';
    case 'final': return ac.landCleared ? 'Continuing to land' : 'Will go around at 1 NM without landing clearance';
    case 'approach': return 'Intercepting the localizer';
    case 'go_around': return 'Climbing on runway heading';
    case 'departure': return ac.latMode === 'fix' ? `Direct ${ac.fix}, climbing ${ac.tgtAlt}` : `Heading ${Math.round(ac.tgtHdg)}, climbing ${ac.tgtAlt}`;
    case 'inbound': return ac.latMode === 'hold' ? `Holding at ${ac.fix}` : ac.latMode === 'fix' ? `Direct ${ac.fix}, then hold if no further clearance` : `Flying heading ${Math.round(ac.tgtHdg)}`;
    case 'disabled': return ac.flags.wreck ? 'Wreckage – remains until the session ends' : `Awaiting recovery (${fmtDur((ac.flags.disabledUntil ?? 0) - sim.s.t)})`;
  }
  return '';
}

function AircraftCard({ sim, ac }: { sim: Sim; ac: Aircraft }) {
  const t = typeOf(ac.type);
  const al = airlineOf(ac.airline);
  const em = ac.emergency && !ac.emergency.resolved ? ac.emergency : undefined;
  const air = isAirborne(ac);
  const cl = clearances(ac);
  return (
    <div className="p-2 border-b border-navy-600 text-[11.5px]">
      <div className="flex items-center gap-2">
        <AirlineChip ac={ac} />
        <span className="mono text-lg font-semibold text-white leading-none">{ac.callsign}</span>
        <span className="mono text-slate-400">{ac.type}{t.wake === 'H' ? ' /H' : t.wake === 'J' ? ' /J' : ''}</span>
        <span className={`ml-auto px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${ac.kind === 'arrival' ? 'bg-emerald-900/60 text-radar' : 'bg-sky-900/60 text-cyan-a'}`}>{ac.kind}</span>
      </div>
      <div className="text-slate-400 mt-0.5">{al.name} · {t.name} · {ac.reg}</div>
      {em && <div className="mt-1 px-2 py-1 rounded bg-red-950 border border-red-a/60 text-red-a font-semibold blink">{em.mayday ? 'MAYDAY' : 'PAN-PAN'} — {emergencyLabel(em.kind)} ({fmtDur(sim.s.t - em.since)})</div>}
      <div className="grid grid-cols-2 gap-x-4 mt-1.5">
        <div>
          <Row k="Flight" v={`${al.iata}${ac.callsign.slice(al.icao.length)}`} />
          <Row k="From" v={`${ac.origin} ${cityOf(ac.origin) !== ac.origin ? '' : ''}`} />
          <Row k="To" v={ac.dest} />
          <Row k="Gate" v={ac.gate ?? '—'} />
          <Row k="Runway" v={ac.rwy ?? '—'} />
          <Row k={ac.kind === 'arrival' ? 'STA / ETA' : 'STD / ETD'} v={`${fmtClock(sim.s.cfg.startClock + ac.sched)} / ${fmtClock(sim.s.cfg.startClock + (ac.actual ?? ac.est))}`} />
          <Row k="Delay" v={fmtDelay(ac.delay)} c={ac.delay > 300 ? 'text-amber-a' : undefined} />
        </div>
        <div>
          <Row k="Altitude" v={air ? `${Math.round(ac.alt / 10) * 10} ft` : 'GND'} />
          <Row k="IAS / GS" v={`${Math.round(ac.ias)} / ${Math.round(ac.gs)} kt`} />
          <Row k="Heading" v={`${String(Math.round(ac.hdg) || 360).padStart(3, '0')}°`} />
          <Row k="V/S" v={air ? `${ac.vs > 0 ? '+' : ''}${Math.round(ac.vs / 50) * 50} fpm` : '—'} />
          <Row k="Fuel" v={`${(ac.fuel / 1000).toFixed(1)} t${air ? ` · ${Math.round(ac.fuelMin)} min` : ''}`} c={air && ac.fuelMin < 30 && sim.s.cfg.difficulty.fuelRealism ? 'text-red-a' : undefined} />
          <Row k="Squawk" v={squawkOf(ac)} />
          <Row k="Data" v={ac.source} c="text-slate-500" />
        </div>
      </div>
      <div className="mt-1 text-slate-400">{cityOf(ac.origin)} → {cityOf(ac.dest)}</div>
      <div className="mt-1.5"><span className="panel-h">Phase</span> <span className="text-slate-100">{phaseLabel(ac)}</span> <span className="text-slate-500">· {locationOf(sim, ac)}</span></div>
      <div><span className="panel-h">Next</span> <span className="text-slate-300">{nextMove(sim, ac)}</span></div>
      <div className="mt-1 flex flex-wrap gap-1">
        {cl.length ? cl.map((c) => <span key={c} className={`px-1.5 py-0.5 rounded border text-[10.5px] mono ${c === 'HOLD POSITION' ? 'border-red-a/60 text-red-a' : 'border-cyan-a/40 text-cyan-a'}`}>{c}</span>) : <span className="text-slate-500">No active clearances</span>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="px-2 py-1.5 border-b border-navy-700"><div className="panel-h mb-1">{title}</div>{children}</div>;
}

function CommandPanel({ sim, ac }: { sim: Sim; ac: Aircraft }) {
  const { issue, doSuggestion, setPreview, setFollow, follow, focusOn } = useUI.getState();
  const s = sim.s;
  const ap = sim.ap;
  const air = isAirborne(ac);
  const t = typeOf(ac.type);
  const [rwy, setRwy] = useState('');
  const [via, setVia] = useState('');
  const [gate, setGate] = useState('');
  const [hdg, setHdg] = useState(360);
  const [alt, setAlt] = useState(4000);
  const [spd, setSpd] = useState(210);
  const [fix, setFix] = useState('');
  const [exit, setExit] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    setVia(''); setNote(''); setExit('');
    setHdg(Math.round(ac.hdg / 10) * 10 || 360);
    setAlt(ac.tgtAlt >= 1500 ? ac.tgtAlt : 4000);
    setSpd(ac.tgtSpd || Math.round(ac.ias / 10) * 10 || 210);
    setRwy(ac.rwy ?? (ac.kind === 'departure' ? s.activeConfig.dep[0] : s.activeConfig.arr[0]) ?? ap.runways[0].ends[0].name);
    setGate(ac.gate ?? '');
    setFix(ac.kind === 'departure' ? ac.depFix ?? '' : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ac.id, ac.kind]);
  const send = (cmds: Command[]) => { const r = issue(ac.id, cmds); setNote(r.ok ? '' : r.message ?? ''); if (r.ok) setPreview(null); };
  const ends = allEnds(ap);
  const viaList = via.trim() ? via.trim().toUpperCase().split(/[\s,]+/) : undefined;
  const sg = s.cfg.difficulty.atcGuidance ? suggest(sim, ac) : undefined;
  const em = ac.emergency && !ac.emergency.resolved ? ac.emergency : undefined;
  const pendingTx = !!ac.flags.pending;
  const rwyInfo = (name: string) => {
    const e = endRef(ap, name)!;
    const w = windComponents(e.end.hdg, s.weather.windDir, s.weather.windKt);
    return `${name}${s.rwy[e.rwy.id].closed ? ' CLOSED' : ''} · ${Math.round(e.rwy.length)}m · ${w.head >= 0 ? 'HW' : 'TW'}${Math.abs(Math.round(w.head))} XW${Math.round(w.cross)}${s.activeConfig.dep.includes(name) ? ' · DEP' : ''}${s.activeConfig.arr.includes(name) ? ' · ARR' : ''}`;
  };
  const RunwaySelect = () => (
    <select className="field w-full" value={rwy} onChange={(e) => setRwy(e.target.value)}>
      {ends.map((e) => <option key={e.end.name} value={e.end.name}>{rwyInfo(e.end.name)}</option>)}
    </select>
  );
  const preview = (cmd: Extract<Command, { t: 'TAXI' }>) => {
    const p = planTaxi(sim, ac, cmd);
    if (typeof p === 'string') { setNote(p); setPreview(null); }
    else { setPreview({ nodes: p.route.nodes, ac: ac.id }); setNote(`Route: ${p.route.names.join(' → ') || 'direct'} · ${Math.round(p.route.len)} m`); }
  };
  const groundTaxi = ['push_done', 'taxi_out', 'taxi_in', 'vacated', 'holding_short'].includes(ac.phase);
  const gates = ac.kind === 'arrival' ? gateOptions(sim, ac) : [];
  const hold = (ac.phase === 'taxi_out' || ac.phase === 'taxi_in') ? nextHoldAhead(sim, ac, cumOf(ap, ac.route)) : undefined;
  const crossRwys = (ac.phase === 'taxi_out' || ac.phase === 'taxi_in') ? [...new Set(ac.route.map((n) => ap.nodes[n]).filter((n, i) => n.kind === 'hold' && n.rwy && i < ac.route.length - 1 && cumOf(ap, ac.route)[i] > ac.routeS - 5).map((n) => n.rwy!))].filter((r) => !ac.crossCleared.includes(r) && !(ac.kind === 'departure' && endRef(ap, ac.rwy)?.rwy.id === r && !hold)) : [];
  const exits = ac.rwy && ac.kind === 'arrival' ? [...new Set(endRef(ap, ac.rwy)!.rwy.nodes.flatMap((n) => ap.adj[n].map((e) => ap.edges[e]).filter((e) => e.kind !== 'runway' && e.name).map((e) => e.name)))] : [];

  return (
    <div className="text-[12px]">
      <div className="px-2 py-1.5 flex gap-1 border-b border-navy-700">
        <button className="btn" onClick={() => focusOn(ac.x, ac.y)}>Locate</button>
        <button className={`btn ${follow ? 'btn-on' : ''}`} onClick={() => setFollow(!follow)}>Follow</button>
        {pendingTx && <span className="text-cyan-a self-center ml-auto text-[11px] blink">awaiting readback…</span>}
      </div>
      {sg && (sg.cmds.length > 0 || sg.wait) && (
        <div className="mx-2 my-1.5 px-2 py-1.5 rounded border border-cyan-a/40 bg-cyan-950/30">
          <div className="panel-h !text-cyan-a">ATC guidance</div>
          {sg.cmds.length > 0 ? <div className="flex items-center gap-2"><span className="text-slate-200 flex-1">{sg.label}{sg.wait ? <span className="text-slate-500"> ({sg.wait})</span> : null}</span><button className="btn btn-primary" onClick={() => { const r = doSuggestion(ac.id); setNote(r.ok ? '' : r.message ?? ''); }}>Issue</button></div> : <div className="text-slate-400">Wait: {sg.wait}</div>}
        </div>
      )}
      {note && <div className="mx-2 my-1 px-2 py-1 rounded bg-navy-800 border border-amber-a/40 text-amber-a text-[11px]">{note}</div>}

      {ac.phase === 'parked' && (
        <Section title="Gate / clearance delivery">
          {ac.turn?.stage !== 'ready' || ac.kind !== 'departure' ? (
            <div className="text-slate-400">Turnaround in progress: <span className="text-slate-200">{ac.turn?.stage}</span> ({Math.round((ac.turn?.progress ?? 0) * 100)}%).{ac.nextLeg ? ` Next flight ${ac.nextLeg.callsign} to ${ac.nextLeg.dest}.` : ''}
              <div className="h-1.5 bg-navy-700 rounded mt-1"><div className="h-full bg-cyan-a rounded" style={{ width: `${Math.round((ac.turn?.progress ?? 0) * 100)}%` }} /></div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <button className="btn btn-go w-full" disabled={ac.depCleared} onClick={() => send([{ t: 'DEP_CLEARANCE' }])}>{ac.depCleared ? '✓ Departure clearance issued' : 'Issue departure clearance'}</button>
              <div className="flex gap-1 items-center">
                <button className="btn btn-go flex-1" disabled={!ac.depCleared || ac.pushApproved} onClick={() => send([{ t: 'PUSHBACK' }])}>Approve pushback</button>
                <span className="text-slate-500 text-[10px]">face</span>
                {(['N', 'E', 'S', 'W'] as const).map((f) => <button key={f} className="btn !px-1.5" disabled={!ac.depCleared || ac.pushApproved} onClick={() => send([{ t: 'PUSHBACK', face: f }])}>{f}</button>)}
              </div>
              <div className="flex gap-1 items-center"><span className="text-slate-500 w-14">Expect</span><RunwaySelect /><button className="btn" onClick={() => send([{ t: 'ASSIGN_RUNWAY', rwy }])}>Assign</button></div>
            </div>
          )}
        </Section>
      )}

      {groundTaxi && ac.kind === 'departure' && (
        <Section title="Taxi to runway">
          <div className="space-y-1">
            <RunwaySelect />
            <div className="flex gap-1"><input className="field flex-1" placeholder="via taxiways e.g. B M (optional)" value={via} onChange={(e) => setVia(e.target.value)} />
              <button className="btn" onClick={() => preview({ t: 'TAXI', rwy, via: viaList })}>Preview</button></div>
            <button className="btn btn-go w-full" onClick={() => send([{ t: 'TAXI', rwy, via: viaList }])}>{ac.phase === 'taxi_out' ? 'Change taxi route' : `Taxi to runway ${rwy}`}</button>
          </div>
        </Section>
      )}
      {groundTaxi && ac.kind === 'arrival' && (
        <Section title="Gate assignment & taxi">
          <div className="space-y-1">
            <select className="field w-full" value={gate} onChange={(e) => setGate(e.target.value)}>
              <option value="">— select gate ({gates.length} compatible free) —</option>
              {ac.gate && <option value={ac.gate}>{ac.gate} (assigned)</option>}
              {gates.slice(0, 60).map((g, i) => <option key={g.name} value={g.name}>{g.name} · size {g.size}{g.airlines?.includes(ac.airline) ? ` · ${ac.airline}` : ''}{i === 0 ? ' · recommended' : ''}</option>)}
            </select>
            <div className="flex gap-1"><input className="field flex-1" placeholder="via taxiways (optional)" value={via} onChange={(e) => setVia(e.target.value)} />
              <button className="btn" disabled={!gate} onClick={() => preview({ t: 'TAXI', gate, via: viaList })}>Preview</button></div>
            <button className="btn btn-go w-full" disabled={!gate} onClick={() => send([{ t: 'TAXI', gate, via: viaList }])}>{ac.phase === 'taxi_in' ? 'Change route / gate' : `Taxi to gate ${gate || '…'}`}</button>
          </div>
        </Section>
      )}
      {['pushback', 'taxi_out', 'taxi_in', 'lining_up', 'push_done', 'vacated', 'holding_short', 'lined_up'].includes(ac.phase) && (
        <Section title="Ground control">
          <div className="flex flex-wrap gap-1">
            {ac.holdPos ? <button className="btn btn-go" onClick={() => send([{ t: 'CONTINUE_TAXI' }])}>Continue taxi</button> : <button className="btn btn-warn" onClick={() => send([{ t: 'HOLD_POSITION' }])}>Hold position</button>}
            {crossRwys.map((r) => <button key={r} className="btn btn-go" onClick={() => send([{ t: 'CROSS', rwy: r.split('/')[0] }])}>Cross runway {r}</button>)}
            {(ac.phase === 'taxi_out' || ac.phase === 'taxi_in' || ac.phase === 'push_done' || ac.phase === 'vacated') && <button className="btn" title="Tug repositions the aircraft backwards to the previous junction" onClick={() => send([{ t: 'TOW' }])}>Tow back</button>}
          </div>
          {hold && !hold.final && <div className="text-amber-a text-[11px] mt-1">Route crosses runway {hold.rwy}: the aircraft will stop at the hold line until cleared to cross.</div>}
        </Section>
      )}
      {ac.kind === 'departure' && ['taxi_out', 'holding_short', 'lining_up', 'lined_up', 'takeoff_roll'].includes(ac.phase) && (
        <Section title={`Tower — runway ${ac.rwy}`}>
          <div className="flex flex-wrap gap-1">
            <button className="btn btn-primary" disabled={ac.lineUpCleared || ac.phase === 'lined_up' || ac.phase === 'takeoff_roll'} onClick={() => send([{ t: 'LINE_UP' }])}>Line up and wait</button>
            <button className="btn btn-go" disabled={ac.takeoffCleared || ac.phase === 'takeoff_roll'} onClick={() => send([{ t: 'TAKEOFF' }])}>Cleared for takeoff</button>
            <button className="btn btn-danger" disabled={!ac.takeoffCleared && ac.phase !== 'takeoff_roll'} onClick={() => send([{ t: 'CANCEL_TAKEOFF' }])}>Cancel takeoff</button>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Needs {Math.round(t.takeoffDist)} m · wake {t.wake} · departure fix {ac.depFix ?? '—'}{ac.flags.depHdg ? ` · after departure heading ${ac.flags.depHdg}` : ''}</div>
        </Section>
      )}

      {(air || (ac.kind === 'departure' && ac.phase !== 'parked')) && (
        <Section title={air ? (ac.kind === 'arrival' ? 'Approach control — vectors' : 'Departure control') : 'Initial departure instructions'}>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1">
              <span className="text-slate-500 w-12">Heading</span>
              <button className="btn !px-1.5" onClick={() => setHdg(((hdg - 10 + 359) % 360) + 1)}>−10</button>
              <input className="field w-14 text-center" value={String(hdg).padStart(3, '0')} onChange={(e) => setHdg(Math.max(1, Math.min(360, +e.target.value.replace(/\D/g, '') || 360)))} />
              <button className="btn !px-1.5" onClick={() => setHdg((hdg + 10 - 1) % 360 + 1)}>+10</button>
              <button className="btn btn-primary" onClick={() => send([{ t: 'HEADING', hdg: hdg % 360, dir: 'L' }])}>L</button>
              <button className="btn btn-primary" onClick={() => send([{ t: 'HEADING', hdg: hdg % 360 }])}>Fly</button>
              <button className="btn btn-primary" onClick={() => send([{ t: 'HEADING', hdg: hdg % 360, dir: 'R' }])}>R</button>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-500 w-12">Altitude</span>
              <select className="field flex-1" value={alt} onChange={(e) => setAlt(+e.target.value)}>
                {Array.from({ length: (ap.ceiling - 1500) / 500 + 1 }, (_, i) => 1500 + i * 500).filter((a) => a % 1000 === 0 || a < 4000).map((a) => <option key={a} value={a}>{a.toLocaleString()} ft</option>)}
              </select>
              <button className="btn btn-primary" onClick={() => send([{ t: 'ALTITUDE', alt }])}>{alt > ac.alt ? 'Climb' : 'Descend'}</button>
            </div>
            {air && <div className="flex items-center gap-1">
              <span className="text-slate-500 w-12">Speed</span>
              <select className="field flex-1" value={spd} onChange={(e) => setSpd(+e.target.value)}>
                {[140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250].map((v) => <option key={v} value={v}>{v} kt</option>)}
              </select>
              <button className="btn btn-primary" onClick={() => send([{ t: 'SPEED', spd }])}>Set</button>
              <button className="btn" onClick={() => send([{ t: 'SPEED', spd: 0 }])}>Normal</button>
            </div>}
            <div className="flex items-center gap-1">
              <span className="text-slate-500 w-12">Direct</span>
              <select className="field flex-1" value={fix} onChange={(e) => setFix(e.target.value)}>
                <option value="">— fix —</option>
                {ap.fixes.filter((f) => (ac.kind === 'departure' ? f.kind === 'departure' : f.kind !== 'departure')).map((f) => <option key={f.name} value={f.name}>{f.name}{f.name === ac.depFix ? ' (filed)' : ''}{f.kind === 'final' ? ' · final' : f.kind === 'nav' ? ' · base' : ''}</option>)}
              </select>
              <button className="btn btn-primary" disabled={!fix} onClick={() => send([{ t: 'DIRECT', fix }])}>Direct</button>
              {air && ac.kind === 'arrival' && <button className="btn btn-warn" onClick={() => send([{ t: 'HOLD', fix: fix || undefined }])}>Hold</button>}
            </div>
            {ac.phase === 'departure' && <button className="btn w-full" onClick={() => send([{ t: 'HANDOFF' }])}>Hand off to center</button>}
          </div>
        </Section>
      )}
      {air && ac.kind === 'arrival' && (
        <Section title="Approach & landing">
          <div className="space-y-1">
            <RunwaySelect />
            <div className="flex flex-wrap gap-1">
              <button className="btn" onClick={() => send([{ t: 'ASSIGN_RUNWAY', rwy }])}>Expect</button>
              <button className="btn btn-primary" onClick={() => send([{ t: 'APPROACH', rwy }])}>Cleared ILS {rwy}</button>
              <button className="btn btn-go" disabled={!ac.apprCleared || ac.landCleared} onClick={() => send([{ t: 'LAND' }])}>Cleared to land</button>
              <button className="btn btn-danger" disabled={!(ac.phase === 'approach' || ac.phase === 'final')} onClick={() => send([{ t: 'GO_AROUND' }])}>Go around</button>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-500 w-12">Exit</span>
              <select className="field flex-1" value={exit} onChange={(e) => setExit(e.target.value)}><option value="">pilot's choice{ac.exitPref ? ` (now ${ac.exitPref})` : ''}</option>{exits.map((x) => <option key={x}>{x}</option>)}</select>
              <button className="btn" disabled={!exit} onClick={() => send([{ t: 'EXIT', twy: exit }])}>Plan</button>
              <select className="field w-24" value={gate} onChange={(e) => setGate(e.target.value)}><option value="">gate…</option>{gates.slice(0, 40).map((g) => <option key={g.name}>{g.name}</option>)}</select>
              <button className="btn" disabled={!gate} onClick={() => send([{ t: 'ASSIGN_GATE', gate }])}>Gate</button>
            </div>
            <div className="text-[11px] text-slate-500">Vref {t.vref} kt · needs {Math.round(t.landingDist)} m dry · wake {t.wake} · tip: Shift+click the map to vector toward a point</div>
          </div>
        </Section>
      )}
      {ac.phase === 'landing_roll' && ac.kind === 'arrival' && <Section title="Rollout"><div className="text-slate-400">Decelerating on runway {ac.rwy}. The crew will vacate and call ground.</div></Section>}
      {em && <Section title="Emergency handling"><div className="text-slate-300 text-[11.5px]">Give this aircraft priority: clear its path, assign the most suitable runway, and keep the runway free. {em.kind === 'gear' || em.kind === 'hydraulic' || em.kind === 'brake_failure' || em.kind === 'tire_failure' ? 'It will stop on the runway and block it until recovered – plan a runway closure.' : ''}</div></Section>}
    </div>
  );
}

function Dashboard({ sim }: { sim: Sim }) {
  const s = sim.s;
  const a = s.aircraft;
  const c = (f: (x: Aircraft) => boolean) => a.filter(f).length;
  const sc = computeScore(s);
  const gatesOcc = c((x) => x.phase === 'parked' || x.phase === 'pushback');
  const Stat = ({ k, v, col }: { k: string; v: React.ReactNode; col?: string }) => <div className="bg-navy-850 border border-navy-700 rounded px-2 py-1"><div className="text-[10px] text-slate-500 uppercase tracking-wide">{k}</div><div className={`mono text-base ${col ?? 'text-slate-100'}`}>{v}</div></div>;
  return (
    <div className="p-2 space-y-2 overflow-y-auto">
      <div className="flex items-center gap-3 bg-navy-850 border border-navy-600 rounded p-2">
        <div className={`text-3xl font-bold mono ${sc.overall >= 75 ? 'text-radar' : sc.overall >= 50 ? 'text-amber-a' : 'text-red-a'}`}>{sc.overall}</div>
        <div className="text-[11px] text-slate-400 flex-1">Controller rating ({sc.grade})<br />Safety <b className="text-slate-200">{sc.safety}</b> · Efficiency <b className="text-slate-200">{sc.efficiency}</b> · Emergencies <b className="text-slate-200">{sc.emergencyScore}</b></div>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat k="Active" v={c((x) => x.phase !== 'gone' && x.phase !== 'parked' && x.phase !== 'crashed')} />
        <Stat k="In airspace" v={c(isAirborne)} />
        <Stat k="Approaching" v={c((x) => x.phase === 'inbound' || x.phase === 'approach' || x.phase === 'go_around')} />
        <Stat k="Final / landing" v={c((x) => x.phase === 'final' || x.phase === 'landing_roll')} />
        <Stat k="Taxiing" v={c((x) => ['taxi_in', 'taxi_out', 'vacated', 'push_done', 'pushback'].includes(x.phase))} />
        <Stat k="At gates" v={c((x) => x.phase === 'parked')} />
        <Stat k="Await push" v={c((x) => x.phase === 'parked' && x.kind === 'departure' && x.turn?.stage === 'ready')} col="text-amber-a" />
        <Stat k="Dep queue" v={c((x) => ['holding_short', 'lining_up', 'lined_up'].includes(x.phase))} />
        <Stat k="Taking off" v={c((x) => x.phase === 'takeoff_roll' || (x.phase === 'departure' && x.alt < 3000))} />
        <Stat k="Arrivals" v={s.stats.landed} col="text-radar" />
        <Stat k="Departures" v={s.stats.departed} col="text-cyan-a" />
        <Stat k="Holding outside" v={s.spawnQueue} />
        <Stat k="Avg arr delay" v={`${(sc.avgArrDelay / 60).toFixed(1)}m`} />
        <Stat k="Avg dep delay" v={`${(sc.avgDepDelay / 60).toFixed(1)}m`} />
        <Stat k="Gate use" v={`${Math.round((gatesOcc / sim.ap.gates.length) * 100)}%`} />
        <Stat k="Emergencies" v={c((x) => !!x.emergency && !x.emergency.resolved && x.phase !== 'gone')} col={c((x) => !!x.emergency && !x.emergency.resolved && x.phase !== 'gone') ? 'text-red-a' : undefined} />
        <Stat k="Sep. violations" v={s.stats.separationViolations + s.stats.wakeViolations} col={s.stats.separationViolations + s.stats.wakeViolations ? 'text-red-a' : undefined} />
        <Stat k="Incursions" v={s.stats.incursions} col={s.stats.incursions ? 'text-red-a' : undefined} />
      </div>
      <div>
        <div className="panel-h mb-1">Runway utilisation</div>
        {sim.ap.runways.map((r) => {
          const u = s.t > 5 ? Math.min(1, s.rwy[r.id].busySeconds / s.t) : 0;
          return <div key={r.id} className="flex items-center gap-2 text-[11px] mono"><span className="w-16 text-slate-300">{r.id}</span><div className="flex-1 h-2 bg-navy-700 rounded"><div className={`h-full rounded ${s.rwy[r.id].closed ? 'bg-red-a' : 'bg-cyan-a'}`} style={{ width: `${s.rwy[r.id].closed ? 100 : Math.round(u * 100)}%` }} /></div><span className="w-20 text-right text-slate-400">{s.rwy[r.id].closed ? 'CLOSED' : `${Math.round(u * 100)}% · ${s.rwy[r.id].movements}`}</span></div>;
        })}
      </div>
    </div>
  );
}

function Airfield({ sim }: { sim: Sim }) {
  const s = sim.s;
  const bump = () => useUI.setState({ tick: useUI.getState().tick + 1 });
  const [twy, setTwy] = useState('');
  const wx = s.weather;
  const closedNames = [...new Set(s.closedEdges.map((id) => sim.ap.edges[id]?.name).filter(Boolean))];
  return (
    <div className="p-2 space-y-2 overflow-y-auto text-[12px]">
      <div>
        <div className="panel-h mb-1">Weather</div>
        <div className="mono text-[11px] text-radar bg-navy-950 border border-navy-700 rounded p-1.5 break-words">{metar(sim)}</div>
        <div className="grid grid-cols-2 gap-x-4 mt-1">
          <Row k="Wind" v={fmtWind(wx)} /><Row k="Visibility" v={`${wx.visSM} SM`} c={wx.visSM < 1 ? 'text-amber-a' : undefined} />
          <Row k="Ceiling" v={wx.ceilingFt > 50000 ? 'clear' : `${wx.ceilingFt} ft`} /><Row k="Surface" v={wx.surface} c={wx.surface !== 'dry' ? 'text-amber-a' : undefined} />
          <Row k="Temp / dew" v={`${wx.tempC}° / ${wx.dewC}°`} /><Row k="Altimeter" v={(wx.qnh / 100).toFixed(2)} />
          <Row k="Precip" v={wx.precip.replace('_', ' ')} /><Row k="Wind shear" v={wx.windshear ? 'ALERT' : 'none'} c={wx.windshear ? 'text-red-a' : undefined} />
        </div>
        {wx.cells.length > 0 && <div className="text-amber-a text-[11px] mt-1">{wx.cells.length} convective cell(s) in the area – crews will ask to deviate and refuse departures into weather.</div>}
        {(wx.precip === 'snow' || wx.surface === 'ice') && <div className="text-amber-a text-[11px] mt-1">De-icing in effect: departures are de-iced at the gate before they call ready.</div>}
      </div>
      <div>
        <div className="panel-h mb-1">Runway configuration</div>
        <select className="field w-full" value={s.activeConfig.name} onChange={(e) => { const c = sim.ap.configs.find((x) => x.name === e.target.value); if (c) { sim.setConfig(c); bump(); } }}>
          {sim.ap.configs.map((c) => <option key={c.name} value={c.name}>{c.name} — land {c.arr.join(',')} / dep {c.dep.join(',')}</option>)}
        </select>
        <table className="w-full mono text-[11px] mt-1.5">
          <thead className="text-slate-500 text-[10px]"><tr><th className="text-left font-normal">RWY</th><th className="font-normal">Len</th><th className="font-normal">Head</th><th className="font-normal">X-wind</th><th className="font-normal">Use</th><th /></tr></thead>
          <tbody>
            {sim.ap.runways.flatMap((r) => r.ends.map((e) => {
              const w = windComponents(e.hdg, wx.windDir, wx.windKt);
              const st = s.rwy[r.id];
              return <tr key={e.name} className="border-t border-navy-800">
                <td className={st.closed ? 'text-red-a line-through' : 'text-slate-200'}>{e.name}</td>
                <td className="text-center text-slate-400">{Math.round(r.length)}</td>
                <td className={`text-center ${w.head < -5 ? 'text-red-a' : 'text-slate-300'}`}>{w.head >= 0 ? '+' : ''}{Math.round(w.head)}</td>
                <td className={`text-center ${w.cross > 20 ? 'text-amber-a' : 'text-slate-300'}`}>{Math.round(w.cross)}</td>
                <td className="text-center">{s.activeConfig.arr.includes(e.name) ? <span className="text-radar">ARR </span> : ''}{s.activeConfig.dep.includes(e.name) ? <span className="text-cyan-a">DEP</span> : ''}</td>
                <td className="text-right">{e === r.ends[0] && <button className={`btn !py-0 !text-[10px] ${st.closed ? 'btn-go' : 'btn-danger'}`} onClick={() => { sim.setRunwayClosed(e.name, !st.closed, 'controller'); bump(); }}>{st.closed ? 'Reopen' : 'Close'}</button>}</td>
              </tr>;
            }))}
          </tbody>
        </table>
      </div>
      <div>
        <div className="panel-h mb-1">Taxiway closures</div>
        <div className="flex gap-1"><input className="field flex-1" placeholder="taxiway e.g. M" value={twy} onChange={(e) => setTwy(e.target.value.toUpperCase())} />
          <button className="btn btn-danger" onClick={() => { if (!sim.setTaxiwayClosed(twy, true)) useUI.getState().notify(`Taxiway ${twy} not found`, 'error'); setTwy(''); bump(); }}>Close</button></div>
        <div className="flex flex-wrap gap-1 mt-1">{closedNames.map((n) => <button key={n} className="btn btn-warn !py-0" onClick={() => { sim.setTaxiwayClosed(n, false); bump(); }}>{n} ✕ reopen</button>)}</div>
      </div>
      <div>
        <div className="panel-h mb-1">AI delegation (optional – default fully manual)</div>
        <div className="grid grid-cols-2 gap-1">
          {(['delivery', 'ground', 'tower', 'approach', 'departure'] as Position[]).map((p) => (
            <button key={p} className={`btn capitalize ${s.cfg.delegation[p] ? 'btn-on' : ''}`} onClick={() => useUI.getState().delegate(p, !s.cfg.delegation[p])}>{s.cfg.delegation[p] ? '● AI' : '○ You'} · {p}</button>
          ))}
        </div>
        <div className="text-[10.5px] text-slate-500 mt-1">AI controllers issue instructions through the same clearance system and rules as you. They are basic assistants and can struggle in heavy traffic. Take a position back at any time.</div>
      </div>
      <div className="text-[10.5px] text-slate-500 border-t border-navy-700 pt-1.5"><b className="text-slate-400">Data:</b> {sim.ap.dataNote} Flights are fictional but plausible simulated traffic – not live data.</div>
    </div>
  );
}

export default function RightPanel() {
  const sim = useSim();
  const selectedId = useUI((s) => s.selectedId);
  const [tab, setTab] = useState<'ops' | 'field'>('ops');
  const ac = sim.s.aircraft.find((a) => a.id === selectedId);
  if (ac) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-navy-900">
        <div className="flex items-center justify-between px-2 py-1 border-b border-navy-600"><span className="panel-h">Selected aircraft</span><button className="btn !py-0" onClick={() => useUI.getState().select(null)}>✕ Airport overview</button></div>
        <AircraftCard sim={sim} ac={ac} />
        {ac.phase !== 'gone' && ac.phase !== 'crashed' && <CommandPanel sim={sim} ac={ac} />}
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 flex flex-col bg-navy-900">
      <Tabs value={tab} onChange={setTab} items={[['ops', 'Operations'], ['field', 'Airfield · Weather · AI']]} />
      {tab === 'ops' ? <Dashboard sim={sim} /> : <Airfield sim={sim} />}
    </div>
  );
}
