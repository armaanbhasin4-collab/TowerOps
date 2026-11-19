import { useEffect, useMemo, useRef, useState } from 'react';
import { useUI } from '../store';
import type { CustomAirportParams, Difficulty, GameMode, ScenarioConfig, SizeClass, WeatherPreset } from '../sim/types';
import { DIFFICULTY_PRESETS, Sim, defaultConfig } from '../sim/sim';
import { AIRPORT_DEFS, getAirport } from '../sim/airport';
import { validateAirport } from '../sim/airport/build';
import { CUSTOM_AIRLINES, defaultCustomParams, runwaySpecs } from '../sim/airport/custom';
import { CAREER, CHALLENGES, careerConfig, challengeConfig } from '../sim/scenarios';
import { airlineOf } from '../sim/data/airlines';
import { draw, fitAirport } from '../render/map';
import { deleteSave, getCareer, getHistory, listSaves } from '../saves';
import { fmtDur } from '../sim/util';

const BLURB: Record<string, string> = {
  ATL: 'Five parallel runways, seven concourses and the Delta hub. The flagship experience.',
  JFK: 'Four runways, heavy international widebody banks, complex taxi routes.',
  LAX: 'Four parallels in two complexes with runway crossings and Pacific heavies.',
  EGLL: 'Two runways at capacity, long-haul heavies, terminals on both sides.',
  LGA: 'Two intersecting runways – every departure and arrival must be timed.',
  REG: 'One runway, a handful of gates, regional jets and general aviation.',
  CUSTOM: 'Design a fictional airport: 1–8 runways, terminals, gates, taxiway complexity.',
};
type Preset = Exclude<Difficulty['preset'], 'custom'>;

