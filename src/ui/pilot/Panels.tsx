/** Cockpit panels built from DOM controls: MCP, quick controls, overhead, pedestal/radios, flight (coach, checklist, ATC), assists, briefing, debrief. */
import { useEffect, useRef, useState } from 'react';
import { FT, KT, NM, norm360 } from '../../sim/util';
import { ACDEF, CONTROLS } from '../../pilot/aircraft';
import { apButton } from '../../pilot/autopilot';
import { atcRequest, atcRequests } from '../../pilot/atc';
import { activeChecklists, checklistsFor, nextItem } from '../../pilot/checklists';
import { coach } from '../../pilot/coach';
import { debrief } from '../../pilot/scoring';
import { ASSIST_PRESETS, PRESET_INFO } from '../../pilot/sim';
import { bestMixture, getControl, indicatedAlt, isJet, setControl, takeoffTrim } from '../../pilot/systems';
import { distToGo } from '../../pilot/world';
import type { Assists, ControlDef, PilotState, RealismPreset } from '../../pilot/types';

export type Act = (fn: () => string | void) => void;
interface PP { p: PilotState; act: Act }

const cls = (...a: (string | false | undefined)[]) => a.filter(Boolean).join(' ');

/** numeric selector with −/+ buttons and mouse-wheel support */
function Knob({ label, value, step, big, onChange, fmt, width = 54 }: { label: string; value: number; step: number; big?: number; onChange: (v: number) => void; fmt?: (v: number) => string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  const val = useRef(value);
  val.current = value;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); cb.current(val.current + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey && big ? big : step)); };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [step, big]);
  return (
    <div ref={ref} className="flex flex-col items-center" title={`${label}: click − / + (Shift = big steps) or use the mouse wheel`}>
      <div className="panel-h !text-[9px]">{label}</div>
      <div className="flex items-center">
        <button className="btn !px-1.5 !py-0" onClick={(e) => onChange(value - (e.shiftKey && big ? big : step))}>−</button>
        <div className="mono text-[13px] text-amber-300 bg-black px-1 text-center border-y border-navy-600" style={{ width }}>{fmt ? fmt(value) : value}</div>
        <button className="btn !px-1.5 !py-0" onClick={(e) => onChange(value + (e.shiftKey && big ? big : step))}>+</button>
      </div>
    </div>
  );
}

function ModeBtn({ on, armed, label, onClick, title }: { on: boolean; armed?: boolean; label: string; onClick: () => void; title: string }) {
  return (
    <button className={cls('btn !px-2 !py-1 !text-[11px] relative', on && 'btn-on')} onClick={onClick} title={title}>
      {label}
      <span className={cls('absolute left-1 right-1 bottom-0.5 h-[2px] rounded', on ? 'bg-emerald-400' : armed ? 'bg-amber-300' : 'bg-navy-600')} />
    </button>
  );
}

/** autopilot mode control panel */
export function Mcp({ p, act }: PP) {
  const ap = p.ap;
  const jet = isJet(p);
  const b = (id: string) => () => act(() => apButton(p, id));
  return (
    <div className="flex items-end gap-2 px-2 py-1 bg-navy-850 border-y border-navy-600 overflow-x-auto whitespace-nowrap">
      <ModeBtn on={ap.fd} label="F/D" onClick={b('fd')} title="Flight director bars on the PFD" />
      {jet && <ModeBtn on={ap.at} label="A/T" onClick={b('at')} title="Autothrottle: holds the selected speed (active above 400 ft)" />}
      <Knob label={jet ? 'IAS' : 'IAS (FLC)'} value={ap.selSpd} step={1} big={10} onChange={(v) => act(() => setControl(p, 'selSpd', v))} />
      <ModeBtn on={ap.vert === 'flch'} label={jet ? 'LVL CHG' : 'FLC'} onClick={b('flch')} title="Level change: climb or descend to the selected altitude holding the selected speed with pitch" />
      <Knob label="HEADING" value={ap.selHdg} step={1} big={10} fmt={(v) => String(v).padStart(3, '0')} onChange={(v) => act(() => setControl(p, 'selHdg', v))} />
      <ModeBtn on={ap.lat === 'hdg'} label="HDG" onClick={b('hdg')} title="Fly the selected heading" />
      <button className="btn !px-1.5 !py-1 !text-[10px]" onClick={b('hdgSync')} title="Set the heading bug to the present heading">SYNC</button>
      <ModeBtn on={ap.lat === 'lnav'} label={jet ? 'LNAV' : 'NAV'} onClick={b('lnav')} title="Follow the flight-plan route" />
      <Knob label="ALTITUDE" value={ap.selAlt} step={100} big={1000} width={62} onChange={(v) => act(() => setControl(p, 'selAlt', v))} />
      <ModeBtn on={ap.vert === 'alt'} label="ALT" onClick={b('alt')} title="Hold the present altitude" />
      <Knob label="VERT SPD" value={ap.selVs} step={100} big={500} width={58} onChange={(v) => act(() => setControl(p, 'selVs', v))} />
      <ModeBtn on={ap.vert === 'vs'} label="V/S" onClick={b('vs')} title="Hold the selected vertical speed (it will fly away from the selected altitude if you point it the wrong way)" />
      <ModeBtn on={ap.lat === 'loc' || ap.vert === 'gs'} armed={ap.locArmed || ap.gsArmed} label="APP" onClick={b('app')} title="Arm the ILS approach: localiser and glideslope capture" />
      <ModeBtn on={ap.cmd} label={jet ? 'CMD A' : 'AP'} onClick={b('cmd')} title="Engage / disengage the autopilot (Q)" />
    </div>
  );
}

