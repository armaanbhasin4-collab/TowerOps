/** Flight setup: aircraft, kind of flight, airports, realism level, weather. */
import { useMemo, useState } from 'react';
import { useUI } from '../../store';
import { ACDEF } from '../../pilot/aircraft';
import { ASSIST_PRESETS, PRESET_INFO, configProblems, defaultPilotConfig } from '../../pilot/sim';
import { pilotAirports, routeDistanceNm } from '../../pilot/world';
import type { AcKind, FlightKind, PilotConfig, RealismPreset, StartState } from '../../pilot/types';

const KINDS: [FlightKind, string, string][] = [
  ['route', 'Airport to airport', 'A complete flight: start-up, taxi, takeoff, cruise, approach, landing, taxi in and shutdown.'],
  ['pattern', 'Traffic pattern', 'Circuits at one airport: takeoff, crosswind, downwind, base, final. Touch-and-goes are scored one by one.'],
  ['approach', 'Approach & landing', 'Start in the air on final approach and practise the landing.'],
];
const STARTS: [StartState, string][] = [['cold', 'Cold and dark at the stand'], ['ready', 'Powered up at the stand, engines off'], ['running', 'Engines running, ready to taxi'], ['runway', 'Lined up on the runway']];
const WX: [PilotConfig['weather'], string][] = [['clear', 'Clear, light wind'], ['breezy', 'Breezy (14 kt, some turbulence low down)'], ['crosswind', 'Crosswind (15 kt across the runway)'], ['overcast', 'Overcast at 1800 ft'], ['lowvis', 'Low visibility (2.4 km, cloud at 500 ft)']];

