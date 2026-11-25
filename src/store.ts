import type { PilotConfig } from './pilot/types';
/** UI store + real-time game loop. The Sim instance is the single source of truth; React re-renders on `tick`. */
import { create } from 'zustand';
import { Sim, DT } from './sim/sim';
import type { Command, CommandResult, Position, ScenarioConfig } from './sim/types';
import { computeScore } from './sim/scoring';
import { suggest, applySuggestion } from './sim/delegation';
import { voiceToCommand } from './sim/voice';
import { addHistory, getPrefs, setCareer, setPrefs, writeSave, readSave } from './saves';
import { CAREER } from './sim/scenarios';
import { speak, tone } from './ui/speech';

export type ViewMode = 'radar' | 'ground' | 'tower';
export interface Settings {
  tagLevel: 0 | 1 | 2;
  showFixes: boolean; showRings: boolean; showTrails: boolean; showWeather: boolean; showLabels: boolean; showVectors: boolean;
  filter: 'all' | 'arr' | 'dep';
  sound: boolean; tts: boolean;
  layout: 'standard' | 'wide' | 'focus';
}
const defaultSettings: Settings = { tagLevel: 1, showFixes: true, showRings: true, showTrails: true, showWeather: true, showLabels: true, showVectors: true, filter: 'all', sound: true, tts: false, layout: 'standard' };

export interface Toast { text: string; kind: 'ok' | 'error' | 'info'; at: number }
export interface Preview { nodes: number[]; ac: number }

interface UI {
  screen: 'start' | 'game' | 'pilotSetup' | 'pilot';
  pilotCfg: PilotConfig | null;
  pilotKey: number;
  openPilot(): void;
  startPilot(cfg: PilotConfig): void;
  sim: Sim | null;
  tick: number;
  speed: number;
  paused: boolean;
  selectedId: number | null;
  view: ViewMode;
  follow: boolean;
  focus: { x: number; y: number; n: number; zoom?: boolean } | null;
  settings: Settings;
  toast: Toast | null;
  preview: Preview | null;
  modal: null | 'settings' | 'report' | 'replay' | 'help';
  replayAt: number | null;
  careerLevel: number | null;
  start(cfg: ScenarioConfig, careerLevel?: number): void;
  resume(slot: string): boolean;
  exit(): void;
  select(id: number | null, focus?: boolean): void;
  setView(v: ViewMode): void;
  setSpeed(s: number): void;
  togglePause(): void;
  setSettings(p: Partial<Settings>): void;
  setModal(m: UI['modal'], replayAt?: number): void;
  setPreview(p: Preview | null): void;
  focusOn(x: number, y: number, zoom?: boolean): void;
  setFollow(f: boolean): void;
  issue(acId: number, cmds: Command[]): CommandResult;
  issueText(text: string, fromVoice?: boolean): CommandResult;
  doSuggestion(acId: number): CommandResult;
  delegate(pos: Position, on: boolean): void;
  save(slot?: string): boolean;
  endSession(): void;
  notify(text: string, kind?: Toast['kind']): void;
}

let lastRadio = 0, lastEvent = 0, lastReqCount = 0;