/** always-visible flight controls: thrust, flaps, gear, speedbrake, brakes, trim */
export function QuickControls({ p, act, hi }: PP & { hi?: string }) {
  const ac = p.ac;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  const H = (id: string) => (hi === id ? 'ring-2 ring-fuchsia-400 rounded' : '');
  return (
    <div className="h-full flex gap-2 p-2 bg-navy-850 text-[11px] overflow-hidden">
      <div className={cls('flex flex-col items-center w-12 shrink-0', H('throttle'))} title="Thrust / throttle (W / S)">
        <div className="panel-h">{jet ? 'THRUST' : 'THROTTLE'}</div>
        <input type="range" min={0} max={1} step={0.01} value={ac.throttle[0]} onChange={(e) => act(() => setControl(p, 'throttle', +e.target.value))} className="accent-cyan-400 flex-1 my-1" style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 18 }} />
        <div className={cls('mono', ac.reverse && 'text-emerald-300')}>{ac.reverse ? 'REV' : `${Math.round(ac.throttle[0] * 100)}%`}</div>
      </div>
      {!jet && (
        <div className={cls("flex flex-col items-center w-12 shrink-0 ml-1", H("mixture"))} title={`Mixture. Rich for takeoff and landing; lean in cruise above 3000 ft (best now about ${Math.round(bestMixture(p.ac.z / FT) * 100)}%). Fully out = idle cut-off (stops the engine).`}>
          <div className="panel-h text-red-300">MIXTURE</div>
          <input type="range" min={0} max={1} step={0.01} value={ac.mixture} onChange={(e) => act(() => setControl(p, 'mixture', +e.target.value))} className="accent-red-400 flex-1 my-1" style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 18 }} />
          <div className="mono">{Math.round(ac.mixture * 100)}%</div>
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className={cls('flex items-center gap-1', H('flaps'))} title="Flaps (F = extend one step, Shift+F = retract)">
          <span className="panel-h w-10">FLAPS</span>
          <button className="btn !px-1.5" onClick={() => act(() => setControl(p, 'flaps', ac.flapIdx - 1))}>▲</button>
          <div className="mono flex-1 text-center bg-black border border-navy-600 rounded py-0.5 text-amber-300">{def.flaps[ac.flapIdx].label}</div>
          <button className="btn !px-1.5" onClick={() => act(() => setControl(p, 'flaps', ac.flapIdx + 1))}>▼</button>
        </div>
        {def.retract && (
          <div className={cls('flex items-center gap-1', H('gear'))} title="Landing gear (G)">
            <span className="panel-h w-10">GEAR</span>
            <button className={cls('btn flex-1', !ac.gearLever && 'btn-on')} onClick={() => act(() => setControl(p, 'gear', 0))}>UP</button>
            <button className={cls('btn flex-1', ac.gearLever && 'btn-on')} onClick={() => act(() => setControl(p, 'gear', 1))}>DOWN</button>
          </div>
        )}
        {jet && (
          <div className={cls('flex items-center gap-1', H('spoiler') || H('spoilerArm'))} title="Speedbrake: DOWN / ARMED (deploys automatically on landing) / flight detent / UP. Key: / cycles">
            <span className="panel-h w-10">SPD BRK</span>
            <button className={cls('btn flex-1 !px-1', ac.spoilerLever < 0.02 && !ac.spoilerArmed && 'btn-on')} onClick={() => act(() => { setControl(p, 'spoiler', 0); setControl(p, 'spoilerArm', 0); })}>DN</button>
            <button className={cls('btn flex-1 !px-1', ac.spoilerArmed && 'btn-on')} onClick={() => act(() => setControl(p, 'spoilerArm', 1))}>ARM</button>
            <button className={cls('btn flex-1 !px-1', ac.spoilerLever > 0.3 && ac.spoilerLever < 0.9 && 'btn-on')} onClick={() => act(() => setControl(p, 'spoiler', 0.5))}>½</button>
            <button className={cls('btn flex-1 !px-1', ac.spoilerLever >= 0.9 && 'btn-on')} onClick={() => act(() => setControl(p, 'spoiler', 1))}>UP</button>
          </div>
        )}
        <div className="flex items-center gap-1">
          <span className="panel-h w-10">BRAKES</span>
          <button className={cls('btn flex-1', ac.parkBrake ? 'btn-danger' : '', H('parkBrake'))} onClick={() => act(() => setControl(p, 'parkBrake', ac.parkBrake ? 0 : 1))} title="Parking brake (P)">{ac.parkBrake ? 'PARK BRAKE SET' : 'Park brake off'}</button>
          {jet && <button className={cls('btn !px-1.5', ac.reverse && 'btn-on', H('reverse'))} onClick={() => act(() => setControl(p, 'reverse', ac.reverse ? 0 : 1))} title="Reverse thrust (T) – on the ground only">REV</button>}
        </div>
        <div className={cls('flex items-center gap-1', H('trim'))} title={`Pitch trim ([ nose down, ] nose up). Takeoff setting: ${Math.round(takeoffTrim(p) * 100)}`}>
          <span className="panel-h w-10">TRIM</span>
          <button className="btn !px-1.5" onClick={() => act(() => setControl(p, 'trim', ac.trim - 0.02))}>DN</button>
          <div className="mono flex-1 text-center bg-black border border-navy-600 rounded py-0.5">{ac.trim >= 0 ? '+' : ''}{Math.round(ac.trim * 100)}</div>
          <button className="btn !px-1.5" onClick={() => act(() => setControl(p, 'trim', ac.trim + 0.02))}>UP</button>
          <button className="btn !px-1.5 !text-[10px]" onClick={() => act(() => setControl(p, 'trim', takeoffTrim(p)))} title="Set takeoff trim">T/O</button>
        </div>
      </div>
    </div>
  );
}

