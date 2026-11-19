/** Math / geometry helpers shared by the engine and renderers. */

export const KT = 0.514444; // m/s per knot
export const NM = 1852; // m
export const FT = 0.3048;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** normalise heading to [0,360) */
export const norm360 = (h: number) => ((h % 360) + 360) % 360;
/** signed smallest difference b - a in (-180,180] */
export const angDiff = (a: number, b: number) => {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
};
/** heading (deg true) of the vector dx,dy (x east, y north) */
export const hdgOf = (dx: number, dy: number) => norm360(Math.atan2(dx, dy) / DEG);
/** unit vector for a heading */
export const vecOf = (hdg: number): [number, number] => [Math.sin(hdg * DEG), Math.cos(hdg * DEG)];
export const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

/** move value toward target by at most step */
export const approach = (v: number, target: number, step: number) =>
  v < target ? Math.min(target, v + step) : Math.max(target, v - step);

/**
 * Along-track and cross-track of point p relative to a ray from (ox,oy) with heading hdg.
 * cross > 0 means the point is to the right of the ray.
 */
export function alongCross(px: number, py: number, ox: number, oy: number, hdg: number): [number, number] {
  const [ux, uy] = vecOf(hdg);
  const dx = px - ox;
  const dy = py - oy;
  return [dx * ux + dy * uy, dx * uy - dy * ux];
}

/** closest point on segment ab to p: returns [t(0..1), distance] */
export function projSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  return [t, Math.hypot(px - (ax + dx * t), py - (ay + dy * t))];
}

/** segment intersection, returns [t,u] parameters or null */
export function segIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): [number, number] | null {
  const rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sY - (cy - ay) * sX) / den;
  const u = ((cx - ax) * rY - (cy - ay) * rX) / den;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return [clamp(t, 0, 1), clamp(u, 0, 1)];
}

// ───────── seeded RNG (mulberry32) operating on an explicit state holder ─────────

export interface RngHolder {
  rng: number;
}
export function rand(s: RngHolder): number {
  s.rng = (s.rng + 0x6d2b79f5) | 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export const randRange = (s: RngHolder, a: number, b: number) => a + rand(s) * (b - a);
export const randInt = (s: RngHolder, a: number, b: number) => Math.floor(randRange(s, a, b + 1));
export const pick = <T>(s: RngHolder, arr: readonly T[]): T => arr[Math.floor(rand(s) * arr.length)];
export function pickWeighted<T>(s: RngHolder, arr: readonly T[], w: (t: T) => number): T {
  let total = 0;
  for (const a of arr) total += w(a);
  let r = rand(s) * total;
  for (const a of arr) {
    r -= w(a);
    if (r <= 0) return a;
  }
  return arr[arr.length - 1];
}

/** format sim clock seconds as HH:MM (wraps at 24h) */
export function fmtClock(sec: number, withSec = false): string {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const base = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return withSec ? `${base}:${String(s % 60).padStart(2, '0')}` : base;
}
export const fmtDur = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
