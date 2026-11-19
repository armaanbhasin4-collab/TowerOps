import { lazy, Suspense, useEffect, useState } from 'react';
import { useUI } from '../store';
import { computeScore } from '../sim/scoring';
import { fmtClock, fmtDur } from '../sim/util';
import { fmtWind } from '../sim/weather';
import MapCanvas from './MapCanvas';
import LeftPanel from './LeftPanel';
import RightPanel from './RightPanel';
import BottomPanel from './BottomPanel';
import Modals from './Modals';
import { useSim } from './common';
import type { TowerCam } from './TowerView3D';

const TowerView3D = lazy(() => import('./TowerView3D'));

function TopBar({ panels, setPanels }: { panels: { l: boolean; r: boolean; b: boolean }; setPanels: (p: { l: boolean; r: boolean; b: boolean }) => void }) {
  const sim = useSim();
  const { speed, paused, view, setView, setSpeed, togglePause, setModal, save, endSession } = useUI();
  const s = sim.s;
  const wx = s.weather;
  const sc = computeScore(s);
  const del = Object.values(s.cfg.delegation).filter(Boolean).length;
  return (
    <div className="h-11 shrink-0 flex items-center gap-3 px-3 bg-navy-850 border-b border-navy-600 text-[12px] whitespace-nowrap overflow-hidden">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="mono text-cyan-a font-bold text-[15px]">{sim.ap.icao}</span>
        <span className="text-slate-300 truncate max-w-[230px]">{sim.ap.name}</span>
        {sim.ap.fictional && <span className="px-1 rounded bg-amber-900/50 text-amber-a text-[10px]">FICTIONAL</span>}
      </div>
      <div className="mono text-radar text-[15px]">{fmtClock(s.cfg.startClock + s.t, true)}</div>
      <div className="mono text-slate-300" title="wind · visibility · surface">{fmtWind(wx)} · {wx.visSM}SM{wx.precip !== 'none' ? ` · ${wx.precip.replace('_', ' ')}` : ''}{wx.surface !== 'dry' ? ` · ${wx.surface}` : ''}{wx.windshear ? ' · WS' : ''}</div>
      <div className="mono hidden xl:block"><span className="text-slate-500">ARR</span> <span className="text-radar">{s.activeConfig.arr.join(' ')}</span> <span className="text-slate-500 ml-1">DEP</span> <span className="text-cyan-a">{s.activeConfig.dep.join(' ')}</span></div>
      <div className="capitalize text-slate-400 hidden lg:block">{s.cfg.mode} · {s.cfg.difficulty.preset}{del ? ` · AI×${del}` : ''}{s.cfg.duration ? ` · ${fmtDur(Math.max(0, s.cfg.duration - s.t))} left` : ''}</div>
      <button className={`mono font-bold px-1.5 rounded border ${sc.overall >= 75 ? 'text-radar border-emerald-800' : sc.overall >= 50 ? 'text-amber-a border-amber-800' : 'text-red-a border-red-900'}`} title="Controller rating – click for details" onClick={() => setModal('report')}>{sc.overall}</button>
      <div className="ml-auto flex items-center gap-1">
        {(['radar', 'ground', 'tower'] as const).map((v) => <button key={v} className={`btn ${view === v ? 'btn-on' : ''}`} onClick={() => setView(v)}>{{ radar: 'Radar', ground: 'Ground', tower: 'Tower 3D' }[v]}</button>)}
        <span className="w-2" />
        <button className={`btn w-8 ${paused ? 'btn-warn' : ''}`} title="Pause (Space)" onClick={togglePause}>{paused ? '▶' : '❚❚'}</button>
        {[1, 2, 4, 8].map((x) => <button key={x} className={`btn !px-1.5 ${speed === x && !paused ? 'btn-on' : ''}`} onClick={() => setSpeed(x)}>{x}×</button>)}
        <span className="w-2" />
        <button className={`btn !px-1.5 ${panels.l ? 'btn-on' : ''}`} title="Toggle left panel" onClick={() => setPanels({ ...panels, l: !panels.l })}>◧</button>
        <button className={`btn !px-1.5 ${panels.b ? 'btn-on' : ''}`} title="Toggle console" onClick={() => setPanels({ ...panels, b: !panels.b })}>⬓</button>
        <button className={`btn !px-1.5 ${panels.r ? 'btn-on' : ''}`} title="Toggle right panel" onClick={() => setPanels({ ...panels, r: !panels.r })}>◨</button>
        <button className="btn" onClick={() => save()}>Save</button>
        <button className="btn" onClick={() => setModal('settings')}>Settings</button>
        <button className="btn btn-danger" onClick={endSession}>End</button>
      </div>
    </div>
  );
}

export default function GameScreen() {
  const { view, paused, toast, settings, selectedId, select } = useUI();
  const sim = useUI((s) => s.sim);
  const [panels, setPanels] = useState({ l: true, r: true, b: true });
  const [cam, setCam] = useState<TowerCam>('tower');
  const [bh, setBh] = useState(230);
  useEffect(() => { if (settings.layout === 'focus') setPanels({ l: false, r: false, b: true }); else setPanels({ l: true, r: true, b: true }); }, [settings.layout]);
  useEffect(() => { if (toast) { const h = setTimeout(() => useUI.setState({ toast: null }), 4500); return () => clearTimeout(h); } }, [toast]);
  if (!sim) return null;
  const lw = settings.layout === 'wide' ? 400 : 330, rw = settings.layout === 'wide' ? 420 : 350;
  const startDrag = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = bh;
    const mv = (ev: PointerEvent) => setBh(Math.max(110, Math.min(520, h0 + (y0 - ev.clientY))));
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="h-full flex flex-col bg-navy-950">
      <TopBar panels={panels} setPanels={setPanels} />
      <div className="flex-1 min-h-0 flex">
        {panels.l && <div style={{ width: lw }} className="shrink-0 border-r border-navy-600 min-h-0">{<LeftPanel />}</div>}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 relative">
            {view === 'tower' ? (
              <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-slate-500">Loading 3D view…</div>}>
                <TowerView3D sim={sim} selectedId={selectedId} onSelect={(id) => select(id)} cam={cam} onCam={setCam} />
              </Suspense>
            ) : <MapCanvas mode={view} />}
            {paused && !sim.s.over && <div className="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-amber-900/80 border border-amber-a text-amber-a text-xs tracking-widest pointer-events-none">PAUSED — you can still inspect aircraft and prepare instructions</div>}
            {toast && <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded border text-[12.5px] max-w-[80%] shadow-lg ${toast.kind === 'error' ? 'bg-red-950 border-red-a text-red-200' : toast.kind === 'ok' ? 'bg-emerald-950 border-emerald-600 text-emerald-200' : 'bg-navy-800 border-navy-600 text-slate-200'}`}>{toast.text}</div>}
          </div>
          {panels.b && <>
            <div className="h-1 bg-navy-600 hover:bg-cyan-a cursor-row-resize shrink-0" onPointerDown={startDrag} />
            <div style={{ height: bh }} className="shrink-0 min-h-0"><BottomPanel /></div>
          </>}
        </div>
        {panels.r && <div style={{ width: rw }} className="shrink-0 border-l border-navy-600 min-h-0">{<RightPanel />}</div>}
      </div>
      <Modals />
    </div>
  );
}