function SwitchRow({ c, p, act, hi, onHelp }: PP & { c: ControlDef; hi?: string; onHelp: (c: ControlDef) => void }) {
  const v = getControl(p, c.id);
  return (
    <div className={cls('flex items-center gap-2 py-[3px] px-1 rounded', hi === c.id && 'bg-fuchsia-950/60 ring-1 ring-fuchsia-400')} onMouseEnter={() => onHelp(c)}>
      <span className="flex-1 text-[11.5px] text-slate-300 truncate">{c.label}</span>
      <div className="flex">
        {c.pos.map((label, i) => (
          <button key={i} className={cls('px-1.5 py-[2px] text-[10.5px] mono border border-navy-600 first:rounded-l last:rounded-r -ml-px first:ml-0', v === i ? (i === 0 && c.pos.length === 2 ? 'bg-slate-700 text-slate-100' : 'bg-emerald-900 text-emerald-200 border-emerald-600 z-10') : 'bg-navy-900 text-slate-500 hover:text-slate-200')} onClick={() => act(() => setControl(p, c.id, i))}>{label}</button>
        ))}
      </div>
    </div>
  );
}

export function SwitchPanel({ p, act, hi, panel }: PP & { hi?: string; panel: 'overhead' | 'pedestal' }) {
  const [help, setHelp] = useState<ControlDef | null>(null);
  const list = CONTROLS[p.cfg.aircraft].filter((c) => c.panel === panel);
  const sections = [...new Set(list.map((c) => c.section))];
  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {sections.map((s) => (
          <div key={s} className="mb-1.5">
            <div className="panel-h border-b border-navy-700 mb-0.5">{s}</div>
            {list.filter((c) => c.section === s).map((c) => <SwitchRow key={c.id} c={c} p={p} act={act} hi={hi} onHelp={setHelp} />)}
          </div>
        ))}
        {panel === 'pedestal' && <Radios p={p} act={act} hi={hi} />}
      </div>
      <div className="shrink-0 border-t border-navy-600 px-2 py-1.5 text-[11.5px] text-slate-400 min-h-[52px]">{help ? <><b className="text-slate-200">{help.label}:</b> {help.help}</> : 'Hover a switch to see what it does.'}</div>
    </div>
  );
}