function Slider({ label, value, min, max, step, onChange, fmt }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <label className="flex items-center gap-2 text-[12px] py-0.5">
      <span className="w-40 text-slate-400">{label}</span>
      <input type="range" className="flex-1 accent-cyan-400" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} />
      <span className="mono w-16 text-right text-slate-200">{fmt ? fmt(value) : value}</span>
    </label>
  );
}
function Toggle({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return <label className="flex items-center gap-2 text-[12px] py-0.5" title={hint}><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /><span className="text-slate-300">{label}</span></label>;
}

function Preview({ cfg }: { cfg: Pick<ScenarioConfig, 'airportId' | 'custom'> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const key = JSON.stringify(cfg);
  const [err, setErr] = useState('');
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    try {
      const W = cv.parentElement!.clientWidth, H = 250, dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
      const c = defaultConfig(cfg.airportId, 'beginner');
      const sim = new Sim({ ...c, custom: cfg.custom, emptyStart: true });
      const problems = validateAirport(sim.ap);
      setErr(problems.join('; '));
      draw(cv.getContext('2d')!, W, H, sim, fitAirport(sim.ap, W, H), { mode: 'ground', selectedId: null, tagLevel: 0, showFixes: false, showRings: false, showTrails: false, showWeather: false, showLabels: true, showVectors: false, filter: 'all', guidance: false, time: 0 });
    } catch (e) { setErr((e as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <div className="rounded border border-navy-600 overflow-hidden bg-navy-950"><canvas ref={ref} />{err && <div className="text-amber-a text-[11px] px-2 py-1">Layout warning: {err}</div>}</div>;
}

function CustomBuilder({ p, set }: { p: CustomAirportParams; set: (p: CustomAirportParams) => void }) {
  const [count, setCount] = useState(p.runways.length);
  const [len, setLen] = useState(p.runways[0]?.length ?? 2900);
  const [hdg, setHdg] = useState(p.runways[0]?.hdg ?? 90);
  const regen = (c = count, layout = p.layout, l = len, h = hdg) => set({ ...p, layout, runways: runwaySpecs(c, layout, l, h) });
  const cats: SizeClass[] = ['S', 'M', 'L', 'XL'];
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-[12px]"><span className="w-40 text-slate-400">Airport name</span><input className="field flex-1" value={p.name} onChange={(e) => set({ ...p, name: e.target.value.slice(0, 28) || 'Custom Field' })} /></label>
      <Slider label="Runways" value={count} min={1} max={8} step={1} onChange={(v) => { setCount(v); regen(v); }} />
      <div className="flex items-center gap-2 text-[12px]"><span className="w-40 text-slate-400">Runway layout</span>{(['parallel', 'intersecting', 'mixed'] as const).map((l) => <button key={l} className={`btn capitalize ${p.layout === l ? 'btn-on' : ''}`} onClick={() => regen(count, l)}>{l}</button>)}</div>
      <Slider label="Longest runway" value={len} min={1400} max={4200} step={100} onChange={(v) => { setLen(v); regen(count, p.layout, v); }} fmt={(v) => `${v} m`} />
      <Slider label="Primary orientation" value={hdg} min={10} max={180} step={10} onChange={(v) => { setHdg(v); regen(count, p.layout, len, v); }} fmt={(v) => `${String(v).padStart(3, '0')}°`} />
      {p.runways.map((r, i) => (
        <div key={i} className="flex items-center gap-2 text-[11px] pl-40 mono text-slate-400">
          RWY {i + 1}
          <input type="number" className="field w-20" min={1000} max={4500} step={50} value={r.length} onChange={(e) => set({ ...p, runways: p.runways.map((x, j) => (j === i ? { ...x, length: Math.max(1000, Math.min(4500, +e.target.value || 2000)) } : x)) })} /> m
          <input type="number" className="field w-16" min={1} max={360} step={5} value={r.hdg} onChange={(e) => set({ ...p, runways: p.runways.map((x, j) => (j === i ? { ...x, hdg: ((+e.target.value || 360) + 360) % 360 } : x)) })} /> °
        </div>
      ))}
      <Slider label="Terminals / piers" value={p.terminals} min={1} max={8} step={1} onChange={(v) => set({ ...p, terminals: v })} />
      <Slider label="Gates per terminal" value={p.gatesPerTerminal} min={2} max={36} step={2} onChange={(v) => set({ ...p, gatesPerTerminal: v })} />
      <Slider label="Taxiway complexity" value={p.taxiComplexity} min={0} max={1} step={0.05} onChange={(v) => set({ ...p, taxiComplexity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
      <Slider label="Airport size (spacing)" value={p.size} min={0.6} max={1.6} step={0.05} onChange={(v) => set({ ...p, size: v })} fmt={(v) => `${v.toFixed(2)}×`} />
      <div className="flex items-center gap-2 text-[12px]"><span className="w-40 text-slate-400">Aircraft categories</span>
        {cats.map((c) => <button key={c} className={`btn ${p.categories.includes(c) ? 'btn-on' : ''}`} onClick={() => { const n = p.categories.includes(c) ? p.categories.filter((x) => x !== c) : [...p.categories, c]; set({ ...p, categories: n.length ? n : ['M'] }); }}>{{ S: 'Regional', M: 'Narrowbody', L: 'Widebody', XL: 'Super / 777-300' }[c]}</button>)}
      </div>
      <div className="flex gap-2 text-[12px]"><span className="w-40 text-slate-400 shrink-0">Airline mix</span>
        <div className="flex flex-wrap gap-1">{CUSTOM_AIRLINES.map((a) => <button key={a} title={airlineOf(a).name} className={`btn !px-1.5 !py-0 mono ${p.airlines.includes(a) ? 'btn-on' : ''}`} onClick={() => { const n = p.airlines.includes(a) ? p.airlines.filter((x) => x !== a) : [...p.airlines, a]; set({ ...p, airlines: n.length ? n : ['DAL'] }); }}>{a}</button>)}</div>
      </div>
    </div>
  );
}

export default function StartScreen() {
  const { start, resume } = useUI.getState();
  const [mode, setMode] = useState<GameMode>('sandbox');
  const [airport, setAirport] = useState('ATL');
  const [preset, setPreset] = useState<Difficulty['preset']>('intermediate');
  const [diff, setDiff] = useState<Difficulty>({ ...DIFFICULTY_PRESETS.intermediate });
  const [weather, setWeather] = useState<WeatherPreset>('clear');
  const [wind, setWind] = useState({ dir: 270, kt: 8, vis: 10 });
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 99999));
  const [clock, setClock] = useState(14);
  const [custom, setCustom] = useState<CustomAirportParams>(defaultCustomParams());
  const [showAdv, setShowAdv] = useState(false);
  const [saves, setSaves] = useState(listSaves());
  const [density, setDensity] = useState(1);
  const career = getCareer();
  const history = useMemo(() => getHistory().slice(0, 5), []);
  const pickPreset = (p: Preset) => { setPreset(p); setDiff({ ...DIFFICULTY_PRESETS[p] }); setDensity(1); };
  const patch = (d: Partial<Difficulty>) => { setDiff({ ...diff, ...d, preset: 'custom' }); setPreset('custom'); };
  const realism = mode === 'realism';

  const go = () => {
    const base = defaultConfig(airport, 'intermediate');
    let d: Difficulty = { ...diff, preset };
    d = { ...d, arrivalRate: d.arrivalRate * density, departureRate: d.departureRate * density, maxAircraft: Math.round(d.maxAircraft * Math.max(1, density)) };
    if (realism) d = { ...d, pilotAssist: false, atcGuidance: false, safetyIntervention: false, strictSeparation: true, wakeSeparation: true, fuelRealism: true, perfRealism: true, radioComplexity: Math.max(d.radioComplexity, 0.6) };
    const cfg: ScenarioConfig = {
      ...base, mode, difficulty: d, weatherPreset: weather, seed, startClock: clock * 3600,
      custom: airport === 'CUSTOM' ? custom : undefined,
      customWeather: weather === 'custom' ? { windDir: wind.dir, windKt: wind.kt, gustKt: 0, visSM: wind.vis, ceilingFt: wind.vis < 1 ? 200 : wind.vis < 3 ? 900 : 99999, precip: wind.vis < 1 ? 'fog' : 'none', surface: 'dry' } : undefined,
    };
    start(cfg);
  };
  const apInfo = (id: string) => { try { const ap = getAirport({ airportId: id, custom }); return `${ap.runways.length} runway${ap.runways.length > 1 ? 's' : ''} · ${ap.gates.length} gates`; } catch { return ''; } };
  const cards = [...AIRPORT_DEFS.map((d) => ({ id: d.id, icao: d.icao, name: d.name, city: d.city, fictional: d.fictional })), { id: 'CUSTOM', icao: 'CUSTOM', name: 'Custom Airport Builder', city: 'Fictional scenario', fictional: true }];

  return (
    <div className="h-full overflow-y-auto bg-[radial-gradient(ellipse_at_top,#0f2236_0%,#050a11_60%)]">
      <div className="max-w-[1180px] mx-auto px-6 py-6">
        <div className="flex items-end justify-between border-b border-navy-600 pb-4">
          <div>
            <div className="text-[11px] tracking-[0.35em] text-cyan-a uppercase">Air Traffic Control & Airport Operations Simulator</div>
            <h1 className="text-4xl font-bold text-white tracking-tight mt-1">TOWER<span className="text-radar">OPS</span></h1>
            <div className="text-slate-400 mt-1 text-[13px]">You are Clearance, Ground, Tower, Approach and Departure. Nothing moves without your clearance.</div>
          </div>
          <div className="text-right text-[11px] text-slate-500 max-w-[330px]">A game simulation – not certified for, and not connected to, real-world air traffic control. Airlines and aircraft types are real; flights are simulated.</div>
        </div>

        <div className="flex gap-1 mt-4">
          {([['sandbox', 'Sandbox'], ['career', 'Career'], ['challenge', 'Challenges'], ['realism', 'Realism']] as [GameMode, string][]).map(([m, l]) => (
            <button key={m} onClick={() => setMode(m)} className={`px-4 py-2 rounded-t border border-b-0 text-[13px] uppercase tracking-wider ${mode === m ? 'bg-navy-800 border-navy-600 text-cyan-a' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>{l}</button>
          ))}
        </div>

        <div className="bg-navy-800/60 border border-navy-600 rounded-b rounded-tr p-4">
          {mode === 'career' && (
            <div>
              <div className="text-slate-300 mb-3 text-[13px]">Start at a regional tower and work up to Atlanta. Reach the pass rating with no accidents to unlock the next posting.</div>
              <div className="grid grid-cols-2 gap-2">
                {CAREER.map((l) => {
                  const locked = l.id > career.unlocked;
                  return (
                    <button key={l.id} disabled={locked} onClick={() => start(careerConfig(l.id), l.id)} className={`text-left p-3 rounded border ${locked ? 'border-navy-700 bg-navy-900/40' : 'border-navy-600 bg-navy-850 hover:border-cyan-a'}`}>
                      <div className="flex justify-between"><span className="text-slate-100 font-semibold">{l.id}. {l.title}</span><span className="mono text-[11px] text-slate-400">{locked ? '🔒 locked' : career.best[l.id] !== undefined ? `best ${career.best[l.id]}` : 'new'}</span></div>
                      <div className="text-[12px] text-slate-400">{l.blurb}</div>
                      <div className="text-[11px] text-slate-500 mt-1 capitalize">{l.airport} · {l.preset} · {l.weather} weather · {fmtDur(l.duration)} · pass ≥ {l.pass}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {mode === 'challenge' && (
            <div className="grid grid-cols-2 gap-2">
              {CHALLENGES.map((c) => (
                <button key={c.id} onClick={() => start(challengeConfig(c.id, seed))} className="text-left p-3 rounded border border-navy-600 bg-navy-850 hover:border-cyan-a">
                  <div className="text-slate-100 font-semibold">{c.title}</div>
                  <div className="text-[12px] text-slate-400">{c.blurb}</div>
                  <div className="text-[11px] text-slate-500 mt-1 capitalize">{c.airport} · {c.preset} · {c.weather} · {fmtDur(c.duration)}</div>
                </button>
              ))}
            </div>
          )}
          {(mode === 'sandbox' || mode === 'realism') && (
            <div className="grid grid-cols-12 gap-5">
              <div className="col-span-5">
                <div className="panel-h mb-1.5">1 · Airport</div>
                <div className="space-y-1.5">
                  {cards.map((c) => (
                    <button key={c.id} onClick={() => setAirport(c.id)} className={`w-full text-left px-3 py-2 rounded border ${airport === c.id ? 'border-cyan-a bg-navy-700' : 'border-navy-600 bg-navy-850 hover:border-navy-600 hover:bg-navy-800'}`}>
                      <div className="flex items-baseline gap-2"><span className="mono font-bold text-cyan-a w-14">{c.icao === 'CUSTOM' ? '＋' : c.icao}</span><span className="text-slate-100 font-medium truncate">{c.name}</span>{c.id === 'ATL' && <span className="text-[10px] px-1 rounded bg-emerald-900/60 text-radar">FLAGSHIP</span>}{c.fictional && <span className="text-[10px] px-1 rounded bg-amber-900/50 text-amber-a">FICTIONAL</span>}</div>
                      <div className="text-[11.5px] text-slate-400 pl-16">{BLURB[c.id]} <span className="text-slate-500">{c.id !== 'CUSTOM' ? apInfo(c.id) : ''}</span></div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="col-span-7 space-y-3">
                <div>
                  <div className="panel-h mb-1.5">Layout preview</div>
                  <Preview cfg={{ airportId: airport, custom: airport === 'CUSTOM' ? custom : undefined }} />
                  <div className="text-[11px] text-slate-500 mt-1">{(() => { try { return getAirport({ airportId: airport, custom }).dataNote; } catch { return ''; } })()}</div>
                </div>
                {airport === 'CUSTOM' && <div><div className="panel-h mb-1.5">Custom airport builder</div><CustomBuilder p={custom} set={setCustom} /></div>}
                <div>
                  <div className="panel-h mb-1.5">2 · Difficulty {realism && <span className="text-amber-a normal-case tracking-normal">— Realism mode forces strict separation, wake turbulence, full manual control and no visual assistance</span>}</div>
                  <div className="flex gap-1.5">
                    {(['beginner', 'intermediate', 'advanced', 'expert'] as Preset[]).map((p) => <button key={p} className={`btn capitalize flex-1 !py-1.5 ${preset === p ? 'btn-on' : ''}`} onClick={() => pickPreset(p)}>{p === 'expert' ? 'Expert / Realistic' : p}</button>)}
                    <button className={`btn flex-1 !py-1.5 ${preset === 'custom' ? 'btn-on' : ''}`} onClick={() => { setShowAdv(true); setPreset('custom'); }}>Custom</button>
                  </div>
                  <div className="text-[11.5px] text-slate-400 mt-1">
                    {preset === 'beginner' && '3–6 active aircraft, clear weather, ATC suggestions, relaxed separation, automatic collision avoidance.'}
                    {preset === 'intermediate' && '7–15 active aircraft, realistic taxiing, occasional emergencies, variable weather, standard separation.'}
                    {preset === 'advanced' && '16–30 active aircraft, heavy flows, wake turbulence, congested taxiways, no hints, strict enforcement.'}
                    {preset === 'expert' && '30+ aircraft where the airport supports it, limited pilot assistance, readback errors, fuel limits, no artificial collision prevention – an accident ends the session.'}
                    {preset === 'custom' && 'Every parameter is yours to set below.'}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-6">
                  <div>
                    <div className="panel-h mb-1">3 · Traffic & emergencies</div>
                    <Slider label="Traffic density" value={density} min={0.4} max={2} step={0.1} onChange={setDensity} fmt={(v) => `${Math.round(v * 100)}%`} />
                    <Slider label="Emergency frequency" value={diff.emergencyFreq} min={0} max={6} step={0.1} onChange={(v) => patch({ emergencyFreq: v })} fmt={(v) => (v === 0 ? 'off' : `${v.toFixed(1)}/h`)} />
                    <Slider label="Start time (local)" value={clock} min={5} max={23} step={1} onChange={setClock} fmt={(v) => `${String(v).padStart(2, '0')}:00`} />
                    <label className="flex items-center gap-2 text-[12px] py-0.5"><span className="w-40 text-slate-400">Scenario seed</span><input className="field w-24" value={seed} onChange={(e) => setSeed(+e.target.value.replace(/\D/g, '') || 0)} /><button className="btn" onClick={() => setSeed(Math.floor(Math.random() * 99999))}>Random</button></label>
                  </div>
                  <div>
                    <div className="panel-h mb-1">4 · Weather</div>
                    <div className="flex flex-wrap gap-1">
                      {(['clear', 'rain', 'thunderstorm', 'fog', 'winter', 'dynamic', 'custom'] as WeatherPreset[]).map((w) => <button key={w} className={`btn capitalize ${weather === w ? 'btn-on' : ''}`} onClick={() => setWeather(w)}>{w}</button>)}
                    </div>
                    <Slider label="Weather severity" value={diff.weatherSeverity} min={0} max={1} step={0.05} onChange={(v) => patch({ weatherSeverity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                    {weather === 'custom' && <>
                      <Slider label="Wind direction" value={wind.dir} min={10} max={360} step={10} onChange={(v) => setWind({ ...wind, dir: v })} fmt={(v) => `${String(v).padStart(3, '0')}°`} />
                      <Slider label="Wind speed" value={wind.kt} min={0} max={45} step={1} onChange={(v) => setWind({ ...wind, kt: v })} fmt={(v) => `${v} kt`} />
                      <Slider label="Visibility" value={wind.vis} min={0.25} max={10} step={0.25} onChange={(v) => setWind({ ...wind, vis: v })} fmt={(v) => `${v} SM`} />
                    </>}
                    <div className="text-[11px] text-slate-500 mt-1">Real-world weather feeds are not connected in this build; all weather is simulated.</div>
                  </div>
                </div>
                <div>
                  <button className="text-[11px] text-cyan-a uppercase tracking-wider" onClick={() => setShowAdv(!showAdv)}>{showAdv ? '▾' : '▸'} Custom difficulty & realism options</button>
                  {showAdv && (
                    <div className="grid grid-cols-2 gap-x-6 mt-1.5 p-3 rounded border border-navy-600 bg-navy-900/60">
                      <div>
                        <Slider label="Max active aircraft" value={diff.maxAircraft} min={3} max={70} step={1} onChange={(v) => patch({ maxAircraft: v })} />
                        <Slider label="Arrivals per hour" value={diff.arrivalRate} min={0} max={80} step={1} onChange={(v) => patch({ arrivalRate: v })} />
                        <Slider label="Departures per hour" value={diff.departureRate} min={2} max={80} step={1} onChange={(v) => patch({ departureRate: v })} />
                        <Slider label="Ground complexity" value={diff.groundComplexity} min={0} max={1} step={0.05} onChange={(v) => patch({ groundComplexity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                        <Slider label="Radio complexity" value={diff.radioComplexity} min={0} max={1} step={0.05} onChange={(v) => patch({ radioComplexity: v })} fmt={(v) => `${Math.round(v * 100)}%`} />
                        <Slider label="Runway capacity" value={diff.runwayCapacity} min={0.2} max={1} step={0.1} onChange={(v) => patch({ runwayCapacity: v })} fmt={(v) => `${Math.round(v * 100)}% open`} />
                      </div>
                      <div>
                        <Toggle label="Pilot assistance (crews refuse clearly unsafe clearances)" value={diff.pilotAssist} onChange={(v) => patch({ pilotAssist: v })} />
                        <Toggle label="ATC guidance (suggested next instruction)" value={diff.atcGuidance} onChange={(v) => patch({ atcGuidance: v })} />
                        <Toggle label="Safety intervention (TCAS-style avoidance)" value={diff.safetyIntervention} onChange={(v) => patch({ safetyIntervention: v })} />
                        <Toggle label="Strict separation (3 NM / 1,000 ft)" value={diff.strictSeparation} onChange={(v) => patch({ strictSeparation: v })} />
                        <Toggle label="Wake turbulence separation" value={diff.wakeSeparation} onChange={(v) => patch({ wakeSeparation: v })} />
                        <Toggle label="Fuel realism (minimum fuel, diversions)" value={diff.fuelRealism} onChange={(v) => patch({ fuelRealism: v })} />
                        <Toggle label="Performance realism (runway length, wind limits)" value={diff.perfRealism} onChange={(v) => patch({ perfRealism: v })} />
                        <Toggle label="An accident ends the scenario" value={diff.collisionEnds} onChange={(v) => patch({ collisionEnds: v })} />
                      </div>
                    </div>
                  )}
                </div>
                <button className="w-full py-3 rounded bg-emerald-700 hover:bg-emerald-600 text-white font-semibold tracking-wider uppercase text-sm border border-emerald-500" onClick={go}>Open the position — start controlling {airport === 'CUSTOM' ? custom.name : airport}</button>
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4 mt-4">
          <div className="bg-navy-800/40 border border-navy-700 rounded p-3">
            <div className="panel-h mb-1.5">Saved scenarios</div>
            {!saves.length && <div className="text-slate-500 text-[12px]">No saves yet. Use “Save” in the top bar during a session.</div>}
            {saves.map((m) => (
              <div key={m.slot} className="flex items-center gap-2 text-[12px] py-0.5">
                <span className="mono text-cyan-a w-10">{m.airport}</span><span className="text-slate-300 flex-1 truncate">{m.slot}</span>
                <span className="text-slate-500 capitalize">{m.mode}/{m.difficulty} · {fmtDur(m.simTime)} · {m.score}</span>
                <button className="btn btn-go !py-0" onClick={() => resume(m.slot)}>Resume</button>
                <button className="btn !py-0" onClick={() => { deleteSave(m.slot); setSaves(listSaves()); }}>✕</button>
              </div>
            ))}
          </div>
          <div className="bg-navy-800/40 border border-navy-700 rounded p-3">
            <div className="panel-h mb-1.5">Recent sessions</div>
            {!history.length && <div className="text-slate-500 text-[12px]">Your session ratings will appear here for comparison.</div>}
            {history.map((h, i) => <div key={i} className="flex gap-2 text-[12px] mono py-0.5"><span className="text-cyan-a w-10">{h.airport}</span><span className="text-slate-400 flex-1 capitalize font-sans">{h.mode} · {h.difficulty} · {fmtDur(h.simTime)} · {h.landed + h.departed} movements</span><span className="text-slate-500">S{h.safety} E{h.efficiency}</span><span className={h.overall >= 75 ? 'text-radar' : h.overall >= 50 ? 'text-amber-a' : 'text-red-a'}>{h.overall}</span></div>)}
          </div>
        </div>
        <div className="text-[11px] text-slate-600 mt-4 leading-relaxed">Data integrity: runway designators, counts and general geometry of the real airports follow the real world; taxiway networks, gate positions and fix locations are simplified approximations. Aircraft performance figures are documented approximations. All flights, schedules and weather are simulated – nothing here is live aviation data.</div>
      </div>
    </div>
  );
}
