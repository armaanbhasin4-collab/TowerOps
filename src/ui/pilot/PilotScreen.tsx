/** The flight deck: outside view, instruments, panels, input handling and the real-time loop. */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useUI } from '../../store';
import { ACDEF } from '../../pilot/aircraft';
import { apButton } from '../../pilot/autopilot';
import { nextItem } from '../../pilot/checklists';
import { DT, createPilot, maxAccel, setInstructor, stepPilot } from '../../pilot/sim';
import { isJet, setControl } from '../../pilot/systems';
import type { Inputs, PilotConfig, PilotState } from '../../pilot/types';
import { speak, stopSpeaking, tone } from '../speech';
import { drawENG, drawND, drawPFD } from './instruments';
import { AssistPanel, BriefPanel, DebriefModal, FlightPanel, HudStrip, Mcp, QuickControls, SwitchPanel } from './Panels';
import type { PilotCam } from './PilotView3D';

const PilotView3D = lazy(() => import('./PilotView3D'));

const CALLOUT: Record<string, string> = {
  'V1': 'V one', rotate: 'rotate', 'positive rate': 'positive rate', minimums: 'minimums', autopilot: 'autopilot disconnect', stall: 'stall, stall',
  overspeed: 'overspeed', config: 'configuration', 'sink rate': 'sink rate', 'pull up': 'pull up! pull up!', 'too low gear': 'too low, gear', 'too low flaps': 'too low, flaps',
  glideslope: 'glideslope', 'bank angle': 'bank angle', "don't sink": "don't sink", '80 knots': 'eighty knots', tod: 'top of descent',
};
const RANGES = [0.5, 1, 2.5, 5, 10, 20, 40, 80, 160, 320];
type Tab = 'flight' | 'overhead' | 'pedestal' | 'assists' | 'brief';
const PEDESTAL_IDS = new Set(['fuelLever1', 'fuelLever2', 'autobrake', 'com', 'nav', 'squawk', 'xpdr', 'baro']);
const QUICK_IDS = new Set(['flaps', 'gear', 'parkBrake', 'spoiler', 'spoilerArm', 'throttle', 'mixture', 'trim', 'reverse']);