function Freq({ label, v, onAct, onSby, onSwap, hiOn }: { label: string; v: { act: number; sby: number }; onAct?: () => void; onSby: (v: number) => void; onSwap: () => void; hiOn?: boolean }) {
  void onAct;
  return (
    <div className={cls('flex items-center gap-1 py-0.5', hiOn && 'ring-1 ring-fuchsia-400 rounded')}>
      <span className="panel-h w-10">{label}</span>
      <span className="mono text-emerald-300 bg-black px-1 border border-navy-600 rounded w-[62px] text-center" title="Active frequency">{v.act.toFixed(2)}</span>
      <button className="btn !px-1" onClick={onSwap} title="Swap active and standby">⇄</button>
      <Knob label="" value={v.sby} step={0.05} big={1} width={58} fmt={(x) => x.toFixed(2)} onChange={onSby} />
    </div>
  );
}

function Radios({ p, act, hi }: PP & { hi?: string }) {
  const r = p.radios;
  const jet = isJet(p);
  const [code, setCode] = useState(String(r.xpdr.code));
  useEffect(() => setCode(String(r.xpdr.code).padStart(4, '0')), [r.xpdr.code]);
  const here = p.airports[p.airports.length > 1 && distToGo(p) < 60 ? 1 : 0];
  return (
    <div className="mt-1">
      <div className="panel-h border-b border-navy-700 mb-1">Radios</div>
      <Freq label="COM 1" v={r.com} onSby={(v) => act(() => { r.com.sby = Math.round(Math.min(136.95, Math.max(118, v)) * 20) / 20; })} onSwap={() => act(() => { const a = r.com.act; r.com.act = r.com.sby; r.com.sby = a; })} hiOn={hi === 'com'} />
      <div className="flex items-center gap-1 text-[11px] text-slate-400 mb-1 pl-11">
        {p.atc.station ? <>{p.atc.station}: <span className="mono text-slate-200">{p.atc.freq.toFixed(2)}</span><button className="btn !py-0 !px-1.5 !text-[10px]" onClick={() => act(() => { r.com.sby = p.atc.freq; })} title="Put this frequency in standby">→ STBY</button></> : 'no station'}
      </div>
      <Freq label="NAV 1" v={r.nav} onSby={(v) => act(() => { r.nav.sby = Math.round(Math.min(117.95, Math.max(108, v)) * 20) / 20; })} onSwap={() => act(() => { const a = r.nav.act; r.nav.act = r.nav.sby; r.nav.sby = a; })} hiOn={hi === 'nav'} />
      <div className="flex items-center gap-1 text-[11px] text-slate-400 mb-1 pl-11">
        ILS {p.arrRwy.name}: <span className="mono text-slate-200">{p.arrRwy.ilsFreq.toFixed(2)}</span>
        <button className="btn !py-0 !px-1.5 !text-[10px]" onClick={() => act(() => { r.nav.sby = p.arrRwy.ilsFreq; })}>→ STBY</button>
        <span className={p.ils.valid ? 'text-emerald-300' : 'text-slate-600'}>{p.ils.valid ? 'receiving' : 'no signal'}</span>
      </div>
      <div className={cls('flex items-center gap-1 py-0.5', (hi === 'squawk' || hi === 'xpdr') && 'ring-1 ring-fuchsia-400 rounded')}>
        <span className="panel-h w-10">XPDR</span>
        <input className="field w-[58px] text-center" value={code} maxLength={4} onChange={(e) => { const v = e.target.value.replace(/[^0-7]/g, ''); setCode(v); if (v.length === 4) act(() => setControl(p, 'squawk', +v)); }} title="Squawk code (digits 0–7)" />
        {(jet ? ['STBY', 'ALT', 'TA/RA'] : ['STBY', 'ALT']).map((m, i) => <button key={m} className={cls('btn !px-1.5', r.xpdr.mode === i && 'btn-on')} onClick={() => act(() => setControl(p, 'xpdr', i))}>{m}</button>)}
        {!!p.atc.squawk && p.atc.squawk !== r.xpdr.code && <span className="text-amber-300 mono text-[11px]">assigned {p.atc.squawk}</span>}
      </div>
      <div className={cls('flex items-center gap-1 py-0.5', hi === 'baro' && 'ring-1 ring-fuchsia-400 rounded')}>
        <span className="panel-h w-10">BARO</span>
        <Knob label="" value={r.baro} step={1} big={10} fmt={(v) => `${v} hPa`} width={84} onChange={(v) => act(() => { setControl(p, 'baro', v); setControl(p, 'baroStd', 0); })} />
        <button className={cls('btn !px-1.5', r.std && 'btn-on')} onClick={() => act(() => setControl(p, 'baroStd', r.std ? 0 : 1))} title="Standard pressure 1013 hPa – use above 18,000 ft">STD</button>
        <span className="text-[11px] text-slate-400">{here.ap.icao} QNH <span className="mono text-slate-200">{here.qnh}</span></span>
      </div>
      <div className="text-[10.5px] text-slate-500 mt-1">Indicated altitude {Math.round(indicatedAlt(p))} ft. A wrong altimeter setting shows a wrong altitude (about 27 ft per hPa).</div>
    </div>
  );
}