export const useUI = create<UI>((set, get) => ({
  screen: 'start', pilotCfg: null, pilotKey: 0,
  openPilot() { set({ screen: 'pilotSetup' }); },
  startPilot(cfg) { set({ screen: 'pilot', pilotCfg: cfg, pilotKey: get().pilotKey + 1 }); },
  sim: null, tick: 0, speed: 1, paused: false, selectedId: null, view: 'ground', follow: false, focus: null,
  settings: { ...defaultSettings, ...getPrefs<Partial<Settings>>({}) }, toast: null, preview: null, modal: null, replayAt: null, careerLevel: null,

  start(cfg, careerLevel) {
    const sim = new Sim(cfg);
    lastRadio = sim.s.radio.length; lastEvent = sim.s.events.length; lastReqCount = 0;
    set({ sim, screen: 'game', selectedId: null, paused: false, speed: 1, tick: 0, view: 'ground', modal: null, preview: null, careerLevel: careerLevel ?? null, follow: false });
    (window as any).__sim = sim;
  },
  resume(slot) {
    const data = readSave(slot);
    if (!data) return false;
    try {
      const sim = Sim.deserialize(data);
      lastRadio = sim.s.radio.length; lastEvent = sim.s.events.length;
      set({ sim, screen: 'game', selectedId: null, paused: true, speed: 1, tick: 0, modal: null, preview: null, careerLevel: null });
      (window as any).__sim = sim;
      return true;
    } catch (e) {
      get().notify((e as Error).message, 'error');
      return false;
    }
  },
  exit() { set({ screen: 'start', sim: null, modal: null, selectedId: null }); },
  select(id, focus) {
    set({ selectedId: id, preview: null });
    const sim = get().sim;
    if (focus && id !== null && sim) {
      const ac = sim.s.aircraft.find((a) => a.id === id);
      if (ac) get().focusOn(ac.x, ac.y);
    }
  },
  setView(v) { set({ view: v }); },
  setSpeed(s) { set({ speed: s, paused: false }); },
  togglePause() { set({ paused: !get().paused }); },
  setSettings(p) { const settings = { ...get().settings, ...p }; set({ settings }); setPrefs(settings); },
  setModal(m, replayAt) { set({ modal: m, replayAt: replayAt ?? null, paused: m === 'report' || m === 'replay' ? true : get().paused }); },
  setPreview(p) { set({ preview: p }); },
  focusOn(x, y, zoom) { set({ focus: { x, y, n: (get().focus?.n ?? 0) + 1, zoom } }); },
  setFollow(f) { set({ follow: f }); },
  issue(acId, cmds) {
    const sim = get().sim;
    if (!sim) return { ok: false, message: 'No simulation.' };
    const r = sim.command(acId, cmds);
    after(r);
    return r;
  },
  issueText(text, fromVoice) {
    const sim = get().sim;
    if (!sim) return { ok: false, message: 'No simulation.' };
    const r = sim.commandText(fromVoice ? voiceToCommand(text) : text);
    after(r);
    return r;
  },
  doSuggestion(acId) {
    const sim = get().sim;
    const ac = sim?.s.aircraft.find((a) => a.id === acId);
    if (!sim || !ac) return { ok: false };
    const sg = suggest(sim, ac);
    if (!sg) return { ok: false, message: 'No suggestion available.' };
    const r = applySuggestion(sim, ac, sg, 'player');
    after(r);
    return r;
  },
  delegate(pos, on) { get().sim?.setDelegation(pos, on); set({ tick: get().tick + 1 }); },
  save(slot) {
    const sim = get().sim;
    if (!sim) return false;
    const name = slot ?? `${sim.ap.iata}-${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const ok = writeSave({ slot: name, airport: sim.ap.iata, mode: sim.s.cfg.mode, difficulty: sim.s.cfg.difficulty.preset, simTime: sim.s.t, savedAt: Date.now(), score: computeScore(sim.s).overall, version: sim.s.version }, sim.serialize());
    get().notify(ok ? `Saved "${name}"` : 'Save failed (browser storage full or unavailable)', ok ? 'ok' : 'error');
    return ok;
  },
  endSession() {
    const sim = get().sim;
    if (!sim) return;
    if (!sim.s.over) { sim.s.over = true; sim.s.overReason = 'Session ended by controller'; }
    recordSession();
    set({ modal: 'report', paused: true });
  },
  notify(text, kind = 'info') { set({ toast: { text, kind, at: Date.now() } }); },
}));

function after(r: CommandResult) {
  const st = useUI.getState();
  if (!r.ok && r.message) { st.notify(r.message, 'error'); if (st.settings.sound) tone('error'); }
  else if (r.ok && st.settings.sound) tone('ok');
  if (r.ok && st.preview) useUI.setState({ preview: null });
  useUI.setState({ tick: st.tick + 1 });
}

let recorded: Sim | null = null;
function recordSession() {
  const { sim, careerLevel } = useUI.getState();
  if (!sim || recorded === sim) return;
  recorded = sim;
  const sc = computeScore(sim.s);
  addHistory({ airport: sim.ap.iata, mode: sim.s.cfg.mode, difficulty: sim.s.cfg.difficulty.preset, simTime: sim.s.t, date: Date.now(), overall: sc.overall, safety: sc.safety, efficiency: sc.efficiency, landed: sim.s.stats.landed, departed: sim.s.stats.departed, challenge: sim.s.cfg.challenge });
  if (careerLevel) {
    const lvl = CAREER.find((l) => l.id === careerLevel);
    if (lvl) setCareer(careerLevel, sc.overall, sc.overall >= lvl.pass && sim.s.stats.collisions === 0);
  }
}

// ───────── real-time loop: fixed-step simulation decoupled from rendering ─────────
let last = 0, acc = 0, uiAcc = 0;
function frame(now: number) {
  requestAnimationFrame(frame);
  const st = useUI.getState();
  const dtReal = Math.min(0.25, (now - (last || now)) / 1000);
  last = now;
  const sim = st.sim;
  if (!sim || st.screen !== 'game') return;
  if (!st.paused && !sim.s.over && st.modal !== 'replay') {
    acc += dtReal * st.speed;
    let n = Math.floor(acc / DT);
    acc -= n * DT;
    if (n > 400) n = 400; // never spiral if the tab was throttled
    for (let i = 0; i < n; i++) sim.step();
  }
  uiAcc += dtReal;
  if (uiAcc >= 0.12) {
    uiAcc = 0;
    sideEffects(sim, st);
    useUI.setState({ tick: st.tick + 1 });
  }
}
function sideEffects(sim: Sim, st: UI) {
  const s = sim.s;
  if (s.radio.length < lastRadio) lastRadio = 0;
  if (s.events.length < lastEvent) lastEvent = 0;
  // pilot voices
  for (let i = lastRadio; i < s.radio.length; i++) {
    const r = s.radio[i];
    if (st.settings.tts && r.from === 'pilot' && st.speed <= 2) speak(r.text, r.ac ?? 0);
  }
  lastRadio = s.radio.length;
  let worst: 'critical' | 'alert' | null = null;
  for (let i = lastEvent; i < s.events.length; i++) {
    const e = s.events[i];
    if (e.sev === 'critical') worst = 'critical';
    else if (e.sev === 'warning' && !worst) worst = 'alert';
  }
  lastEvent = s.events.length;
  const reqs = s.aircraft.filter((a) => a.request && (a.request.deferredUntil ?? 0) < s.t).length;
  if (st.settings.sound) {
    if (worst) tone(worst);
    else if (reqs > lastReqCount) tone('request');
  }
  lastReqCount = reqs;
  if (s.over && st.modal !== 'report' && st.modal !== 'replay') {
    recordSession();
    useUI.setState({ modal: 'report', paused: true });
  }
}
if (typeof window !== 'undefined') requestAnimationFrame(frame);
