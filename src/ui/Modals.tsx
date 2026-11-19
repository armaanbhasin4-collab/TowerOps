import { useEffect, useRef, useState } from 'react';
import { useUI } from '../store';
import { computeScore } from '../sim/scoring';
import { fmtClock, fmtDur } from '../sim/util';
import { draw, fitAirport, fitRadar, type Camera } from '../render/map';
import { getHistory } from '../saves';
import { CAREER } from '../sim/scenarios';
import { ttsSupported, speechSupported, stopSpeaking } from './speech';
import { sevColor } from './common';

function Shell({ title, children, wide, onClose }: { title: string; children: React.ReactNode; wide?: boolean; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className={`bg-navy-900 border border-navy-600 rounded-lg shadow-2xl max-h-[92vh] flex flex-col ${wide ? 'w-[1000px]' : 'w-[640px]'} max-w-full`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-navy-600"><h2 className="text-sm font-semibold tracking-wide text-slate-100 uppercase">{title}</h2><button className="btn" onClick={onClose}>✕</button></div>
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function SettingsModal() {
  const { settings, setSettings, setModal } = useUI();
  const Chk = ({ k, label }: { k: keyof typeof settings; label: string }) => (
    <label className="flex items-center gap-2 py-0.5"><input type="checkbox" checked={!!settings[k]} onChange={(e) => { setSettings({ [k]: e.target.checked }); if (k === 'tts' && !e.target.checked) stopSpeaking(); }} /> {label}</label>
  );
  return (
    <Shell title="Settings" onClose={() => setModal(null)}>
      <div className="grid grid-cols-2 gap-6 text-[13px]">
        <div>
          <div className="panel-h mb-1">Display</div>
          <Chk k="showRings" label="Range rings & airspace boundary" />
          <Chk k="showFixes" label="Navigation fixes" />
          <Chk k="showTrails" label="History trails" />
          <Chk k="showVectors" label="1-minute velocity vectors" />
          <Chk k="showWeather" label="Weather overlay" />
          <Chk k="showLabels" label="Taxiway / gate / aircraft labels" />
          <div className="mt-2 flex items-center gap-2">Data tags
            {[0, 1, 2].map((l) => <button key={l} className={`btn ${settings.tagLevel === l ? 'btn-on' : ''}`} onClick={() => setSettings({ tagLevel: l as 0 | 1 | 2 })}>{['Minimal', 'Standard', 'Full'][l]}</button>)}
          </div>
          <div className="mt-2 flex items-center gap-2">Traffic filter
            {(['all', 'arr', 'dep'] as const).map((l) => <button key={l} className={`btn ${settings.filter === l ? 'btn-on' : ''}`} onClick={() => setSettings({ filter: l })}>{{ all: 'All', arr: 'Arrivals', dep: 'Departures' }[l]}</button>)}
          </div>
        </div>
        <div>
          <div className="panel-h mb-1">Audio & voice</div>
          <Chk k="sound" label="Alert and request tones" />
          <label className="flex items-center gap-2 py-0.5"><input type="checkbox" disabled={!ttsSupported()} checked={settings.tts} onChange={(e) => { setSettings({ tts: e.target.checked }); if (!e.target.checked) stopSpeaking(); }} /> Synthesised pilot voices {ttsSupported() ? '' : '(not supported here)'}</label>
          <div className="text-[11px] text-slate-500 mt-1">Voice commands: {speechSupported() ? 'available – use the 🎙 button next to the command line.' : 'not available in this browser. Everything works with mouse and keyboard.'}</div>
          <div className="panel-h mt-3 mb-1">Layout</div>
          <div className="flex gap-2">
            {(['standard', 'wide', 'focus'] as const).map((l) => <button key={l} className={`btn capitalize ${settings.layout === l ? 'btn-on' : ''}`} onClick={() => setSettings({ layout: l })}>{l}</button>)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">Standard: three columns. Wide: broader side panels for large monitors. Focus: map and console only.</div>
          <div className="panel-h mt-3 mb-1">Keys</div>
          <div className="text-[11px] text-slate-400">Space pause · 1–4 speed · R radar · G ground · T tower · / command line · Esc deselect · Shift+click map = heading to point · double-click aircraft = follow</div>
        </div>
      </div>
    </Shell>
  );
}

function HelpModal() {
  const setModal = useUI((s) => s.setModal);
  const rows: [string, string][] = [
    ['DAL1426 CLEARED AS FILED', 'Departure (IFR) clearance'],
    ['DAL1426 PUSHBACK APPROVED [FACE NORTH]', 'Pushback'],
    ['DAL1426 TAXI 27R VIA B M [HOLD SHORT F]', 'Taxi to a runway via taxiways'],
    ['DAL1426 CROSS 26L', 'Cross a runway'],
    ['DAL1426 HOLD POSITION / CONTINUE', 'Stop / resume taxi'],
    ['DAL1426 LINE UP WAIT 27R', 'Enter runway and wait'],
    ['DAL1426 CLEARED TAKEOFF 27R', 'Takeoff clearance'],
    ['DAL1426 CANCEL TAKEOFF', 'Cancel / reject takeoff'],
    ['DAL1426 CLIMB 14000, DIRECT SMKEY', 'Departure instructions'],
    ['DAL1426 CONTACT CENTER', 'Hand off (≥10,000 ft, on course)'],
    ['UAL892 HEADING 240 / TURN LEFT HEADING 240', 'Vector'],
    ['UAL892 DESCEND 4000 / SPEED 180', 'Altitude / speed'],
    ['UAL892 DIRECT B26RN / HOLD LOGEN', 'Direct to a fix / hold'],
    ['UAL892 CLEARED ILS 26L', 'Approach clearance'],
    ['UAL892 CLEARED LAND 26L', 'Landing clearance'],
    ['UAL892 GO AROUND', 'Missed approach'],
    ['UAL892 EXIT B4 / GATE C12', 'Plan runway exit / assign gate'],
    ['UAL892 TAXI GATE C12 VIA N B', 'Taxi to gate'],
    ['UAL892 TOW', 'Tug repositions a blocked aircraft'],
    ['RWY 27R CLOSE / RWY 27R OPEN', 'Close or reopen a runway'],
    ['CONFIG EAST', 'Change runway configuration'],
  ];
  return (
    <Shell title="Command reference" onClose={() => setModal(null)}>
      <p className="text-[12.5px] text-slate-300 mb-2">You hold every position. Nothing moves across a clearance boundary until you say so: aircraft stay at the gate, at hold lines, in holds and on final until cleared. Several instructions can be combined in one transmission, separated by commas. With an aircraft selected you can omit the callsign.</p>
      <table className="w-full text-[12px]"><tbody>{rows.map(([c, d]) => <tr key={c} className="border-b border-navy-800"><td className="mono text-cyan-a py-1 pr-3 whitespace-nowrap">{c}</td><td className="text-slate-300">{d}</td></tr>)}</tbody></table>
      <p className="text-[11.5px] text-slate-500 mt-3">Approach tip: each runway has a final fix (F26R, 12 NM out) and two base fixes (B26RN / B26RS, 16 NM out and 5.5 NM abeam). Send an arrival direct to a base fix at 4,000–5,000 ft, then turn it ~40° toward the final, descend to 3,000 ft and clear the ILS. Pilots refuse unsafe or impossible clearances with "unable" and take their own safety actions (go-around, rejected takeoff) which are always reported on the radio.</p>
    </Shell>
  );
}

function ReportModal() {
  const { sim, setModal, exit, careerLevel } = useUI();
  if (!sim) return null;
  const sc = computeScore(sim.s);
  const st = sim.s.stats;
  const hist = getHistory().filter((h) => h.airport === sim.ap.iata).slice(0, 6);
  const lvl = careerLevel ? CAREER.find((l) => l.id === careerLevel) : undefined;
  const passed = lvl ? sc.overall >= lvl.pass && st.collisions === 0 : false;
  const timeline = sim.s.events.filter((e) => e.sev !== 'info').slice(-60);
  return (
    <Shell title={sim.s.over ? 'Session report' : 'Performance so far'} wide onClose={() => (sim.s.over ? undefined : setModal(null))}>
      {sim.s.overReason && <div className="mb-3 px-3 py-2 rounded border border-amber-a/50 bg-amber-950/30 text-amber-a">{sim.s.overReason}</div>}
      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-1">
          <div className="bg-navy-850 border border-navy-600 rounded p-4 text-center">
            <div className={`text-6xl font-bold mono ${sc.overall >= 75 ? 'text-radar' : sc.overall >= 50 ? 'text-amber-a' : 'text-red-a'}`}>{sc.overall}</div>
            <div className="text-slate-400 mt-1">Controller rating · grade {sc.grade}</div>
            <div className="mt-2 text-[12px] text-slate-300">Safety {sc.safety} · Efficiency {sc.efficiency} · Emergencies {sc.emergencyScore}</div>
            {lvl && <div className={`mt-2 font-semibold ${passed ? 'text-radar' : 'text-red-a'}`}>{passed ? `Level passed (needed ${lvl.pass}) – next level unlocked` : `Not passed – ${lvl.pass} required${st.collisions ? ' and no accidents' : ''}`}</div>}
          </div>
          <div className="mt-3 text-[12px] space-y-0.5">
            <div className="flex justify-between"><span className="text-slate-500">Airport</span><span>{sim.ap.icao}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Session length</span><span className="mono">{fmtDur(sim.s.t)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Landed / departed</span><span className="mono">{st.landed} / {st.departed}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Parked at gates</span><span className="mono">{st.parked}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Instructions issued</span><span className="mono">{st.commands} ({st.rejectedCommands} invalid)</span></div>
          </div>
          {hist.length > 1 && <div className="mt-3"><div className="panel-h mb-1">Previous sessions at {sim.ap.iata}</div>{hist.map((h, i) => <div key={i} className="flex justify-between text-[11.5px] mono text-slate-400"><span>{new Date(h.date).toLocaleDateString()} {h.difficulty}</span><span>{h.landed + h.departed} mov</span><span className={h.overall >= 75 ? 'text-radar' : 'text-amber-a'}>{h.overall}</span></div>)}</div>}
        </div>
        <div className="col-span-1">
          <div className="panel-h mb-1">Score breakdown</div>
          <table className="w-full text-[12px]"><tbody>
            {sc.breakdown.map((b) => <tr key={b.label} className="border-b border-navy-800"><td className="py-1 text-slate-300">{b.label}</td><td className="mono text-right text-slate-200">{b.value}</td><td className={`mono text-right w-12 ${b.impact < 0 ? 'text-red-a' : 'text-slate-600'}`}>{b.impact < 0 ? b.impact : '—'}</td></tr>)}
          </tbody></table>
          <div className="text-[11px] text-slate-500 mt-2">Rating = 62% safety + 30% efficiency + 8% emergency handling. Any accident caps the rating at 20.</div>
        </div>
        <div className="col-span-1 min-h-0">
          <div className="panel-h mb-1">Timeline of significant events</div>
          <div className="max-h-[360px] overflow-y-auto text-[11.5px] space-y-0.5">
            {timeline.map((e, i) => <div key={i} className={`flex gap-2 ${sevColor(e.sev)}`}><span className="mono text-slate-600 shrink-0">{fmtClock(sim.s.cfg.startClock + e.t, true)}</span><span className="flex-1">{e.text}</span><button className="btn !py-0 !text-[10px] self-start" onClick={() => setModal('replay', e.t)}>▶</button></div>)}
            {!timeline.length && <div className="text-slate-500">A clean session – no incidents recorded.</div>}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        {!sim.s.over && <button className="btn" onClick={() => setModal(null)}>Continue controlling</button>}
        <button className="btn" onClick={() => setModal('replay')}>Review movement replay</button>
        <button className="btn btn-primary" onClick={() => { const cfg = { ...sim.s.cfg }; useUI.getState().start({ ...cfg, emptyStart: false }, careerLevel ?? undefined); }}>Restart scenario</button>
        <button className="btn btn-go" onClick={exit}>Main menu</button>
      </div>
    </Shell>
  );
}

function ReplayModal() {
  const { sim, setModal, replayAt, selectedId } = useUI();
  const ref = useRef<HTMLCanvasElement>(null);
  const frames = sim?.s.track ?? [];
  const startIdx = replayAt !== null ? Math.max(0, frames.findIndex((f) => f.t >= replayAt - 60)) : Math.max(0, frames.length - 150);
  const [idx, setIdx] = useState(startIdx);
  const [playing, setPlaying] = useState(true);
  const [zoomGround, setZoomGround] = useState(true);
  const cam = useRef<Camera | null>(null);
  useEffect(() => {
    if (!playing) return;
    const h = setInterval(() => setIdx((i) => (i + 1 >= frames.length ? (setPlaying(false), i) : i + 1)), 120);
    return () => clearInterval(h);
  }, [playing, frames.length]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !sim || !frames[idx]) return;
    const W = 960, H = 520, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    // centre on the incident location if known
    const ev = replayAt !== null ? sim.s.events.find((e) => Math.abs(e.t - replayAt) < 0.01 && e.x !== undefined) : undefined;
    const base = zoomGround ? fitAirport(sim.ap, W, H) : fitRadar(sim.ap, W, H);
    cam.current = ev && Math.hypot(ev.x!, ev.y!) > 6000 ? { cx: ev.x!, cy: ev.y!, scale: 0.012 } : ev && zoomGround ? { cx: ev.x!, cy: ev.y!, scale: Math.max(base.scale, 0.3) } : base;
    draw(cv.getContext('2d')!, W, H, sim, cam.current, { mode: zoomGround ? 'ground' : 'radar', selectedId, tagLevel: 1, showFixes: true, showRings: true, showTrails: false, showWeather: false, showLabels: true, showVectors: false, filter: 'all', guidance: false, time: 0, replay: frames[idx] });
  }, [idx, sim, frames, zoomGround, replayAt, selectedId]);
  if (!sim) return null;
  const f = frames[idx];
  const near = f ? sim.s.events.filter((e) => e.sev !== 'info' && Math.abs(e.t - f.t) < 8) : [];
  return (
    <Shell title="Replay – recorded aircraft movements" wide onClose={() => setModal(sim.s.over ? 'report' : null)}>
      {!frames.length ? <div className="text-slate-400">Nothing recorded yet.</div> : <>
        <canvas ref={ref} style={{ width: 960, height: 520 }} className="rounded border border-navy-600 max-w-full" />
        <div className="flex items-center gap-2 mt-2">
          <button className="btn btn-primary w-16" onClick={() => { if (idx >= frames.length - 1) setIdx(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
          <input type="range" className="flex-1" min={0} max={frames.length - 1} value={idx} onChange={(e) => { setIdx(+e.target.value); setPlaying(false); }} />
          <span className="mono text-slate-300 w-20 text-right">{f ? fmtClock(sim.s.cfg.startClock + f.t, true) : ''}</span>
          <button className="btn" onClick={() => setZoomGround(!zoomGround)}>{zoomGround ? 'Radar scale' : 'Airport scale'}</button>
        </div>
        <div className="mt-1 text-[12px] min-h-[36px]">{near.map((e, i) => <div key={i} className={sevColor(e.sev)}>{e.text}</div>)}</div>
        <div className="text-[11px] text-slate-500">Positions are recorded every 2 simulated seconds for the last 30 minutes of the session, straight from the simulation state.</div>
      </>}
    </Shell>
  );
}

export default function Modals() {
  const modal = useUI((s) => s.modal);
  if (modal === 'settings') return <SettingsModal />;
  if (modal === 'help') return <HelpModal />;
  if (modal === 'report') return <ReportModal />;
  if (modal === 'replay') return <ReplayModal />;
  return null;
}