const FROM: Record<string, string> = { atc: 'text-cyan-300', me: 'text-emerald-300', fo: 'text-slate-400', sys: 'text-amber-300' };

export function FlightPanel({ p, act, onShow }: PP & { onShow: (ctl: string) => void }) {
  const A = p.cfg.assists;
  const c = coach(p);
  const lists = checklistsFor(p);
  const active = activeChecklists(p);
  const [sel, setSel] = useState<string | null>(null);
  const cur = lists.find((l) => l.id === sel) ?? active[active.length > 1 && active[0].items.every((i) => i.info || i.ok(p)) ? 1 : 0] ?? lists[0];
  const next = nextItem(p);
  const reqs = atcRequests(p);
  const tuned = !A.strictRadio || Math.abs(p.radios.com.act - p.atc.freq) < 0.011;
  const logRef = useRef<HTMLDivElement>(null);
  const n = p.atc.log.length;
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [n]);
  useEffect(() => setSel(null), [p.phase]);
  return (
    <div className="flex flex-col h-full min-h-0">
      {A.guidance && (
        <div className="shrink-0 m-2 mb-1 p-2 rounded border border-fuchsia-900 bg-fuchsia-950/30 text-[12px]">
          <div className="panel-h !text-fuchsia-300 mb-0.5">Instructor · {c.title}</div>
          {c.lines.filter(Boolean).map((l, i) => <div key={i} className="text-slate-200 leading-snug mb-0.5">{l}</div>)}
        </div>
      )}
      <div className="shrink-0 px-2">
        <div className="flex items-center gap-1 overflow-x-auto pb-1">
          {lists.map((l) => {
            const done = l.items.every((i) => i.info || i.ok(p));
            return <button key={l.id} className={cls('btn !text-[10.5px] !px-1.5 shrink-0', cur.id === l.id && 'btn-on', active.includes(l) && cur.id !== l.id && '!border-amber-600')} onClick={() => setSel(l.id)}>{done ? '✓ ' : ''}{l.title}</button>;
          })}
        </div>
      </div>
      <div className="flex-1 min-h-[120px] overflow-y-auto px-2">
        <div className="panel-h my-1">Checklist · {cur.title}</div>
        {cur.items.map((it) => {
          const ok = it.ok(p);
          const isNext = next?.item === it;
          return (
            <div key={it.id} className={cls('flex items-baseline gap-2 text-[12px] py-[2px] px-1 rounded', isNext && A.guidance && 'bg-fuchsia-950/50')}>
              <span className={cls('w-3 shrink-0', ok ? 'text-emerald-400' : 'text-slate-600')}>{ok ? '✓' : '○'}</span>
              <span className={cls('flex-1', ok ? 'text-slate-500' : 'text-slate-200')}>{it.label}</span>
              <span className={cls('mono text-[10.5px] text-right', ok ? 'text-emerald-600' : 'text-amber-200')}>{it.expect}</span>
              {it.ctl && it.ctl !== 'atc' && !ok && <button className="text-[10px] text-cyan-300 hover:underline shrink-0" onClick={() => onShow(it.ctl!)} title="Show me where this control is">show</button>}
            </div>
          );
        })}
      </div>
      <div className="shrink-0 border-t border-navy-600 px-2 pt-1.5">
        <div className="flex items-center gap-2 text-[11.5px]">
          <span className="panel-h">ATC</span>
          <span className="text-slate-200 truncate">{p.atc.station || '—'}</span>
          <span className="mono text-slate-400">{p.atc.freq ? p.atc.freq.toFixed(2) : ''}</span>
          {A.strictRadio && !tuned && p.atc.freq > 0 && <button className="btn btn-warn !py-0 !text-[10.5px]" onClick={() => act(() => { p.radios.com.act = p.atc.freq; })} title="You are not on this frequency. Tune it on the Pedestal tab, or click to tune it now.">Tune COM1</button>}
          {tuned && p.atc.freq > 0 && <span className="text-emerald-400 text-[10.5px]">on frequency</span>}
        </div>
        <div className="flex flex-wrap gap-1 my-1">
          {reqs.map((r) => <button key={r.id} className={cls('btn', r.id === 'again' ? '' : 'btn-primary')} title={`You say: "${r.say}"`} onClick={() => act(() => atcRequest(p, r.id))}>{r.label}</button>)}
          {!reqs.length && <span className="text-[11px] text-slate-500">No call needed right now.</span>}
        </div>
      </div>
      <div ref={logRef} className="shrink-0 h-[150px] overflow-y-auto px-2 pb-1 text-[11.5px] leading-snug">
        {p.atc.log.slice(-60).map((m, i) => (
          <div key={i} className={FROM[m.from]}>
            <span className="text-slate-600 mono text-[10px]">{m.from === 'atc' ? (m.station ?? 'ATC') : m.from === 'me' ? 'YOU' : m.from === 'fo' ? 'F/O' : 'INFO'} </span>{m.text}
          </div>
        ))}
      </div>
    </div>
  );
}

