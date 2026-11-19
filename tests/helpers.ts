import { Sim, defaultConfig } from '../src/sim/sim';
import type { Aircraft, ScenarioConfig } from '../src/sim/types';
import { NM } from '../src/sim/util';
import { suggest, applySuggestion } from '../src/sim/delegation';

export function quietConfig(airport = 'ATL', over: Partial<ScenarioConfig> = {}): ScenarioConfig {
  const cfg = defaultConfig(airport, 'intermediate');
  cfg.emptyStart = true;
  cfg.difficulty.radioComplexity = 0;
  cfg.difficulty.emergencyFreq = 0;
  cfg.difficulty.arrivalRate = 0;
  cfg.weatherPreset = 'custom';
  cfg.customWeather = { windDir: 270, windKt: 5, gustKt: 0 };
  return { ...cfg, ...over };
}

export function until(sim: Sim, cond: () => boolean, maxSec: number, label: string, each?: () => void) {
  for (let i = 0; i < maxSec && !cond(); i++) {
    sim.advance(1);
    each?.();
  }
  if (!cond()) throw new Error(`timeout waiting for: ${label} (t=${sim.s.t.toFixed(0)})`);
}

export function ok(sim: Sim, text: string) {
  const r = sim.commandText(text);
  if (!r.ok) throw new Error(`command "${text}" failed: ${r.message}`);
  sim.advance(4); // readback delay
}

export const distNm = (a: Aircraft, x = 0, y = 0) => Math.hypot(a.x - x, a.y - y) / NM;

/** drive an aircraft with the suggestion engine through the normal command pipeline */
export function autoControl(sim: Sim, ac: Aircraft) {
  const sg = suggest(sim, ac);
  if (sg && sg.cmds.length) applySuggestion(sim, ac, sg, 'player');
}
