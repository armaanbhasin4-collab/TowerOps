import { useEffect, useRef, useState } from 'react';
import { useUI } from '../store';
import { fmtClock } from '../sim/util';
import { listen, speechSupported } from './speech';
import { voiceToCommand } from '../sim/voice';
import { Tabs, sevColor, useSim } from './common';

function Radio() {
  const sim = useSim();
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const n = sim.s.radio.length;
  const last = sim.s.radio[n - 1]?.t;
  useEffect(() => { if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [n, last]);
  const clock = (t: number) => fmtClock(sim.s.cfg.startClock + t, true);
  return (
    <div ref={ref} className="overflow-y-auto flex-1 min-h-0 px-2 py-1 text-[12px] leading-[17px]" onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}>
      {sim.s.radio.slice(-140).map((r, i) => (
        <div key={`${r.t}-${i}`} className={r.emergency ? 'text-red-a font-semibold' : r.from === 'atc' ? 'text-cyan-a' : r.from === 'system' ? 'text-slate-500 italic' : 'text-slate-200'}>
          <span className="mono text-[10px] text-slate-600 mr-1.5">{clock(r.t)}</span>
          {r.from !== 'system' && <button className="mono text-[10px] mr-1.5 px-1 rounded bg-navy-800 text-slate-400 hover:text-white" onClick={() => r.ac !== undefined && useUI.getState().select(r.ac, true)}>{r.from === 'atc' ? `ATC▸${r.callsign}` : r.callsign}</button>}
          {r.text}
        </div>
      ))}
    </div>
  );
}

function Events() {
  const sim = useSim();
  const [all, setAll] = useState(false);
  const ev = sim.s.events.filter((e) => all || e.sev !== 'info').slice(-120).reverse();
  return (
    <div className="overflow-y-auto flex-1 min-h-0 px-2 py-1 text-[12px]">
      <label className="text-[11px] text-slate-500 flex items-center gap-1 mb-1"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> show routine events</label>
      {ev.map((e, i) => (
        <div key={i} className={`flex gap-2 ${sevColor(e.sev)}`}>
          <span className="mono text-[10px] text-slate-600 shrink-0 pt-0.5">{fmtClock(sim.s.cfg.startClock + e.t, true)}</span>
          <span className="flex-1 cursor-pointer hover:underline" onClick={() => { if (e.ac?.[0] !== undefined) useUI.getState().select(e.ac[0]); if (e.x !== undefined) useUI.getState().focusOn(e.x, e.y!); }}>{e.text}</span>
          {['collision', 'near_miss', 'incursion', 'separation', 'wake', 'go_around', 'conflict', 'emergency'].includes(e.kind) && <button className="btn !py-0 !text-[10px] shrink-0 self-start" onClick={() => useUI.getState().setModal('replay', e.t)}>Replay</button>}
        </div>
      ))}
      {!ev.length && <div className="text-slate-500">No significant events yet.</div>}
    </div>
  );
}

function Alerts() {
  const sim = useSim();
  const s = sim.s;
  const em = s.aircraft.filter((a) => a.emergency && !a.emergency.resolved && a.phase !== 'gone' && a.phase !== 'crashed');
  if (!s.alerts.length && !em.length) return null;
  return (
    <div className="flex flex-wrap gap-1 px-2 py-1 border-b border-navy-700 max-h-[52px] overflow-y-auto shrink-0">
      {em.map((a) => <button key={'e' + a.id} className="px-1.5 py-0.5 rounded bg-red-950 border border-red-a text-red-a text-[11px] font-semibold blink" onClick={() => useUI.getState().select(a.id, true)}>⚠ {a.emergency!.mayday ? 'MAYDAY' : 'PAN'} {a.callsign}</button>)}
      {s.alerts.slice(0, 8).map((a) => (
        <button key={a.key} onClick={() => useUI.getState().select(a.ac[0], true)} className={`px-1.5 py-0.5 rounded border text-[11px] ${a.level === 'critical' ? 'bg-red-950 border-red-a text-red-a font-semibold blink' : a.level === 'violation' ? 'bg-red-950/60 border-red-a/70 text-red-a' : 'bg-amber-950/40 border-amber-a/60 text-amber-a'}`}>{a.text}</button>
      ))}
    </div>
  );
}