const ASSIST_LABELS: [keyof Assists, string, string][] = [
  ['autoSystems', 'First officer runs the switch flows', 'The other pilot works through the checklists for you, one item at a time.'],
  ['autoRadio', 'First officer handles the radio', 'ATC calls, readbacks and frequency changes are made for you.'],
  ['strictRadio', 'Frequencies must be tuned by hand', 'ATC only answers when COM1 is on the right frequency.'],
  ['autoConfig', 'Automatic gear, flaps and speedbrake', 'Configuration follows a normal schedule (you still control speed).'],
  ['autoRudder', 'Automatic rudder', 'Turns are coordinated and the takeoff roll stays straight without rudder input.'],
  ['autoTrim', 'Automatic pitch trim', 'Trim follows your pitch input so you never hold pressure.'],
  ['protection', 'Stall and bank protection', 'The aircraft will not stall or roll past about 40°.'],
  ['guidance', 'Instructor hints and 3D guidance', 'Coach text, the next control highlighted, taxi line and approach gates in the outside view.'],
  ['forgiving', 'Forgiving (no crash ends the flight)', 'Accidents are scored but you carry on.'],
];

export function AssistPanel({ p, act }: PP) {
  const A = p.cfg.assists;
  return (
    <div className="p-2 overflow-y-auto h-full text-[12px]">
      <div className="panel-h mb-1">Realism preset</div>
      <div className="grid grid-cols-2 gap-1 mb-2">
        {(Object.keys(PRESET_INFO) as RealismPreset[]).map((k) => (
          <button key={k} className={cls('btn !whitespace-normal text-left', A.preset === k && 'btn-on')} title={PRESET_INFO[k].blurb} onClick={() => act(() => { const start = A.start; Object.assign(A, ASSIST_PRESETS[k], { start }); })}>{PRESET_INFO[k].name}</button>
        ))}
      </div>
      <div className="panel-h mb-1">Individual assists {A.preset === 'custom' && <span className="text-amber-300">(custom)</span>}</div>
      {ASSIST_LABELS.map(([k, label, help]) => (
        <label key={k} className="flex items-start gap-2 py-1 cursor-pointer" title={help}>
          <input type="checkbox" className="mt-0.5" checked={!!A[k]} onChange={(e) => act(() => { (A as unknown as Record<string, unknown>)[k] = e.target.checked; A.preset = 'custom'; })} />
          <span><span className="text-slate-200">{label}</span><br /><span className="text-slate-500 text-[11px]">{help}</span></span>
        </label>
      ))}
      <div className="text-[11px] text-slate-500 mt-2">Changes apply immediately. The debrief records which assists were used.</div>
    </div>
  );
}

const KEYS: [string, string][] = [
  ['↑ / ↓', 'Push / pull the yoke (↓ = nose up)'], ['← / →', 'Roll left / right'], ['A / D', 'Rudder left / right (steers on the ground)'],
  ['W / S', 'Throttle up / down'], ['Space', 'Wheel brakes (hold)'], ['P', 'Parking brake'], ['F / Shift+F', 'Flaps down / up one step'],
  ['G', 'Landing gear'], ['[ / ]', 'Trim nose down / up'], ['/', 'Speedbrake: down → armed → up'], ['T', 'Reverse thrust (on the ground)'],
  ['Q', 'Autopilot on / off'], ['M', 'Mouse yoke on / off'], ['V', 'Change view'], ['I', 'Instructor has control / I have control'],
  [', / .', 'Time acceleration slower / faster'], ['Esc', 'Pause'],
];