export default function PilotScreen({ cfg }: { cfg: PilotConfig }) {
  const exit = useUI((s) => s.exit);
  const simRef = useRef<PilotState>(null as unknown as PilotState);
  if (!simRef.current) simRef.current = createPilot(cfg);
  const p = simRef.current;
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const [paused, setPaused] = useState(false);
  const [cam, setCam] = useState<PilotCam>('cockpit');
  const [tab, setTab] = useState<Tab>('flight');
  const [mouseYoke, setMouseYoke] = useState(false);
  const [toast, setToast] = useState('');
  const [debriefOpen, setDebriefOpen] = useState(false);
  const [voice, setVoice] = useState(true);
  const [range, setRange] = useState(p.ac.onGround ? 1 : 10);
  const [chart, setChart] = useState(false);
  const [show, setShow] = useState<string | undefined>();
  const pfd = useRef<HTMLCanvasElement>(null), nd = useRef<HTMLCanvasElement>(null), engCv = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<string>());
  const kb = useRef({ pitch: 0, roll: 0, yaw: 0 });
  const mouse = useRef({ x: 0, y: 0 });
  const R = useRef({ paused, mouseYoke, voice, range, chart });
  R.current = { paused, mouseYoke, voice, range, chart };
  const toastT = useRef(0);

  const act = useCallback((fn: () => string | void) => {
    const r = fn();
    if (r) { setToast(r); window.clearTimeout(toastT.current); toastT.current = window.setTimeout(() => setToast(''), 3500); tone('error'); }
    bump();
  }, [bump]);

  // keyboard
  useEffect(() => {
    const p = simRef.current;
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', '/'].includes(e.key)) e.preventDefault();
      if (t && t.tagName === 'INPUT' && e.key.startsWith('Arrow')) (t as HTMLElement).blur();
      keys.current.add(k);
      if (e.repeat) return;
      const ac = p.ac;
      switch (k) {
        case 'f': act(() => setControl(p, 'flaps', ac.flapIdx + (e.shiftKey ? -1 : 1))); break;
        case 'g': act(() => setControl(p, 'gear', ac.gearLever ? 0 : 1)); break;
        case 'p': act(() => setControl(p, 'parkBrake', ac.parkBrake ? 0 : 1)); break;
        case 't': act(() => setControl(p, 'reverse', ac.reverse ? 0 : 1)); break;
        case '/': act(() => (ac.spoilerLever > 0.02 ? setControl(p, 'spoiler', 0) || setControl(p, 'spoilerArm', 0) : ac.spoilerArmed ? setControl(p, 'spoiler', 1) : setControl(p, 'spoilerArm', 1))); break;
        case 'q': act(() => apButton(p, 'cmd')); break;
        case 'm': setMouseYoke((v) => !v); break;
        case 'v': setCam((c) => (c === 'cockpit' ? 'chase' : c === 'chase' ? 'flyby' : 'cockpit')); break;
        case 'i': act(() => setInstructor(p, !p.flags.instructor)); break;
        case 'Escape': setPaused((v) => !v); break;
        case '.': act(() => { p.accel = Math.min(maxAccel(p), p.accel * 2); }); break;
        case ',': act(() => { p.accel = Math.max(1, p.accel / 2); }); break;
      }
    };
    const up = (e: KeyboardEvent) => { keys.current.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); };
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); stopSpeaking(); };
  }, [act]);

  // main loop
  useEffect(() => {
    const p = simRef.current;
    let raf = 0, last = performance.now(), acc = 0, frame = 0, seen = p.atc.log.length, alarmT = 0;
    (window as unknown as { __pilot: PilotState }).__pilot = p;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const real = Math.min(0.1, (now - last) / 1000);
      last = now;
      const K = keys.current, S = R.current;
      // keyboard deflections ramp in and spring back
      const ramp = (cur: number, neg: boolean, pos: boolean, rate = 2.6) => { const tgt = (pos ? 1 : 0) - (neg ? 1 : 0); const r = tgt === 0 ? 5 : rate; return cur < tgt ? Math.min(tgt, cur + r * real) : Math.max(tgt, cur - r * real); };
      const k = kb.current;
      k.pitch = ramp(k.pitch, K.has('ArrowUp'), K.has('ArrowDown'));
      k.roll = ramp(k.roll, K.has('ArrowLeft'), K.has('ArrowRight'));
      k.yaw = ramp(k.yaw, K.has('a'), K.has('d'), p.ac.onGround ? 2 : 2.6);
      const inp: Inputs = { pitch: k.pitch, roll: k.roll, yaw: k.yaw, brake: K.has(' ') || K.has('b') ? 1 : 0 };
      if (S.mouseYoke) { inp.pitch += mouse.current.y; inp.roll += mouse.current.x; }
      const pad = navigator.getGamepads?.()[0];
      if (pad && pad.axes.length >= 2) {
        const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : v);
        inp.roll += dz(pad.axes[0]); inp.pitch += dz(pad.axes[1]);
        if (pad.axes.length > 2) inp.yaw += dz(pad.axes[2]);
      }
      if (!S.paused && !p.over) {
        if (K.has('w')) setControl(p, 'throttle', p.ac.throttle[0] + 0.45 * real);
        if (K.has('s')) setControl(p, 'throttle', p.ac.throttle[0] - 0.45 * real);
        if (K.has(']')) setControl(p, 'trim', p.ac.trim + 0.12 * real);
        if (K.has('[')) setControl(p, 'trim', p.ac.trim - 0.12 * real);
        if (p.accel > maxAccel(p)) p.accel = Math.max(1, maxAccel(p));
        acc += real * p.accel;
        let n = 0;
        while (acc >= DT && n < 140) { stepPilot(p, inp, DT); acc -= DT; n++; }
        if (n >= 140) acc = 0;
      }
      // sound
      while (p.callouts.length) {
        const c = p.callouts.shift()!;
        if (c === 'touchdown' || c === 'crash') { if (c === 'crash') tone('critical'); continue; }
        if (S.voice) speak(CALLOUT[c] ?? c, 3);
      }
      if (p.atc.log.length > seen) {
        for (let i = seen; i < p.atc.log.length; i++) { const m = p.atc.log[i]; if (m.from === 'atc' && S.voice && p.accel <= 2) speak(m.text.replace(/(\d)\.(\d)/g, '$1 point $2'), 11); if (m.from === 'atc') tone('request'); }
        seen = p.atc.log.length;
      }
      if (!S.paused && (p.sys.warnings.length || p.sys.stallWarn) && now - alarmT > 1100) { alarmT = now; tone(p.sys.stallWarn || p.sys.gpws === 'PULL UP' ? 'critical' : 'alert'); }
      if (pfd.current) drawPFD(pfd.current, p);
      if (nd.current) drawND(nd.current, p, { range: S.range, chart: S.chart });
      if (engCv.current) drawENG(engCv.current, p);
      if (++frame % 8 === 0) bump();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [bump]);

  useEffect(() => { if (p.over) setDebriefOpen(true); }, [p.over]);

  const A = p.cfg.assists;
  const jet = isJet(p);
  const hint = show ?? (A.guidance ? nextItem(p)?.item.ctl : undefined);
  const showCtl = (ctl: string) => {
    setShow(ctl);
    window.setTimeout(() => setShow(undefined), 6000);
    if (PEDESTAL_IDS.has(ctl)) setTab('pedestal');
    else if (!QUICK_IDS.has(ctl) && !['selAlt', 'selSpd', 'selHdg', 'fd'].includes(ctl)) setTab('overhead');
  };
  const onMove = (e: React.PointerEvent) => {
    if (!mouseYoke || !viewRef.current) return;
    const r = viewRef.current.getBoundingClientRect();
    mouse.current.x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2.6));
    mouse.current.y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2.6));
  };
  useEffect(() => { if (!mouseYoke) mouse.current = { x: 0, y: 0 }; }, [mouseYoke]);
  const inst = !!p.flags.instructor;
  const mins = Math.floor(p.t / 60);
  const tabs: [Tab, string][] = [['flight', 'Flight'], ['overhead', jet ? 'Overhead' : 'Switches'], ['pedestal', jet ? 'Pedestal' : 'Radios'], ['assists', 'Assists'], ['brief', 'Briefing']];
  const warn = p.sys.warnings.length > 0, caut = p.sys.cautions.length > 0;

  return (
    <div className="h-full flex flex-col bg-navy-950 select-none" data-testid="pilot-screen">
      <div className="h-10 shrink-0 flex items-center gap-3 px-3 bg-navy-850 border-b border-navy-600 text-[12px] whitespace-nowrap overflow-hidden">
        <span className="mono text-cyan-a font-bold text-[14px]">{p.callsign}</span>
        <span className="text-slate-400">{ACDEF[p.cfg.aircraft].short} · {p.airports[0].ap.icao}{p.airports.length > 1 ? ` → ${p.airports[1].ap.icao}` : ''}</span>
        <span className="px-2 py-0.5 rounded bg-navy-700 text-slate-200 uppercase tracking-wider text-[10.5px]" data-testid="phase">{p.phase.replace('_', ' ')}</span>
        <span className="mono text-slate-400">{String(Math.floor(mins / 60)).padStart(2, '0')}:{String(mins % 60).padStart(2, '0')}:{String(Math.floor(p.t % 60)).padStart(2, '0')}</span>
        <div className="flex items-center gap-1" title="Time acceleration ( , and . ). Above 2× needs the autopilot; limited near the ground.">
          <button className="btn !px-1.5" onClick={() => act(() => { p.accel = Math.max(1, p.accel / 2); })}>«</button>
          <span className={`mono w-9 text-center ${p.accel > 1 ? 'text-amber-300' : 'text-slate-300'}`}>{p.accel}×</span>
          <button className="btn !px-1.5" onClick={() => act(() => { const m = maxAccel(p); if (p.accel * 2 > m) return `Time acceleration is limited to ${m}× right now${!p.ap.cmd && !p.ac.onGround ? ' (engage the autopilot for more)' : ''}`; p.accel *= 2; })}>»</button>
        </div>
        <button className={`btn ${paused ? 'btn-warn' : ''}`} onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
        <div className="flex-1" />
        {warn && <span className="px-2 py-0.5 rounded bg-red-700 text-white font-bold blink">WARNING</span>}
        {!warn && caut && <span className="px-2 py-0.5 rounded bg-amber-600 text-black font-bold">CAUTION</span>}
        <button className={`btn ${inst ? 'btn-go' : ''}`} onClick={() => act(() => setInstructor(p, !inst))} title="Hand the controls to the instructor, who will fly (and work the switches and radio) until you take over again. Key: I">{inst ? 'Instructor flying – take control' : 'Instructor: fly it for me'}</button>
        <select className="field" value={cam} onChange={(e) => setCam(e.target.value as PilotCam)} title="View (V)"><option value="cockpit">Cockpit</option><option value="chase">Chase</option><option value="flyby">Fly-by</option></select>
        <button className={`btn ${mouseYoke ? 'btn-on' : ''}`} onClick={() => setMouseYoke(!mouseYoke)} title="Fly with the mouse: move the pointer over the outside view (M)">Mouse yoke</button>
        <button className={`btn ${voice ? 'btn-on' : ''}`} onClick={() => { setVoice(!voice); stopSpeaking(); }} title="Spoken ATC and callouts (uses your browser's speech voice)">Voice</button>
        <button className="btn" onClick={() => setDebriefOpen(true)}>Debrief</button>
        <button className="btn btn-danger" onClick={() => { if (p.over || window.confirm('Leave this flight?')) exit(); }}>Exit</button>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div ref={viewRef} className={`flex-1 min-h-0 relative overflow-hidden ${mouseYoke ? 'cursor-crosshair' : ''}`} onPointerMove={onMove}>
            <Suspense fallback={<div className="absolute inset-0 flex items-center justify-center text-slate-500">Loading outside view…</div>}>
              <PilotView3D getState={() => simRef.current} cam={cam} mouseYoke={mouseYoke} />
            </Suspense>
            <div className="absolute top-2 left-1/2 -translate-x-1/2"><HudStrip p={p} /></div>
            {paused && <div className="absolute top-10 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-amber-900/80 border border-amber-a text-amber-a text-xs tracking-widest pointer-events-none">PAUSED — you can still set switches and read the checklist</div>}
            {inst && <div className="absolute top-10 right-3 px-2 py-1 rounded bg-emerald-900/80 border border-emerald-500 text-emerald-200 text-xs pointer-events-none">Instructor has control</div>}
            {mouseYoke && <div className="absolute left-1/2 top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border border-white/50 pointer-events-none" />}
            {(p.sys.warnings.length > 0 || p.sys.gpws) && <div className="absolute top-20 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-red-800/85 text-white font-bold tracking-wider pointer-events-none">{[...p.sys.warnings, ...(p.sys.gpws && !p.sys.warnings.includes(p.sys.gpws) ? [p.sys.gpws] : [])].join(' · ')}</div>}
            {toast && <div className="absolute bottom-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded border bg-red-950 border-red-a text-red-200 text-[12.5px]">{toast}</div>}
            {p.ac.crashed && <div className="absolute inset-0 bg-red-950/50 flex items-center justify-center pointer-events-none"><div className="bg-black/80 border border-red-a rounded px-6 py-4 text-center"><div className="text-red-300 text-xl font-bold">ACCIDENT</div><div className="text-slate-200">{p.ac.crashed}</div></div></div>}
          </div>
          <Mcp p={p} act={act} />
          <div className="h-[300px] shrink-0 flex bg-black border-t border-navy-600">
            <canvas ref={pfd} className="h-full" style={{ width: 300 }} data-testid="pfd" />
            <div className="relative h-full border-l border-navy-700" style={{ width: 290 }}>
              <canvas ref={nd} className="w-full h-full" data-testid="nd" />
              <div className="absolute bottom-4 right-1 flex gap-0.5">
                <button className="btn !px-1.5 !py-0" onClick={() => setRange(RANGES[Math.max(0, RANGES.indexOf(range) - 1)])} title="Zoom in">+</button>
                <button className="btn !px-1.5 !py-0" onClick={() => setRange(RANGES[Math.min(RANGES.length - 1, RANGES.indexOf(range) + 1)])} title="Zoom out">−</button>
                <button className={`btn !px-1.5 !py-0 !text-[10px] ${chart ? 'btn-on' : ''}`} onClick={() => setChart(!chart)} title="North-up chart centred on the aircraft (airport diagram when zoomed in)">MAP</button>
              </div>
            </div>
            <canvas ref={engCv} className="h-full border-l border-navy-700" style={{ width: 190 }} data-testid="eng" />
            <div className="flex-1 min-w-[230px] border-l border-navy-700"><QuickControls p={p} act={act} hi={hint} /></div>
          </div>
        </div>
        <div className="w-[390px] shrink-0 border-l border-navy-600 flex flex-col min-h-0 bg-navy-900">
          <div className="flex shrink-0 border-b border-navy-600">
            {tabs.map(([id, label]) => <button key={id} className={`flex-1 py-1.5 text-[11.5px] ${tab === id ? 'bg-navy-700 text-cyan-200' : 'text-slate-400 hover:text-slate-200'} ${hint && ((id === 'pedestal' && PEDESTAL_IDS.has(hint)) || (id === 'overhead' && !PEDESTAL_IDS.has(hint) && !QUICK_IDS.has(hint) && !['atc', 'selAlt', 'selSpd', 'selHdg', 'fd'].includes(hint))) && tab !== id ? 'underline decoration-fuchsia-400 decoration-2' : ''}`} onClick={() => setTab(id)}>{label}</button>)}
          </div>
          <div className="flex-1 min-h-0">
            {tab === 'flight' && <FlightPanel p={p} act={act} onShow={showCtl} />}
            {tab === 'overhead' && <SwitchPanel p={p} act={act} hi={hint} panel="overhead" />}
            {tab === 'pedestal' && <SwitchPanel p={p} act={act} hi={hint} panel="pedestal" />}
            {tab === 'assists' && <AssistPanel p={p} act={act} />}
            {tab === 'brief' && <BriefPanel p={p} />}
          </div>
        </div>
      </div>
      {debriefOpen && <DebriefModal p={p} onClose={() => setDebriefOpen(false)} onExit={exit} onRestart={() => { simRef.current = createPilot({ ...cfg }); (window as unknown as { __pilot: PilotState }).__pilot = simRef.current; setDebriefOpen(false); useUI.getState().startPilot({ ...cfg, seed: cfg.seed }); }} />}
    </div>
  );
}