function CommandLine() {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [listening, setListening] = useState(false);
  const stop = useRef<() => void>(() => {});
  const inp = useRef<HTMLInputElement>(null);
  const selected = useUI((s) => s.selectedId);
  const submit = (raw: string, voice = false) => {
    let t = raw.trim();
    if (!t) return;
    const st = useUI.getState();
    const sim = st.sim!;
    // if the text does not start with a known callsign / airport keyword, address the selected aircraft
    const first = t.split(/\s+/)[0].toUpperCase();
    const sel = sim.s.aircraft.find((a) => a.id === st.selectedId);
    const known = sim.s.aircraft.some((a) => a.callsign === first || a.callsign.endsWith(first)) || ['RWY', 'RUNWAY', 'CONFIG'].includes(first);
    if (voice) t = voiceToCommand(t);
    else if (!known && sel && !/^[A-Z]{2,3}\d+$/.test(first)) t = `${sel.callsign} ${t}`;
    const r = st.issueText(t);
    setMsg({ t: r.ok ? `✓ ${t.toUpperCase()}` : `✗ ${r.message ?? 'rejected'}${voice ? ` — heard: "${t}"` : ''}`, ok: r.ok });
    if (r.ok || !voice) { setHist((h) => [t, ...h.filter((x) => x !== t)].slice(0, 30)); setHi(-1); }
    if (r.ok) setText('');
    else if (voice) setText(t);
  };
  const mic = () => {
    if (listening) { stop.current(); return; }
    setListening(true);
    stop.current = listen((tx, final) => { setText(tx); if (final) submit(tx, true); }, (err) => { setListening(false); if (err) setMsg({ t: err, ok: false }); });
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === '/' || e.key === 'Enter') { e.preventDefault(); inp.current?.focus(); }
      else if (e.key === ' ') { e.preventDefault(); useUI.getState().togglePause(); }
      else if (e.key === 'Escape') useUI.getState().select(null);
      else if (['1', '2', '3', '4'].includes(e.key)) useUI.getState().setSpeed([1, 2, 4, 8][+e.key - 1]);
      else if (e.key.toLowerCase() === 'r') useUI.getState().setView('radar');
      else if (e.key.toLowerCase() === 'g') useUI.getState().setView('ground');
      else if (e.key.toLowerCase() === 't') useUI.getState().setView('tower');
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const sel = useUI.getState().sim?.s.aircraft.find((a) => a.id === selected);
  return (
    <div className="border-t border-navy-600 px-2 py-1.5 shrink-0 bg-navy-850">
      <div className="flex gap-1.5 items-center">
        <span className="mono text-radar text-xs">ATC▸</span>
        <input ref={inp} className="field flex-1 !text-[13px] uppercase" spellCheck={false} placeholder={sel ? `${sel.callsign} …  (e.g. TAXI 27R VIA B M · CLEARED TAKEOFF · HEADING 240 · DESCEND 4000 · CLEARED ILS 26R)` : 'CALLSIGN INSTRUCTION   e.g. DAL1426 PUSHBACK APPROVED   ·   RWY 27R CLOSE   ·   press / to focus'} value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit(text);
            else if (e.key === 'ArrowUp') { e.preventDefault(); const n = Math.min(hist.length - 1, hi + 1); if (hist[n]) { setHi(n); setText(hist[n]); } }
            else if (e.key === 'ArrowDown') { e.preventDefault(); const n = hi - 1; setHi(n); setText(n >= 0 ? hist[n] : ''); }
            else if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          }} />
        <button className="btn btn-primary" onClick={() => submit(text)}>Transmit</button>
        <button className={`btn ${listening ? 'btn-danger blink' : ''}`} disabled={!speechSupported()} title={speechSupported() ? 'Speak an instruction, e.g. "Delta fourteen twenty-six, runway two seven right, cleared for takeoff"' : 'Speech recognition is not available in this browser – the game is fully playable without it'} onClick={mic}>{listening ? '● Listening' : '🎙 Voice'}</button>
        <button className="btn" onClick={() => useUI.getState().setModal('help')}>?</button>
      </div>
      {msg && <div className={`mono text-[11px] mt-1 truncate ${msg.ok ? 'text-radar' : 'text-amber-a'}`} title={msg.t}>{msg.t}</div>}
    </div>
  );
}

export default function BottomPanel() {
  const [tab, setTab] = useState<'radio' | 'events'>('radio');
  return (
    <div className="h-full min-h-0 flex flex-col bg-navy-900">
      <Alerts />
      <Tabs value={tab} onChange={setTab} items={[['radio', 'Radio'], ['events', 'Events & incidents']]} />
      {tab === 'radio' ? <Radio /> : <Events />}
      <CommandLine />
    </div>
  );
}