export function BriefPanel({ p }: { p: PilotState }) {
  const def = ACDEF[p.cfg.aircraft];
  const v = p.vspeeds;
  const dep = p.airports[0], arr = p.airports[p.airports.length - 1];
  const wx = (a: typeof dep) => `${a.ap.icao} wind ${String(a.wind.dir).padStart(3, '0')}°/${a.wind.kt} kt · QNH ${a.qnh} hPa · visibility ${p.env.vis >= 9999 ? '10 km or more' : `${(p.env.vis / 1000).toFixed(1)} km`} · ${p.env.cloudBase > 90000 ? 'sky clear' : `cloud base ${p.env.cloudBase} ft`}`;
  return (
    <div className="p-2 overflow-y-auto h-full text-[12px] leading-relaxed">
      <div className="panel-h">Flight</div>
      <div className="text-slate-200">{p.callsign} · {def.name}</div>
      <div className="text-slate-400">{p.cfg.kind === 'route' ? `${dep.ap.icao} stand ${p.depGate} → ${arr.ap.icao} ${isJet(p) ? 'gate' : 'parking'} ${p.arrGate}` : p.cfg.kind === 'pattern' ? `Traffic pattern at ${dep.ap.icao}` : `Approach to ${dep.ap.icao}`}</div>
      <div className="text-slate-400">Departure runway {p.depRwy.name} ({Math.round(p.depRwy.length)} m, heading {String(Math.round(p.depRwy.hdg)).padStart(3, '0')}°) · landing runway {p.arrRwy.name} (ILS {p.arrRwy.ilsFreq.toFixed(2)}, course {String(Math.round(p.arrRwy.hdg)).padStart(3, '0')}°)</div>
      <div className="text-slate-400">Cruise {p.cruiseAlt} ft · {Math.round(distToGo(p))} NM to go · fuel {isJet(p) ? `${(p.ac.fuel / 1000).toFixed(1)} t` : `${(p.ac.fuel / 2.72).toFixed(0)} US gal`}</div>
      <div className="panel-h mt-2">Route (synthetic waypoints)</div>
      <div className="mono text-[11px] text-slate-300">{p.route.map((w, i) => <span key={i} className={i === p.leg ? 'text-fuchsia-300' : ''}>{w.name}{w.alt && w.kind !== 'rwy' ? `/${w.alt}` : ''}{i < p.route.length - 1 ? ' → ' : ''}</span>)}</div>
      <div className="panel-h mt-2">Weather</div>
      <div className="text-slate-300">{wx(dep)}</div>
      {arr !== dep && <div className="text-slate-300">{wx(arr)}</div>}
      <div className="panel-h mt-2">Speeds (kt)</div>
      <div className="mono text-slate-300">{isJet(p) ? `V1 ${v.v1} · VR ${v.vr} · V2 ${v.v2} · Vref ${v.vref} · Vapp ${v.vapp}` : `Rotate ${v.vr} · best climb ${def.vy} · best glide ${def.glideKt} · final ${v.vapp} · Vref ${v.vref}`}</div>
      <div className="mono text-slate-400 text-[11px]">Flap limits: {def.flaps.slice(1).map((f) => `${f.label} ${f.vfe}`).join(' · ')}{def.retract ? ` · gear ${def.vle}` : ''} · max {def.vmo}</div>
      <div className="panel-h mt-2">Keys</div>
      <div className="grid grid-cols-[86px_1fr] gap-x-2 text-[11.5px]">{KEYS.map(([k, d]) => <div key={k} className="contents"><span className="mono text-cyan-300">{k}</span><span className="text-slate-300">{d}</span></div>)}</div>
      <div className="panel-h mt-2">What is and is not simulated</div>
      <div className="text-slate-400 text-[11.5px]">Generic aircraft tuned from public, rounded figures – not a type-specific procedure trainer. Flat world without terrain, true headings (no magnetic variation), synthetic waypoints and frequencies, shortened system timings, no other traffic, no failures. Airport layouts are the same hand-built approximations used by the tower side.</div>
    </div>
  );
}

