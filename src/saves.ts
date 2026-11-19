/** Local persistence: versioned save slots, session history and career progress (localStorage). */
import { SAVE_VERSION } from './sim/sim';

const PFX = 'towerops:';
export interface SaveMeta { slot: string; airport: string; mode: string; difficulty: string; simTime: number; savedAt: number; score: number; version: number }
export interface SessionRecord { airport: string; mode: string; difficulty: string; simTime: number; date: number; overall: number; safety: number; efficiency: number; landed: number; departed: number; challenge?: string }

const get = <T,>(k: string, d: T): T => {
  try { const v = localStorage.getItem(PFX + k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
};
const set = (k: string, v: unknown) => { try { localStorage.setItem(PFX + k, JSON.stringify(v)); return true; } catch { return false; } };

export function listSaves(): SaveMeta[] { return get<SaveMeta[]>('saves', []).filter((m) => m.version === SAVE_VERSION); }
export function writeSave(meta: SaveMeta, data: string): boolean {
  try {
    localStorage.setItem(PFX + 'save:' + meta.slot, data);
    const all = get<SaveMeta[]>('saves', []).filter((m) => m.slot !== meta.slot);
    all.unshift(meta);
    return set('saves', all.slice(0, 12));
  } catch { return false; }
}
export function readSave(slot: string): string | null { try { return localStorage.getItem(PFX + 'save:' + slot); } catch { return null; } }
export function deleteSave(slot: string) {
  try { localStorage.removeItem(PFX + 'save:' + slot); } catch { /* ignore */ }
  set('saves', get<SaveMeta[]>('saves', []).filter((m) => m.slot !== slot));
}
export const getHistory = () => get<SessionRecord[]>('history', []);
export function addHistory(r: SessionRecord) { const h = getHistory(); h.unshift(r); set('history', h.slice(0, 40)); }
export const getCareer = () => get<{ unlocked: number; best: Record<number, number> }>('career', { unlocked: 1, best: {} });
export function setCareer(level: number, score: number, passed: boolean) {
  const c = getCareer();
  c.best[level] = Math.max(c.best[level] ?? 0, score);
  if (passed) c.unlocked = Math.max(c.unlocked, level + 1);
  set('career', c);
}
export const getPrefs = <T,>(d: T) => get<T>('prefs', d);
export const setPrefs = (p: unknown) => set('prefs', p);