export default function PilotSetup() {
  const { exit, startPilot } = useUI.getState();
  const [cfg, setCfg] = useState<PilotConfig>(defaultPilotConfig);
  const airports = useMemo(pilotAirports, []);
  const set = (c: Partial<PilotConfig>) => setCfg({ ...cfg, ...c });
  const def = ACDEF[cfg.aircraft];
  const nm = cfg.kind === 'route' ? routeDistanceNm(cfg.depId, cfg.destId) : 0;
  const problems = configProblems(cfg);
  const preset = cfg.assists.preset;
  const mins = cfg.kind === 'route' ? Math.round((nm / (cfg.aircraft === 'jet' ? 420 : 105)) * 60 + (cfg.aircraft === 'jet' ? 30 : 15)) : 0;
  const pickPreset = (k: RealismPreset) => set({ assists: { ...ASSIST_PRESETS[k] } });
  const card = (on: boolean) => `text-left rounded border p-3 transition-colors ${on ? 'border-cyan-a bg-navy-700' : 'border-navy-600 bg-navy-850 hover:border-navy-600 hover:bg-navy-800'}`;
  return (
    <div className="h-full overflow-y-auto bg-[radial-gradient(ellipse_at_top,#0f2236_0%,#050a11_60%)]">
      <div className="max-w-[1080px] mx-auto px-6 py-6">
        <div className="flex items-end justify-between border-b border-navy-600 pb-4">
          <div>
            <div className="text-[11px] tracking-[0.35em] text-cyan-a uppercase">TowerOps · Flight deck</div>
            <h1 className="text-3xl font-semibold text-slate-100">Fly it yourself</h1>
            <div className="text-slate-400 text-[13px] mt-1">Take the pilot's seat: from a cold, dark cockpit to shutdown at the destination, at the level of detail you choose.</div>
          </div>
          <button className="btn" onClick={exit}>← Back to the tower</button>
        </div>

        <div className="panel-h mt-5 mb-2">1 · Aircraft</div>
        <div className="grid grid-cols-2 gap-3">
          {(['c172', 'jet'] as AcKind[]).map((k) => (
            <button key={k} className={card(cfg.aircraft === k)} onClick={() => set({ aircraft: k })} data-testid={`ac-${k}`}>
              <div className="text-slate-100 text-[15px] font-semibold">{k === 'c172' ? 'Piston trainer' : 'Twin-jet airliner'}</div>
              <div className="text-slate-400 text-[12px]">{ACDEF[k].name}</div>
              <div className="text-slate-500 text-[12px] mt-1">{k === 'c172' ? 'Where flight training starts: magnetos, mixture, trim, rudder, the traffic pattern. Cruise about 110 kt.' : 'Battery, APU, hydraulics, bleed air, engine start, pushback, autopilot and ILS. Cruise Mach 0.78.'}</div>
            </button>
          ))}
        </div>

        <div className="panel-h mt-5 mb-2">2 · Flight</div>
        <div className="grid grid-cols-3 gap-3">
          {KINDS.map(([k, name, blurb]) => (
            <button key={k} className={card(cfg.kind === k)} onClick={() => set({ kind: k })} data-testid={`kind-${k}`}>
              <div className="text-slate-100 font-semibold">{name}</div><div className="text-slate-500 text-[12px] mt-1">{blurb}</div>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-3 text-[13px]">
          <label className="flex items-center gap-2"><span className="text-slate-400">{cfg.kind === 'route' ? 'From' : 'Airport'}</span>
            <select className="field" value={cfg.depId} onChange={(e) => set({ depId: e.target.value })} data-testid="dep">{airports.map((a) => <option key={a.id} value={a.id}>{a.icao} · {a.name}</option>)}</select>
          </label>
          {cfg.kind === 'route' && <label className="flex items-center gap-2"><span className="text-slate-400">To</span>
            <select className="field" value={cfg.destId} onChange={(e) => set({ destId: e.target.value })} data-testid="dest">{airports.map((a) => <option key={a.id} value={a.id}>{a.icao} · {a.name}</option>)}</select>
          </label>}
          {cfg.kind === 'route' && cfg.depId !== cfg.destId && <span className="text-slate-300 mono">{Math.round(nm)} NM · about {mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`} in real time{mins > 40 ? ' (time acceleration is available in cruise)' : ''}</span>}
        </div>
        <div className="text-[12px] text-slate-500 mt-1">Short training hops: LGA ↔ JFK (9 NM) and ATL ↔ Cedar Valley (about 85 NM; Cedar Valley is a fictional field). This aircraft's range is {def.rangeNm} NM.</div>
        {problems.map((m) => <div key={m} className="text-amber-a text-[12.5px] mt-1">{m}</div>)}

        <div className="panel-h mt-5 mb-2">3 · How much do you want to do yourself?</div>
        <div className="grid grid-cols-4 gap-3">
          {(Object.keys(PRESET_INFO) as RealismPreset[]).map((k) => (
            <button key={k} className={card(preset === k)} onClick={() => pickPreset(k)} data-testid={`preset-${k}`}>
              <div className="text-slate-100 font-semibold">{PRESET_INFO[k].name}</div><div className="text-slate-500 text-[12px] mt-1">{PRESET_INFO[k].blurb}</div>
            </button>
          ))}
        </div>
        {cfg.kind !== 'approach' && (
          <div className="flex flex-wrap items-center gap-3 mt-3 text-[13px]">
            <label className="flex items-center gap-2"><span className="text-slate-400">Start</span>
              <select className="field" value={cfg.assists.start} onChange={(e) => set({ assists: { ...cfg.assists, start: e.target.value as StartState } })}>{STARTS.filter(([s]) => cfg.kind !== 'pattern' || true).map(([s, l]) => <option key={s} value={s}>{l}</option>)}</select>
            </label>
            <span className="text-slate-500 text-[12px]">Every assist can be switched on or off during the flight (Assists tab), and the instructor can take over at any time.</span>
          </div>
        )}

        <div className="panel-h mt-5 mb-2">4 · Conditions</div>
        <div className="flex flex-wrap items-center gap-4 text-[13px]">
          <label className="flex items-center gap-2"><span className="text-slate-400">Weather</span>
            <select className="field" value={cfg.weather} onChange={(e) => set({ weather: e.target.value as PilotConfig['weather'] })}>{WX.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </label>
          <label className="flex items-center gap-2"><span className="text-slate-400">Time of day</span>
            <input type="range" min={0} max={23.5} step={0.5} value={cfg.hour} onChange={(e) => set({ hour: +e.target.value })} className="accent-cyan-400 w-48" />
            <span className="mono text-slate-200 w-12">{String(Math.floor(cfg.hour)).padStart(2, '0')}:{cfg.hour % 1 ? '30' : '00'}</span>
          </label>
        </div>

        <div className="flex items-center gap-4 mt-6">
          <button className="btn btn-go !text-[15px] !px-6 !py-2" disabled={problems.length > 0} onClick={() => startPilot(cfg)} data-testid="fly">Start flight</button>
          <span className="text-slate-500 text-[12px]">Keyboard: arrows = yoke, A/D = rudder, W/S = throttle. A full key list is on the Briefing tab in the cockpit.</span>
        </div>
        <div className="text-[11.5px] text-slate-500 mt-5 border-t border-navy-700 pt-3 leading-relaxed">
          This is a procedure and handling familiarisation tool, not a certified trainer. The two aircraft are generic models tuned from public, rounded figures; checklists are abbreviated generic procedures; the world is flat with no terrain; headings are true; waypoints and frequencies are synthetic; there is no other traffic and no system failures. Use it to learn the order and logic of a flight, then learn your real aircraft from its own handbook and your instructor.
        </div>
      </div>
    </div>
  );
}