export function DebriefModal({ p, onClose, onExit, onRestart }: { p: PilotState; onClose: () => void; onExit: () => void; onRestart: () => void }) {
  const d = debrief(p);
  const col = (s: number) => (s >= 85 ? 'text-emerald-300' : s >= 60 ? 'text-amber-300' : 'text-red-300');
  return (
    <div className="absolute inset-0 z-30 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-navy-850 border border-navy-600 rounded-lg w-[760px] max-w-full max-h-full overflow-y-auto p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-[11px] tracking-[0.3em] text-cyan-a uppercase">Flight debrief</div>
            <div className="text-lg text-slate-100">{p.callsign} · {ACDEF[p.cfg.aircraft].short} · {p.airports[0].ap.icao}{p.airports.length > 1 ? ` → ${p.airports[1].ap.icao}` : ''}</div>
            <div className="text-[12px] text-slate-400">{Math.round(d.minutes)} min · {Math.round(d.nm)} NM flown · {p.ac.crashed ? `ended in an accident: ${p.ac.crashed}` : p.phase === 'complete' ? 'flight completed' : `in progress (${p.phase.replace('_', ' ')})`}</div>
          </div>
          <div className="text-right"><div className={cls('text-4xl font-bold mono', col(d.overall))}>{d.grade}</div><div className="mono text-slate-300">{d.overall}/100</div></div>
        </div>
        {d.notes.length > 0 && <div className="mt-2 text-[12px] text-amber-200/90">{d.notes.map((n, i) => <div key={i}>• {n}</div>)}</div>}
        <div className="grid grid-cols-5 gap-2 mt-3">
          {d.cats.map((c) => <div key={c.id} className="bg-navy-900 border border-navy-700 rounded p-2"><div className="panel-h !text-[9px]">{c.name}</div><div className={cls('mono text-xl', col(c.score))}>{c.score}</div></div>)}
        </div>
        {d.landings.map((l, i) => (
          <div key={i} className="mt-3 bg-navy-900 border border-navy-700 rounded p-2 text-[12px]">
            <div className="flex justify-between"><span className="panel-h">Landing {d.landings.length > 1 ? i + 1 : ''} · runway {l.data.rwy}</span><span className={cls('mono', col(l.score))}>{l.verdict} · {l.score}</span></div>
            <div className="mono text-slate-400 text-[11px]">{Math.round(l.data.fpm)} ft/min · {Math.round(l.data.ias)} kt (Vref {l.data.vref}) · {l.data.offset.toFixed(1)} m from centreline · {Math.round(l.data.dist)} m past threshold · pitch {l.data.pitch.toFixed(1)}° · crab {l.data.crab.toFixed(1)}°</div>
            {l.notes.map((n, j) => <div key={j} className="text-slate-300">• {n}</div>)}
          </div>
        ))}
        <div className="mt-3">
          <div className="panel-h mb-1">Events</div>
          {p.findings.length === 0 && <div className="text-[12px] text-slate-500">Nothing recorded yet.</div>}
          {p.findings.map((f, i) => (
            <div key={i} className="flex gap-2 text-[12px] py-0.5">
              <span className="mono text-slate-600 w-12 shrink-0">{Math.floor(f.t / 60)}:{String(Math.floor(f.t % 60)).padStart(2, '0')}</span>
              <span className={cls('mono w-8 shrink-0 text-right', f.pts < 0 ? 'text-red-300' : 'text-emerald-300')}>{f.pts > 0 ? '+' : ''}{f.pts || ''}</span>
              <span className="text-slate-300">{f.text}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button className="btn" onClick={onExit}>Exit to menu</button>
          <button className="btn" onClick={onRestart}>Fly it again</button>
          {!p.over && <button className="btn btn-primary" onClick={onClose}>Back to the flight</button>}
        </div>
      </div>
    </div>
  );
}

/** compact head-up strip for the outside view */
export function HudStrip({ p }: { p: PilotState }) {
  const ac = p.ac;
  return (
    <div className="mono text-[12px] text-emerald-300/90 bg-black/40 rounded px-2 py-0.5 flex gap-3 pointer-events-none">
      <span>IAS {Math.round(ac.ias)}</span><span>ALT {Math.round(indicatedAlt(p) / 10) * 10}</span><span>V/S {Math.round(((ac.vs / FT) * 60) / 50) * 50}</span>
      <span>HDG {String(Math.round(norm360(ac.hdg)) % 360).padStart(3, '0')}</span><span>GS {Math.round(ac.gs / KT)}</span>
      {!ac.onGround && <span>AGL {Math.round(ac.agl / FT / 10) * 10}</span>}<span>{distToGo(p).toFixed(distToGo(p) < 20 ? 1 : 0)} NM</span>
      {void NM}
    </div>
  );
}
