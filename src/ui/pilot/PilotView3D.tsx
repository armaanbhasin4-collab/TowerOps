/**
 * Out-the-window 3D view for the pilot-side simulator.
 *
 * Pure renderer: every animation frame it reads the plain-data `PilotState` through `getState()`
 * and draws it. Nothing is simulated or copied here.
 *
 * World → three.js mapping (same as the tower view): X = east (x), Y = up, Z = −north (−y);
 * heading h points along (sin h, 0, −cos h). The aircraft body frame has its nose toward −Z, so
 * the cockpit camera shares the aircraft quaternion (Euler order YXZ = yaw, then pitch, then roll).
 *
 * FLOATING ORIGIN: the three.js camera always sits at (0,0,0). Every object is positioned at
 * (its world position − the camera's world position), computed in JS doubles each frame, so the
 * view stays jitter-free thousands of kilometres from the world origin.
 *
 * Draw order instead of depth for everything flat: the ground, pavement and paint are drawn as
 * painter's layers (depth test off) before any solid object, so markings can never z-fight.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import * as THREE from 'three';
import type { Airport, GEdge } from '../../sim/types';
import type { AcKind, PilotState, PlacedAirport, RunwayRef } from '../../pilot/types';
import { ACDEF } from '../../pilot/aircraft';

export type PilotCam = 'cockpit' | 'chase' | 'flyby';

const DEG = Math.PI / 180;
const FT = 0.3048;
const NM = 1852;
const FAR = 400000;
const GROUND_HALF = 300000;
const AIRPORT_RANGE = 80000;
const TOWER_H = 85;
const CLOUD_THICK = 300;
const GS_TAN = Math.tan(3 * DEG);
/** ground texture tile sizes, metres */
const T1 = 3072;
const T2 = 22400;
const TD = 41;
const TM = 2100000;
const TK = 3300000;
const T3 = 31700;
const ROT_C = Math.cos(0.59);
const ROT_S = Math.sin(0.59);
const MAX_TAXI_SEG = 1024;

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const sm = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const frac = (v: number) => v - Math.floor(v);
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

// ───────────────────────────── small helpers ─────────────────────────────

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d') as CanvasRenderingContext2D];
}

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s & 0xfffff) / 0xfffff;
  };
}

/** Flat (y = 0) triangle soup with per-vertex colours, in airport-local coordinates. */
class FlatBuf {
  pos: number[] = [];
  col: number[] = [];
  private v(x: number, y: number, c: THREE.Color) {
    this.pos.push(x, 0, -y);
    this.col.push(c.r, c.g, c.b);
  }
  quad(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, c: THREE.Color) {
    this.v(ax, ay, c);
    this.v(bx, by, c);
    this.v(cx, cy, c);
    this.v(ax, ay, c);
    this.v(cx, cy, c);
    this.v(dx, dy, c);
  }
  /** strip from a to b of width w, optionally extended at both ends */
  strip(ax: number, ay: number, bx: number, by: number, w: number, c: THREE.Color, ext = 0) {
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    dx /= len;
    dy /= len;
    ax -= dx * ext;
    ay -= dy * ext;
    bx += dx * ext;
    by += dy * ext;
    const nx = (-dy * w) / 2;
    const ny = (dx * w) / 2;
    this.quad(ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny, c);
  }
  poly(poly: [number, number][], c: THREE.Color) {
    if (poly.length < 3) return;
    const contour = poly.map(([x, y]) => new THREE.Vector2(x, y));
    for (const tri of THREE.ShapeUtils.triangulateShape(contour, [])) for (const i of tri) this.v(poly[i][0], poly[i][1], c);
  }
  geometry(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

interface Part {
  geo: THREE.BufferGeometry;
  color: THREE.Color;
  /** colour for faces pointing up (roofs) */
  roof?: THREE.Color;
}

/** Merge primitive geometries into one non-indexed geometry with per-vertex colours. Disposes the inputs. */
function mergeColored(parts: Part[]): THREE.BufferGeometry {
  let n = 0;
  const flat: THREE.BufferGeometry[] = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (g !== p.geo) p.geo.dispose();
    flat.push(g);
    n += g.getAttribute('position').count;
  }
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (let i = 0; i < flat.length; i++) {
    const g = flat[i];
    const gp = g.getAttribute('position');
    const gn = g.getAttribute('normal');
    for (let v = 0; v < gp.count; v++, o += 3) {
      pos[o] = gp.getX(v);
      pos[o + 1] = gp.getY(v);
      pos[o + 2] = gp.getZ(v);
      const ny = gn.getY(v);
      nor[o] = gn.getX(v);
      nor[o + 1] = ny;
      nor[o + 2] = gn.getZ(v);
      const c = parts[i].roof && ny > 0.7 ? (parts[i].roof as THREE.Color) : parts[i].color;
      col[o] = c.r;
      col[o + 1] = c.g;
      col[o + 2] = c.b;
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** Symmetric lifting surface (both sides), planform in the XZ plane, top surface at y. */
function sweptSurface(span: number, zRoot: number, cRoot: number, sweep: number, cTip: number, thick: number, y: number): THREE.BufferGeometry {
  const h = span / 2;
  const s = new THREE.Shape([
    new THREE.Vector2(0, zRoot),
    new THREE.Vector2(h, zRoot + sweep),
    new THREE.Vector2(h, zRoot + sweep + cTip),
    new THREE.Vector2(0, zRoot + cRoot),
    new THREE.Vector2(-h, zRoot + sweep + cTip),
    new THREE.Vector2(-h, zRoot + sweep),
  ]);
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** fin in the (z, y) plane, extruded along x */
function finGeo(z0: number, z1: number, z2: number, z3: number, y0: number, y1: number, t: number): THREE.BufferGeometry {
  const fin = new THREE.Shape([new THREE.Vector2(z0, y0), new THREE.Vector2(z1, y0), new THREE.Vector2(z2, y1), new THREE.Vector2(z3, y1)]);
  return new THREE.ExtrudeGeometry(fin, { depth: t, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(t / 2, 0, 0);
}

function convexHull(pts: [number, number][]): [number, number][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop();
  up.pop();
  return lo.concat(up);
}

// ───────────────────────────── procedural textures ─────────────────────────────

/** Tiling land-cover texture (fields / forest / towns / roads / water) plus a matching night-lights mask. */
function makeLandTextures(): [HTMLCanvasElement, HTMLCanvasElement] {
  const S = 1024;
  const [land, g] = makeCanvas(S, S);
  const [city, cg] = makeCanvas(S / 2, S / 2);
  const rnd = seeded(20240607);
  cg.fillStyle = '#000';
  cg.fillRect(0, 0, S / 2, S / 2);
  // fields
  const fieldCols = ['#5c7a3c', '#6c8845', '#84964f', '#9c955a', '#4f6d36', '#778c48', '#a89f66', '#62803f', '#8f8a52', '#587539'];
  g.fillStyle = '#5c7a3c';
  g.fillRect(0, 0, S, S);
  const cell = S / 8;
  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      const n = 1 + Math.floor(rnd() * 4);
      const horiz = rnd() > 0.5;
      for (let i = 0; i < n; i++) {
        g.fillStyle = fieldCols[Math.floor(rnd() * fieldCols.length)];
        const a = (cell * i) / n;
        const w = cell / n;
        if (horiz) g.fillRect(cx * cell, cy * cell + a, cell, w + 0.5);
        else g.fillRect(cx * cell + a, cy * cell, w + 0.5, cell);
        // plough lines
        g.strokeStyle = 'rgba(30,45,20,0.10)';
        g.lineWidth = 1;
        g.beginPath();
        for (let k = 2; k < w; k += 4) {
          if (horiz) {
            g.moveTo(cx * cell, cy * cell + a + k);
            g.lineTo(cx * cell + cell, cy * cell + a + k);
          } else {
            g.moveTo(cx * cell + a + k, cy * cell);
            g.lineTo(cx * cell + a + k, cy * cell + cell);
          }
        }
        g.stroke();
        g.strokeStyle = 'rgba(38,58,28,0.5)';
        if (horiz) g.strokeRect(cx * cell + 0.5, cy * cell + a + 0.5, cell, w);
        else g.strokeRect(cx * cell + a + 0.5, cy * cell + 0.5, w, cell);
      }
    }
  }
  // wrapped features: build lists first, then draw at 9 offsets so the tile is seamless
  type Blob = { x: number; y: number; r: number; c: string };
  type Rect = { x: number; y: number; w: number; h: number };
  const forest: Blob[] = [];
  const forestCols = ['#2f4a26', '#35522a', '#2a4322', '#3b5a2e'];
  for (let i = 0; i < 26; i++) {
    const fx = rnd() * S;
    const fy = rnd() * S;
    const m = 6 + Math.floor(rnd() * 16);
    const sp = 30 + rnd() * 80;
    for (let k = 0; k < m; k++) forest.push({ x: fx + (rnd() - 0.5) * sp * (1 + rnd()), y: fy + (rnd() - 0.5) * sp, r: 4 + rnd() * 13, c: forestCols[Math.floor(rnd() * 4)] });
  }
  const lake: Blob[] = [];
  {
    const lx = rnd() * S;
    const ly = rnd() * S;
    for (let k = 0; k < 7; k++) lake.push({ x: lx + (rnd() - 0.5) * 70, y: ly + (rnd() - 0.5) * 40, r: 10 + rnd() * 22, c: '#3d5870' });
  }
  const towns: Rect[] = [];
  for (let i = 0; i < 4; i++) {
    const tx = rnd() * S;
    const ty = rnd() * S;
    const m = 3 + Math.floor(rnd() * 5);
    for (let k = 0; k < m; k++) {
      const w = 32 + Math.floor(rnd() * 9) * 8;
      const h = 32 + Math.floor(rnd() * 9) * 8;
      towns.push({ x: Math.round((tx + (rnd() - 0.5) * 130) / 8) * 8, y: Math.round((ty + (rnd() - 0.5) * 130) / 8) * 8, w, h });
    }
  }
  const houses: { x: number; y: number; w: number; h: number; c: string }[] = [];
  const lights: { x: number; y: number; c: string }[] = [];
  const houseCols = ['#9a958c', '#8b8780', '#a59f95', '#7d7a75', '#b0aaa0', '#8f7f72'];
  for (const t of towns) {
    for (let y = t.y + 1; y < t.y + t.h - 3; y += 4) {
      for (let x = t.x + 1; x < t.x + t.w - 3; x += 4) {
        if ((x - t.x) % 16 > 12 || (y - t.y) % 16 > 12) continue; // streets
        if (rnd() < 0.72) houses.push({ x, y, w: 2 + rnd() * 1.5, h: 2 + rnd() * 1.5, c: houseCols[Math.floor(rnd() * houseCols.length)] });
        if (rnd() < 0.3) lights.push({ x: x + rnd() * 3, y: y + rnd() * 3, c: rnd() < 0.7 ? '#ffc980' : '#fff3d8' });
      }
    }
  }
  for (let oy = -S; oy <= S; oy += S) {
    for (let ox = -S; ox <= S; ox += S) {
      g.save();
      g.translate(ox, oy);
      for (const b of forest) {
        g.fillStyle = b.c;
        g.beginPath();
        g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        g.fill();
      }
      for (const b of lake) {
        g.fillStyle = b.c;
        g.beginPath();
        g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        g.fill();
      }
      for (const t of towns) {
        g.fillStyle = '#77756f';
        g.fillRect(t.x, t.y, t.w, t.h);
      }
      for (const h of houses) {
        g.fillStyle = h.c;
        g.fillRect(h.x, h.y, h.w, h.h);
      }
      g.restore();
      cg.save();
      cg.translate(ox / 2, oy / 2);
      for (const l of lights) {
        cg.fillStyle = l.c;
        cg.fillRect(l.x / 2, l.y / 2, 1, 1);
      }
      cg.restore();
    }
  }
  // roads (periodic so they tile)
  const roads = [
    { horiz: true, o: S * 0.31, a: 26, k: 1, ph: 0.7 },
    { horiz: false, o: S * 0.64, a: 34, k: 1, ph: 2.1 },
    { horiz: true, o: S * 0.78, a: 12, k: 2, ph: 4.0 },
  ];
  for (const r of roads) {
    g.strokeStyle = '#8a8a84';
    g.lineWidth = r.k === 1 ? 2.6 : 1.6;
    g.beginPath();
    for (let t = -4; t <= S + 4; t += 4) {
      const off = r.o + r.a * Math.sin((t / S) * Math.PI * 2 * r.k + r.ph);
      if (r.horiz) g.lineTo(t, off);
      else g.lineTo(off, t);
      if (t % 24 === 0) {
        cg.fillStyle = '#ffb060';
        if (r.horiz) cg.fillRect(t / 2, off / 2, 1, 1);
        else cg.fillRect(off / 2, t / 2, 1, 1);
      }
    }
    g.stroke();
  }
  // gentle mottling
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,220,0.035)' : 'rgba(0,20,0,0.05)';
    g.fillRect(rnd() * S, rnd() * S, 2 + rnd() * 9, 2 + rnd() * 9);
  }
  return [land, city];
}

function makeNoiseCanvas(): HTMLCanvasElement {
  const S = 256;
  const [c, g] = makeCanvas(S, S);
  const img = g.createImageData(S, S);
  const rnd = seeded(991);
  for (let i = 0; i < S * S; i++) {
    const v = 96 + Math.floor(rnd() * 128);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function makeCloudCanvas(): HTMLCanvasElement {
  const S = 512;
  const [c, g] = makeCanvas(S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const rnd = seeded(4711);
  for (let i = 0; i < 300; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 18 + rnd() * 80;
    const a = 0.1 + rnd() * 0.22;
    for (let oy = -S; oy <= S; oy += S) {
      for (let ox = -S; ox <= S; ox += S) {
        if (x + ox + r < 0 || x + ox - r > S || y + oy + r < 0 || y + oy - r > S) continue;
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        gr.addColorStop(0, `rgba(255,255,255,${a})`);
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  return c;
}

/** A plane in XZ whose grid is much denser near the centre (keeps interpolation precise near the camera). */
function warpedPlane(half: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(2, 2, seg, seg);
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  const f = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 3) * half;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, f(p.getX(i)), 0, f(p.getZ(i)));
  g.computeBoundingSphere();
  return g;
}

// ───────────────────────────── shaders ─────────────────────────────

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SKY_FS = /* glsl */ `
uniform vec3 uZen; uniform vec3 uHor; uniform vec3 uSunCol; uniform vec3 uSunDir; uniform vec3 uMoonDir;
uniform vec3 uWhiteCol; uniform float uSun; uniform float uMoon; uniform float uWhite; uniform float uDusk; uniform vec3 uDuskCol;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  vec3 c = mix(uHor, uZen, smoothstep(0.0, 1.0, pow(h, 0.55)));
  float sd = max(dot(d, uSunDir), 0.0);
  vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
  float toward = max(dot(normalize(d.xz + vec2(1e-5)), sh), 0.0);
  c = mix(c, uDuskCol, uDusk * pow(1.0 - h, 7.0) * (0.25 + 0.75 * toward * toward));
  c += uSunCol * uSun * (pow(sd, 6.0) * 0.12 + pow(sd, 60.0) * 0.25 + smoothstep(0.99975, 0.99990, sd) * 3.0);
  float md = max(dot(d, uMoonDir), 0.0);
  c += vec3(0.75, 0.8, 0.9) * uMoon * (smoothstep(0.99985, 0.99992, md) + pow(md, 300.0) * 0.08);
  if (d.y < 0.0) c = mix(c, uHor, smoothstep(0.0, -0.02, d.y));
  c = mix(c, uWhiteCol, uWhite);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const GROUND_VS = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const GROUND_FS = /* glsl */ `
uniform sampler2D uLand; uniform sampler2D uCity; uniform sampler2D uDetail;
uniform vec4 uOff; uniform vec4 uOffD; uniform vec4 uOffM; uniform vec3 uTint; uniform vec3 uFogCol; uniform float uFogD; uniform float uNight;
varying vec3 vW;
void main() {
  float d = length(vW);
  vec2 p = vec2(vW.x, -vW.z);
  vec2 uv1 = p / ${T1.toFixed(1)} + uOff.xy;
  vec2 pr = vec2(${ROT_C.toFixed(6)} * p.x + ${ROT_S.toFixed(6)} * p.y, ${(-ROT_S).toFixed(6)} * p.x + ${ROT_C.toFixed(6)} * p.y);
  vec2 uv2 = pr / ${T2.toFixed(1)} + uOff.zw;
  vec3 c1 = texture2D(uLand, uv1).rgb;
  vec2 uv3 = vec2(p.y, -p.x) / ${T3.toFixed(1)} + uOffM.zw;
  float mask = texture2D(uDetail, pr / ${TK.toFixed(1)} + uOffM.xy).r;
  vec3 c2 = mix(texture2D(uLand, uv2).rgb, texture2D(uLand, uv3).rgb, smoothstep(0.52, 0.72, mask));
  float m = smoothstep(4000.0, 26000.0, d);
  vec3 c = mix(c1, c2, m * 0.88);
  float macro = texture2D(uDetail, p / ${TM.toFixed(1)} + uOffD.zw).r;
  c *= 0.66 + 0.55 * macro;
  float det = texture2D(uDetail, p / ${TD.toFixed(1)} + uOffD.xy).r;
  c *= mix(0.84 + 0.32 * det, 1.0, smoothstep(150.0, 2500.0, d));
  vec3 lit = c * uTint + texture2D(uCity, uv1).rgb * uNight * (1.0 - m);
  float f = d * uFogD;
  gl_FragColor = vec4(mix(uFogCol, lit, exp(-f * f)), 1.0);
  #include <colorspace_fragment>
}`;

const CLOUD_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;
const CLOUD_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uTex; uniform vec4 uOff; uniform vec3 uCol; uniform vec3 uFogCol; uniform float uFogD; uniform float uAlpha;
varying vec3 vW;
void main() {
  #include <logdepthbuf_fragment>
  float d = length(vW);
  vec2 p = vec2(vW.x, -vW.z);
  float n = texture2D(uTex, p / 7300.0 + uOff.xy).r * 0.62 + texture2D(uTex, p / 1900.0 + uOff.zw).r * 0.38;
  vec3 c = uCol * (0.72 + 0.5 * n);
  float a = uAlpha * (0.86 + 0.14 * smoothstep(0.15, 0.6, n));
  float f = d * uFogD;
  gl_FragColor = vec4(mix(uFogCol, c, exp(-f * f)), a);
  #include <colorspace_fragment>
}`;

/** Point lights: screen-size clamped, directional (optional), fogged at reduced density. Camera must be at the origin. */
const LIGHT_VS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 lcol; attribute vec3 ldir; attribute vec2 lsize;
uniform float uScale; uniform float uMinPx; uniform float uMaxPx; uniform float uFogD; uniform float uGain;
varying vec4 vCol;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * w;
  float d = max(length(mv.xyz), 0.5);
  float a = uGain;
  if (dot(ldir, ldir) > 0.01) {
    vec3 wd = normalize(mat3(modelMatrix) * ldir);
    a *= smoothstep(-0.03, 0.18, dot(wd, normalize(-w.xyz)));
  }
  float rr = clamp(lsize.y / d, 0.0, 1.0);
  a *= rr * rr;
  float f = d * uFogD * 0.6;
  a *= exp(-f * f);
  if (lsize.x <= 0.0) a = 0.0;
  vCol = vec4(lcol, a);
  gl_PointSize = clamp(lsize.x * uScale / d, uMinPx, uMaxPx);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  if (a < 0.012) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const LIGHT_FS = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uRim;
varying vec4 vCol;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float edge = mix(0.3, 0.55, uRim);
  float core = smoothstep(1.0, edge, r);
  vec3 c = mix(vCol.rgb, vec3(1.0), smoothstep(0.45, 0.0, r) * 0.45);
  float rim = uRim * smoothstep(0.55, 0.8, r);
  c = mix(c, vec3(0.02), rim);
  float a = mix(core, 1.0 - smoothstep(0.9, 1.0, r), uRim) * vCol.a;
  gl_FragColor = vec4(c, a);
  #include <colorspace_fragment>
}`;

// ───────────────────────────── aircraft models ─────────────────────────────

interface ModelInfo {
  body: THREE.BufferGeometry;
  gear: THREE.BufferGeometry | null;
  /** y of the gear pivot (retraction squashes the gear toward it) */
  gearTop: number;
  /** light positions: navL, navR, tail, beaconTop, beaconBottom, strobeL, strobeR, landL, landR, taxi */
  lights: number[];
  prop: { x: number; y: number; z: number; r: number } | null;
  height: number;
}

/** Low-poly twin jet, nose toward −Z, wheels on y = 0, origin on the ground under the main gear. */
function buildJet(L: number, S: number): ModelInfo {
  const r = clamp(L * 0.052, 1.1, 3.4);
  const cy = r * 1.75;
  const cFus = new THREE.Color(0xe9edf1);
  const cTail = new THREE.Color(0x1d4f8f);
  const cAcc = new THREE.Color(0x1d4f8f);
  const cWing = new THREE.Color(0xb4bbc4);
  const cDark = new THREE.Color(0x191d23);
  const cEng = new THREE.Color(0x8d96a1);
  const parts: Part[] = [];
  parts.push({ geo: new THREE.CapsuleGeometry(r, Math.max(1, L - 2 * r), 6, 14).rotateX(Math.PI / 2).translate(0, cy, 0), color: cFus });
  parts.push({ geo: new THREE.CylinderGeometry(r * 0.25, r * 0.97, L * 0.16, 12).rotateX(Math.PI / 2).translate(0, cy + r * 0.35, L / 2 - L * 0.05), color: cFus });
  parts.push({ geo: new THREE.BoxGeometry(r * 2.03, r * 0.14, L * 0.7).translate(0, cy - r * 0.05, -L * 0.02), color: cAcc });
  parts.push({ geo: new THREE.BoxGeometry(r * 1.3, r * 0.3, r * 0.6).translate(0, cy + r * 0.42, -L / 2 + r * 0.85), color: cDark });
  const zr0 = -L * 0.12;
  const sweep = S * 0.26;
  const wingY = cy - r * 0.45;
  parts.push({ geo: sweptSurface(S, zr0, L * 0.2, sweep, L * 0.055, Math.max(0.3, r * 0.2), wingY), color: cWing });
  parts.push({ geo: sweptSurface(S * 0.38, L / 2 - L * 0.17, L * 0.1, S * 0.11, L * 0.04, Math.max(0.2, r * 0.12), cy + r * 0.3), color: cWing });
  const fy0 = cy + r * 0.55;
  const fy1 = cy + r + L * 0.15;
  parts.push({ geo: finGeo(L / 2 - L * 0.21, L / 2 - L * 0.02, L / 2 + L * 0.005, L / 2 - L * 0.065, fy0, fy1, Math.max(0.3, r * 0.2)), color: cTail });
  const re = r * 0.58;
  const le = Math.max(2.6, L * 0.11);
  for (const side of [-1, 1]) {
    const ex = side * 0.32 * (S / 2);
    const ez = zr0 + sweep * 0.32 - le * 0.2;
    parts.push({ geo: new THREE.CylinderGeometry(re, re * 0.78, le, 12).rotateX(-Math.PI / 2).translate(ex, wingY - re * 0.95, ez), color: cEng });
    parts.push({ geo: new THREE.CylinderGeometry(re * 0.8, re * 0.8, 0.2, 12).rotateX(-Math.PI / 2).translate(ex, wingY - re * 0.95, ez - le / 2 - 0.02), color: cDark });
    // pylon
    parts.push({ geo: new THREE.BoxGeometry(0.25, re * 0.6, le * 0.7).translate(ex, wingY - re * 0.2, ez + le * 0.2), color: cWing });
  }
  const zs = -L * 0.04; // shift so the main gear is at z = 0
  const body = mergeColored(parts);
  body.translate(0, 0, zs);
  // landing gear (separate so it can retract)
  const gp: Part[] = [];
  const gw = Math.max(0.3, r * 0.2);
  const noseZ = -L / 2 + L * 0.13;
  gp.push({ geo: new THREE.BoxGeometry(gw, wingY - 0.3, gw).translate(0, (wingY + 0.3) / 2, noseZ), color: cDark });
  for (const s of [-1, 1]) gp.push({ geo: new THREE.CylinderGeometry(0.42, 0.42, 0.25, 12).rotateZ(Math.PI / 2).translate(s * 0.25, 0.42, noseZ), color: cDark });
  const mx = Math.max(r * 1.3, S * 0.08);
  for (const side of [-1, 1]) {
    gp.push({ geo: new THREE.BoxGeometry(gw * 1.2, wingY - 0.4, gw * 1.2).translate(side * mx, (wingY + 0.4) / 2, L * 0.04), color: cDark });
    for (const s of [-1, 1]) gp.push({ geo: new THREE.CylinderGeometry(0.56, 0.56, 0.38, 14).rotateZ(Math.PI / 2).translate(side * mx + s * 0.38, 0.56, L * 0.04), color: cDark });
  }
  const gear = mergeColored(gp);
  gear.translate(0, 0, zs);
  const tipZ = zr0 + sweep + L * 0.03 + zs;
  const lights = [
    -S / 2 - 0.3, wingY - 0.1, tipZ, S / 2 + 0.3, wingY - 0.1, tipZ, 0, cy + r * 0.4, L / 2 + L * 0.04 + zs, 0, cy + r + 0.4, zs, 0, cy - r - 0.4, zs,
    -S / 2 - 0.3, wingY - 0.1, tipZ + 0.6, S / 2 + 0.3, wingY - 0.1, tipZ + 0.6,
    -r * 1.25, wingY - 0.2, zr0 + zs - 0.3, r * 1.25, wingY - 0.2, zr0 + zs - 0.3, 0, 1.6, noseZ + zs - 0.3,
  ];
  return { body, gear, gearTop: wingY, lights, prop: null, height: fy1 };
}

/** Low-poly high-wing piston single (fixed tricycle gear), nose toward −Z, origin under the main gear. */
function buildC172(L: number, S: number): ModelInfo {
  const k = L / 8.3;
  const cFus = new THREE.Color(0xeceff2);
  const cStripe = new THREE.Color(0xb3261e);
  const cWing = new THREE.Color(0xdfe3e8);
  const cDark = new THREE.Color(0x1b2027);
  const cGlass = new THREE.Color(0x27394a);
  const parts: Part[] = [];
  const noseZ = -2.35 * k;
  const cy = 1.25 * k;
  // cowling + cabin
  parts.push({ geo: new THREE.CylinderGeometry(0.5 * k, 0.6 * k, 1.5 * k, 10).rotateX(-Math.PI / 2).translate(0, cy, noseZ + 0.85 * k), color: cFus });
  parts.push({ geo: new THREE.BoxGeometry(1.15 * k, 1.2 * k, 2.3 * k).translate(0, cy + 0.05 * k, 0.1 * k), color: cFus });
  parts.push({ geo: new THREE.BoxGeometry(1.17 * k, 0.5 * k, 1.9 * k).translate(0, cy + 0.6 * k, 0.05 * k), color: cGlass });
  parts.push({ geo: new THREE.BoxGeometry(1.18 * k, 0.12 * k, 3.4 * k).translate(0, cy - 0.1 * k, 0.5 * k), color: cStripe });
  // tail cone
  const tl = L + noseZ - 1.25 * k;
  parts.push({ geo: new THREE.CylinderGeometry(0.14 * k, 0.6 * k, tl, 8).rotateX(Math.PI / 2).translate(0, cy + 0.22 * k, 1.25 * k + tl / 2), color: cFus });
  // wing, struts
  const wingY = cy + 1.02 * k;
  parts.push({ geo: sweptSurface(S, -0.75 * k, 1.6 * k, 0.05 * k, 1.15 * k, 0.16 * k, wingY), color: cWing });
  for (const side of [-1, 1]) {
    const x0 = side * 0.58 * k;
    const y0 = cy - 0.5 * k;
    const x1 = side * S * 0.24;
    const y1 = wingY - 0.16 * k;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const g = new THREE.BoxGeometry(len, 0.05 * k, 0.14 * k).rotateZ(Math.atan2(y1 - y0, x1 - x0)).translate((x0 + x1) / 2, (y0 + y1) / 2, 0.05 * k);
    parts.push({ geo: g, color: cWing });
  }
  // tail surfaces
  const tz = noseZ + L;
  parts.push({ geo: sweptSurface(S * 0.31, tz - 1.15 * k, 1.0 * k, 0.15 * k, 0.7 * k, 0.08 * k, cy + 0.32 * k), color: cWing });
  parts.push({ geo: finGeo(tz - 1.7 * k, tz - 0.1 * k, tz, tz - 0.75 * k, cy + 0.3 * k, cy + 1.55 * k, 0.08 * k), color: cStripe });
  // spinner
  parts.push({ geo: new THREE.ConeGeometry(0.17 * k, 0.4 * k, 10).rotateX(-Math.PI / 2).translate(0, cy, noseZ - 0.12 * k), color: cDark });
  // fixed gear
  const mw = 1.25 * k;
  for (const side of [-1, 1]) {
    const x0 = side * 0.5 * k;
    const y0 = cy - 0.55 * k;
    const x1 = side * mw;
    const y1 = 0.24 * k;
    const len = Math.hypot(x1 - x0, y1 - y0);
    parts.push({ geo: new THREE.BoxGeometry(len, 0.06 * k, 0.22 * k).rotateZ(Math.atan2(y1 - y0, x1 - x0)).translate((x0 + x1) / 2, (y0 + y1) / 2, 0), color: cFus });
    parts.push({ geo: new THREE.CylinderGeometry(0.22 * k, 0.22 * k, 0.16 * k, 12).rotateZ(Math.PI / 2).translate(side * mw, 0.22 * k, 0), color: cDark });
  }
  const nwz = -1.65 * k;
  parts.push({ geo: new THREE.BoxGeometry(0.07 * k, cy - 0.7 * k, 0.07 * k).translate(0, (cy - 0.3 * k) / 2 + 0.1 * k, nwz), color: cWing });
  parts.push({ geo: new THREE.CylinderGeometry(0.19 * k, 0.19 * k, 0.14 * k, 12).rotateZ(Math.PI / 2).translate(0, 0.19 * k, nwz), color: cDark });
  const body = mergeColored(parts);
  const lights = [
    -S / 2 - 0.12, wingY - 0.08 * k, -0.2 * k, S / 2 + 0.12, wingY - 0.08 * k, -0.2 * k, 0, cy + 0.5 * k, tz + 0.15, 0, cy + 1.72 * k, tz - 0.5 * k, 0, cy + 1.72 * k, tz - 0.5 * k,
    -S / 2 - 0.12, wingY - 0.08 * k, 0.1, S / 2 + 0.12, wingY - 0.08 * k, 0.1,
    -S * 0.3, wingY - 0.08 * k, -0.9 * k, -S * 0.3 + 0.25, wingY - 0.08 * k, -0.9 * k, 0, cy - 0.3 * k, noseZ - 0.1,
  ];
  return { body, gear: null, gearTop: 0, lights, prop: { x: 0, y: cy, z: noseZ - 0.08 * k, r: 0.95 * k }, height: cy + 1.55 * k };
}

// ───────────────────────────── engine ─────────────────────────────

interface Engine {
  dispose(): void;
}

interface ApVis {
  ap: Airport;
  group: THREE.Group;
  geos: THREE.BufferGeometry[];
}

function createEngine(container: HTMLDivElement, getState: () => PilotState, getCam: () => PilotCam, getYoke: () => boolean): Engine {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none';
  // throws when WebGL is unavailable – the caller shows a fallback
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  container.appendChild(canvas);
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(0x9ec3e6, 0.00004);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.3, FAR);
  camera.rotation.order = 'YXZ';
  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x4a4a3a, 1.2);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  scene.add(hemi, sun, sun.target);

  // ── sky ──
  const skyU = {
    uZen: { value: new THREE.Color() },
    uHor: { value: new THREE.Color() },
    uSunCol: { value: new THREE.Color(1, 0.95, 0.85) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uWhiteCol: { value: new THREE.Color() },
    uDuskCol: { value: new THREE.Color() },
    uSun: { value: 1 },
    uMoon: { value: 0 },
    uWhite: { value: 0 },
    uDusk: { value: 0 },
  };
  const sky = new THREE.Mesh(
    own(new THREE.SphereGeometry(1000, 32, 20)),
    own(new THREE.ShaderMaterial({ uniforms: skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false })),
  );
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  scene.add(sky);

  const starMat = own(new THREE.PointsMaterial({ size: 1.6 * dpr, sizeAttenuation: false, vertexColors: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false }));
  {
    const N = 1400;
    const p = new Float32Array(N * 3);
    const c = new Float32Array(N * 3);
    const rnd = seeded(31337);
    for (let i = 0; i < N; i++) {
      const y = rnd() * 1.05 - 0.05;
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      p[i * 3] = Math.cos(a) * rr * 900;
      p[i * 3 + 1] = y * 900;
      p[i * 3 + 2] = Math.sin(a) * rr * 900;
      const b = 0.25 + Math.pow(rnd(), 3) * 0.75;
      const t = rnd();
      c[i * 3] = b * (0.85 + 0.15 * t);
      c[i * 3 + 1] = b * 0.9;
      c[i * 3 + 2] = b * (1 - 0.15 * t);
    }
    const g = own(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const stars = new THREE.Points(g, starMat);
    stars.renderOrder = -99;
    stars.frustumCulled = false;
    scene.add(stars);
  }
  const starsObj = scene.children[scene.children.length - 1];

  // ── ground ──
  const [landC, cityC] = makeLandTextures();
  const mkTex = (c: HTMLCanvasElement, srgb = true) => {
    const t = own(new THREE.CanvasTexture(c));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    return t;
  };
  const groundU = {
    uLand: { value: mkTex(landC) },
    uCity: { value: mkTex(cityC) },
    uDetail: { value: mkTex(makeNoiseCanvas(), false) },
    uOff: { value: new THREE.Vector4() },
    uOffD: { value: new THREE.Vector4() },
    uOffM: { value: new THREE.Vector4() },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uFogCol: { value: fog.color },
    uFogD: { value: 0.00004 },
    uNight: { value: 0 },
  };
  const planeGeo = own(warpedPlane(GROUND_HALF, 56));
  const ground = new THREE.Mesh(planeGeo, own(new THREE.ShaderMaterial({ uniforms: groundU, vertexShader: GROUND_VS, fragmentShader: GROUND_FS, side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false })));
  ground.renderOrder = -50;
  ground.frustumCulled = false;
  scene.add(ground);

  // ── clouds ──
  const cloudTex = mkTex(makeCloudCanvas(), false);
  const mkCloud = () => {
    const u = {
      uTex: { value: cloudTex },
      uOff: { value: new THREE.Vector4() },
      uCol: { value: new THREE.Color() },
      uFogCol: { value: fog.color },
      uFogD: { value: 0.00004 },
      uAlpha: { value: 0.9 },
    };
    const m = new THREE.Mesh(planeGeo, own(new THREE.ShaderMaterial({ uniforms: u, vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, side: THREE.DoubleSide, transparent: true, depthWrite: false, fog: false })));
    m.renderOrder = 30;
    m.frustumCulled = false;
    m.visible = false;
    scene.add(m);
    return { mesh: m, u };
  };
  const cloudBase = mkCloud();
  const cloudTop = mkCloud();

  // ── shared airport materials ──
  const flatOpts = { vertexColors: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false } as const;
  const paveMat = own(new THREE.MeshBasicMaterial(flatOpts));
  const paintMat = own(new THREE.MeshBasicMaterial(flatOpts));
  const bldMat = own(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x3a3626, emissiveIntensity: 0 }));
  const numMats = new Map<string, THREE.MeshBasicMaterial>();
  const numMatList: THREE.MeshBasicMaterial[] = [];
  const numMat = (name: string) => {
    let m = numMats.get(name);
    if (!m) {
      const [c, g] = makeCanvas(128, 192);
      const mm = /^(\d+)([LRC]?)$/.exec(name);
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = 'bold 100px Arial, Helvetica, sans-serif';
      if (mm && mm[2]) {
        g.fillText(mm[1], 64, 56, 122);
        g.font = 'bold 84px Arial, Helvetica, sans-serif';
        g.fillText(mm[2], 64, 146, 120);
      } else {
        g.fillText(mm ? mm[1] : name, 64, 100, 122);
      }
      const tex = own(new THREE.CanvasTexture(c));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;
      m = own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      numMats.set(name, m);
      numMatList.push(m);
    }
    return m;
  };
  const mkLightMat = (minPx: number, maxPx: number) => {
    const u = {
      uScale: { value: 900 },
      uMinPx: { value: minPx * dpr },
      uMaxPx: { value: maxPx * dpr },
      uFogD: { value: 0.00004 },
      uGain: { value: 1 },
      uRim: { value: 0 },
    };
    const m = own(new THREE.ShaderMaterial({ uniforms: u, vertexShader: LIGHT_VS, fragmentShader: LIGHT_FS, transparent: true, depthWrite: false, fog: false }));
    return { m, u };
  };
  const apLightMat = mkLightMat(2.1, 6);
  const papiMat = mkLightMat(3.4, 9);
  const acLightMat = mkLightMat(2.2, 7);

  // ── airports ──
  const cGrass = new THREE.Color(0x4f6b38);
  const cApron = new THREE.Color(0x7b7e80);
  const cGatePave = new THREE.Color(0x6f7275);
  const cTwy = new THREE.Color(0x5b5e62);
  const cAsphalt = new THREE.Color(0x34373c);
  const cShoulder = new THREE.Color(0x44474b);
  const cWhite = new THREE.Color(0xf2f3f4);
  const cYellow = new THREE.Color(0xe9bd16);
  const cWall = new THREE.Color(0x8d99a8);
  const cRoof = new THREE.Color(0xb9bfc6);
  const cTower = new THREE.Color(0xa7adb5);
  const cGlassB = new THREE.Color(0x2c4a60);
  const cCab = new THREE.Color(0x2d5563);

  const buildAirport = (ap: Airport): ApVis => {
    const group = new THREE.Group();
    const geos: THREE.BufferGeometry[] = [];
    const addFlat = (buf: FlatBuf, mat: THREE.Material, order: number) => {
      const g = buf.geometry();
      if (!g) return;
      geos.push(g);
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = order;
      m.matrixAutoUpdate = false;
      group.add(m);
    };
    const lp: number[] = [];
    const lc: number[] = [];
    const ld: number[] = [];
    const ls: number[] = [];
    const light = (x: number, y: number, h: number, col: number[], size: number, range: number, dx = 0, dy = 0) => {
      lp.push(x, h, -y);
      lc.push(col[0], col[1], col[2]);
      ld.push(dx, 0, -dy);
      ls.push(size, range);
    };
    const L_WHITE = [1, 0.95, 0.8];
    const L_GREEN = [0.1, 1, 0.3];
    const L_RED = [1, 0.08, 0.05];
    const L_BLUE = [0.15, 0.3, 1];
    const L_WARM = [1, 0.8, 0.5];

    // layer A: airfield grass, aprons, taxiway pavement
    const A = new FlatBuf();
    const B = new FlatBuf(); // yellow paint
    const C = new FlatBuf(); // runway pavement
    const D = new FlatBuf(); // white paint
    {
      const pts: [number, number][] = [];
      for (const n of ap.nodes) pts.push([n.x, n.y]);
      for (const r of ap.runways) for (const e of r.ends) pts.push([e.x - Math.sin(e.hdg * DEG) * 250, e.y - Math.cos(e.hdg * DEG) * 250]);
      for (const p of ap.aprons) for (const q of p) pts.push(q);
      const hull = convexHull(pts);
      if (hull.length >= 3) {
        let mx = 0;
        let my = 0;
        for (const h of hull) {
          mx += h[0];
          my += h[1];
        }
        mx /= hull.length;
        my /= hull.length;
        const big = hull.map(([x, y]): [number, number] => {
          const d = Math.hypot(x - mx, y - my) || 1;
          return [x + ((x - mx) / d) * 260, y + ((y - my) / d) * 260];
        });
        for (let i = 1; i < big.length - 1; i++) A.quad(big[0][0], big[0][1], big[i][0], big[i][1], big[i + 1][0], big[i + 1][1], big[i + 1][0], big[i + 1][1], cGrass);
      }
    }
    for (const poly of ap.aprons) A.poly(poly, cApron);
    const onRunway = (x: number, y: number, margin: number) => {
      for (const r of ap.runways) {
        const [e0, e1] = r.ends;
        const len = Math.hypot(e1.x - e0.x, e1.y - e0.y) || 1;
        const ux = (e1.x - e0.x) / len;
        const uy = (e1.y - e0.y) / len;
        const al = (x - e0.x) * ux + (y - e0.y) * uy;
        const lat = Math.abs((x - e0.x) * uy - (y - e0.y) * ux);
        if (al > -margin && al < len + margin && lat < r.width / 2 + margin) return true;
      }
      return false;
    };
    for (const e of ap.edges) {
      if (e.kind !== 'gate') continue;
      const a = ap.nodes[e.a];
      const b = ap.nodes[e.b];
      if (a && b) A.strip(a.x, a.y, b.x, b.y, 9, cGatePave, 3);
    }
    for (const e of ap.edges) {
      if (e.kind === 'runway') continue;
      const a = ap.nodes[e.a];
      const b = ap.nodes[e.b];
      if (!a || !b) continue;
      if (e.kind === 'gate') {
        B.strip(a.x, a.y, b.x, b.y, 0.35, cYellow);
        continue;
      }
      const w = e.kind === 'apron' ? 18 : 23;
      A.strip(a.x, a.y, b.x, b.y, w, e.kind === 'apron' ? cApron : cTwy, w * 0.45);
      B.strip(a.x, a.y, b.x, b.y, 0.5, cYellow, 0.25);
      if (e.kind === 'taxiway') {
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len < 1) continue;
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        const n = Math.max(1, Math.round(len / 55));
        for (let i = 0; i < n; i++) {
          const d = ((i + 0.5) * len) / n;
          for (const s of [-1, 1]) {
            const x = a.x + ux * d - uy * s * (w / 2 + 0.8);
            const y = a.y + uy * d + ux * s * (w / 2 + 0.8);
            if (!onRunway(x, y, 6)) light(x, y, 0.4, L_BLUE, 0.3, 2200);
          }
        }
      }
    }
    // hold-short bars
    const edgeById = new Map<number, GEdge>();
    for (const e of ap.edges) edgeById.set(e.id, e);
    for (const n of ap.nodes) {
      if (n.kind !== 'hold') continue;
      let best: { x: number; y: number } | null = null;
      for (const eid of ap.adj[n.id] ?? []) {
        const e = edgeById.get(eid);
        if (!e || e.kind === 'runway') continue;
        const o = ap.nodes[e.a === n.id ? e.b : e.a];
        if (!o) continue;
        if (!best || o.kind === 'rwy') best = o;
      }
      if (!best) continue;
      const len = Math.hypot(best.x - n.x, best.y - n.y) || 1;
      const ux = (best.x - n.x) / len;
      const uy = (best.y - n.y) / len;
      for (const k of [0, 1.6]) B.strip(n.x + ux * k - uy * 11.5, n.y + uy * k + ux * 11.5, n.x + ux * k + uy * 11.5, n.y + uy * k - ux * 11.5, 0.8, cYellow);
    }
    // gate stands: stop bar + apron floodlight
    for (const gt of ap.gates) {
      const n = ap.nodes[gt.node];
      if (!n) continue;
      const hx = Math.sin(gt.hdg * DEG);
      const hy = Math.cos(gt.hdg * DEG);
      B.strip(n.x + hy * 4, n.y - hx * 4, n.x - hy * 4, n.y + hx * 4, 0.45, cYellow);
      for (const s of [-1, 1]) {
        const ox = hy * s * 4.5;
        const oy = -hx * s * 4.5;
        B.strip(n.x + ox - hx * 14, n.y + oy - hy * 14, n.x + ox - hx * 2, n.y + oy - hy * 2, 0.25, cWhite);
      }
      light(n.x + hx * 16, n.y + hy * 16, 16, L_WARM, 0.9, 7000);
    }

    // runways
    for (const r of ap.runways) {
      const [e0, e1] = r.ends;
      const len = Math.hypot(e1.x - e0.x, e1.y - e0.y);
      if (len < 1) continue;
      const ux = (e1.x - e0.x) / len;
      const uy = (e1.y - e0.y) / len;
      const px = uy;
      const py = -ux;
      const w = r.width;
      C.strip(e0.x, e0.y, e1.x, e1.y, w + 10, cShoulder, 75);
      C.strip(e0.x, e0.y, e1.x, e1.y, w, cAsphalt, 0);
      for (const s of [-1, 1]) {
        const o = s * (w / 2 - 0.9);
        D.strip(e0.x + px * o, e0.y + py * o, e1.x + px * o, e1.y + py * o, 0.9, cWhite);
      }
      const nw = w * 0.5;
      const nh = nw * 1.5;
      const clear = 48 + nh + 16;
      for (let d = clear; d < len - clear - 30; d += 61) D.strip(e0.x + ux * d, e0.y + uy * d, e0.x + ux * (d + 36.5), e0.y + uy * (d + 36.5), 0.9, cWhite);
      for (let k = 0; k < 2; k++) {
        const e = r.ends[k];
        const dx = k === 0 ? ux : -ux;
        const dy = k === 0 ? uy : -uy;
        const rx = dy;
        const ry = -dx;
        const at = (al: number, lat: number): [number, number] => [e.x + dx * al + rx * lat, e.y + dy * al + ry * lat];
        const bar = (al0: number, al1: number, lat: number, bw: number) => {
          const a = at(al0, lat);
          const b = at(al1, lat);
          D.strip(a[0], a[1], b[0], b[1], bw, cWhite);
        };
        // threshold bar + piano keys
        {
          const a = at(1.5, w / 2 - 1);
          const b = at(1.5, -(w / 2 - 1));
          D.strip(a[0], a[1], b[0], b[1], 1.8, cWhite);
        }
        const keys = w >= 40 ? 6 : w >= 28 ? 4 : 3;
        for (let i = 0; i < keys; i++) for (const s of [-1, 1]) bar(6, 36, s * (2.6 + (i + 0.5) * ((w / 2 - 4.4) / keys)), Math.min(1.8, ((w / 2 - 4.4) / keys) * 0.55));
        // aiming point + touchdown zone
        const aim = len >= 1500 ? 300 : Math.min(150, len * 0.1);
        for (const s of [-1, 1]) bar(aim, aim + (len >= 1500 ? 45 : 30), s * w * 0.24, w * 0.15);
        if (len >= 1800) {
          const tdz: [number, number][] = [[150, 3], [450, 2], [600, 2], [750, 1], [900, 1]];
          for (const [al, n] of tdz) {
            if (al > len / 2 - 100) continue;
            for (const s of [-1, 1]) for (let i = 0; i < n; i++) bar(al, al + 22.5, s * (w * 0.2 + i * 3), 1.8);
          }
        }
        // designator (reads upright to a pilot landing from this end)
        {
          const c0 = at(48 + nh / 2, 0);
          const corner = (u: number, v: number) => [c0[0] + rx * u * (nw / 2) + dx * v * (nh / 2), 0, -(c0[1] + ry * u * (nw / 2) + dy * v * (nh / 2))];
          const quad = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
          const np: number[] = [];
          const nuv: number[] = [];
          for (const [u, v] of quad) {
            np.push(...corner(u, v));
            nuv.push((u + 1) / 2, (v + 1) / 2);
          }
          const ng = new THREE.BufferGeometry();
          ng.setAttribute('position', new THREE.Float32BufferAttribute(np, 3));
          ng.setAttribute('uv', new THREE.Float32BufferAttribute(nuv, 2));
          geos.push(ng);
          const nm = new THREE.Mesh(ng, numMat(e.name));
          nm.renderOrder = 7;
          nm.matrixAutoUpdate = false;
          group.add(nm);
        }
        // threshold (green, seen from the approach) and runway-end (red, seen from the runway) lights
        const nT = Math.max(6, Math.round(w / 3));
        for (let i = 0; i <= nT; i++) {
          const p = at(-1.5, -w / 2 + (w * i) / nT);
          light(p[0], p[1], 0.5, L_GREEN, 0.6, 14000, -dx, -dy);
          light(p[0], p[1], 0.5, L_RED, 0.6, 9000, dx, dy);
        }
        // approach lights
        const reach = e.ils ? 720 : 420;
        for (let d = 30; d <= reach; d += 30) {
          for (let o = -3; o <= 3; o += 1.5) {
            const p = at(-d, o);
            light(p[0], p[1], 1.2, L_WHITE, 0.7, 16000, -dx, -dy);
          }
        }
        for (const d of e.ils ? [150, 300] : [300]) {
          for (let o = 6; o <= 21; o += 2.5) {
            for (const s of [-1, 1]) {
              const p = at(-d, s * o);
              light(p[0], p[1], 1.2, L_WHITE, 0.7, 16000, -dx, -dy);
            }
          }
        }
      }
      // edge lights
      const nE = Math.max(2, Math.round(len / 60));
      for (let i = 0; i <= nE; i++) {
        const d = (len * i) / nE;
        for (const s of [-1, 1]) {
          const o = s * (w / 2 + 2);
          light(e0.x + ux * d + px * o, e0.y + uy * d + py * o, 0.5, L_WHITE, 0.6, 14000);
        }
      }
      // centreline lights
      const nC = Math.round(len / 30);
      for (let i = 2; i < nC - 1; i++) light(e0.x + (ux * len * i) / nC, e0.y + (uy * len * i) / nC, 0.1, L_WHITE, 0.3, 4500);
    }
    addFlat(A, paveMat, 1);
    addFlat(B, paintMat, 2);
    addFlat(C, paveMat, 3);
    addFlat(D, paintMat, 4);

    // buildings: terminals + control tower in one mesh
    {
      const parts: Part[] = [];
      ap.terminals.forEach((t, i) => {
        if (t.poly.length < 3) return;
        const h = 15 + ((i * 7) % 10);
        const shape = new THREE.Shape(t.poly.map(([x, y]) => new THREE.Vector2(x, y)));
        const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        g.rotateX(-Math.PI / 2);
        parts.push({ geo: g, color: cWall, roof: cRoof });
        // glazing bands just outside each wall
        let area = 0;
        for (let k = 0, j = t.poly.length - 1; k < t.poly.length; j = k++) area += t.poly[j][0] * t.poly[k][1] - t.poly[k][0] * t.poly[j][1];
        const ccw = area > 0 ? 1 : -1;
        const wp: number[] = [];
        const wn: number[] = [];
        for (let k = 0; k < t.poly.length; k++) {
          const [ax, ay] = t.poly[k];
          const [bx, by] = t.poly[(k + 1) % t.poly.length];
          const len = Math.hypot(bx - ax, by - ay);
          if (len < 6) continue;
          const nx = ((by - ay) / len) * ccw;
          const ny = (-(bx - ax) / len) * ccw;
          for (const [y0, y1] of [[2.2, 5.4], [8.2, h - 2.2]]) {
            if (y1 - y0 < 1) continue;
            const A = [ax + nx * 0.25, -(ay + ny * 0.25)];
            const B = [bx + nx * 0.25, -(by + ny * 0.25)];
            wp.push(A[0], y0, A[1], B[0], y0, B[1], B[0], y1, B[1], A[0], y0, A[1], B[0], y1, B[1], A[0], y1, A[1]);
            for (let q = 0; q < 6; q++) wn.push(nx, 0, -ny);
          }
        }
        if (wp.length) {
          const wg = new THREE.BufferGeometry();
          wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
          wg.setAttribute('normal', new THREE.Float32BufferAttribute(wn, 3));
          parts.push({ geo: wg, color: cGlassB });
        }
      });
      const tx = ap.towerPos[0];
      const tz = -ap.towerPos[1];
      parts.push({ geo: new THREE.CylinderGeometry(4, 6, TOWER_H - 12, 12).translate(tx, (TOWER_H - 12) / 2, tz), color: cTower });
      parts.push({ geo: new THREE.CylinderGeometry(9, 5, 5, 12).translate(tx, TOWER_H - 9.5, tz), color: cTower });
      parts.push({ geo: new THREE.CylinderGeometry(10.5, 8.5, 7, 12).translate(tx, TOWER_H - 3.5, tz), color: cCab });
      parts.push({ geo: new THREE.CylinderGeometry(3, 11, 2.5, 12).translate(tx, TOWER_H + 1.25, tz), color: cTower });
      parts.push({ geo: new THREE.CylinderGeometry(0.3, 0.3, 5, 6).translate(tx, TOWER_H + 4.5, tz), color: cTower });
      light(ap.towerPos[0], ap.towerPos[1], TOWER_H + 7.2, L_RED, 1.0, 15000);
      const g = mergeColored(parts);
      geos.push(g);
      const m = new THREE.Mesh(g, bldMat);
      m.renderOrder = 10;
      m.matrixAutoUpdate = false;
      group.add(m);
    }
    if (lp.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      g.setAttribute('lcol', new THREE.Float32BufferAttribute(lc, 3));
      g.setAttribute('ldir', new THREE.Float32BufferAttribute(ld, 3));
      g.setAttribute('lsize', new THREE.Float32BufferAttribute(ls, 2));
      g.computeBoundingSphere();
      geos.push(g);
      const pts = new THREE.Points(g, apLightMat.m);
      pts.renderOrder = 12;
      pts.userData.lights = true;
      group.add(pts);
    }
    scene.add(group);
    return { ap, group, geos };
  };
  const apVis: ApVis[] = [];
  const dropAirport = (v: ApVis) => {
    scene.remove(v.group);
    for (const g of v.geos) g.dispose();
  };
  const syncAirports = (list: PlacedAirport[]) => {
    let same = list.length === apVis.length;
    if (same) for (let i = 0; i < list.length; i++) if (apVis[i].ap !== list[i].ap) same = false;
    if (same) return;
    for (const v of apVis) dropAirport(v);
    apVis.length = 0;
    for (const pa of list) apVis.push(buildAirport(pa.ap));
  };

  // ── PAPI (2 runways × 4 boxes) ──
  const papiPos = new Float32Array(24);
  const papiCol = new Float32Array(24);
  const papiDir = new Float32Array(24);
  const papiSize = new Float32Array(16);
  const papiGeo = own(new THREE.BufferGeometry());
  const papiPosAttr = new THREE.BufferAttribute(papiPos, 3).setUsage(THREE.DynamicDrawUsage);
  const papiColAttr = new THREE.BufferAttribute(papiCol, 3).setUsage(THREE.DynamicDrawUsage);
  const papiDirAttr = new THREE.BufferAttribute(papiDir, 3).setUsage(THREE.DynamicDrawUsage);
  const papiSizeAttr = new THREE.BufferAttribute(papiSize, 2).setUsage(THREE.DynamicDrawUsage);
  papiGeo.setAttribute('position', papiPosAttr);
  papiGeo.setAttribute('lcol', papiColAttr);
  papiGeo.setAttribute('ldir', papiDirAttr);
  papiGeo.setAttribute('lsize', papiSizeAttr);
  const papi = new THREE.Points(papiGeo, papiMat.m);
  papi.frustumCulled = false;
  papi.renderOrder = 13;
  scene.add(papi);

  // ── guidance: taxi ribbon, hold bar, glidepath gates, waypoint marker ──
  const guideOpts = { transparent: true, depthWrite: false, side: THREE.DoubleSide } as const;
  const taxiArr = new Float32Array(MAX_TAXI_SEG * 18);
  const taxiAttr = new THREE.BufferAttribute(taxiArr, 3).setUsage(THREE.DynamicDrawUsage);
  const taxiGeo = own(new THREE.BufferGeometry());
  taxiGeo.setAttribute('position', taxiAttr);
  taxiGeo.setDrawRange(0, 0);
  const taxiMesh = new THREE.Mesh(taxiGeo, own(new THREE.MeshBasicMaterial({ color: 0xff2fd0, opacity: 0.82, ...guideOpts })));
  taxiMesh.frustumCulled = false;
  taxiMesh.renderOrder = 8;
  taxiMesh.visible = false;
  const holdGeo = own(
    (() => {
      // red bar on the ground (30 × 1.6 m) plus a low translucent wall; local x = across the route, −z = along it
      const p: number[] = [];
      const q = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, x3: number, y3: number, z3: number) => p.push(x0, y0, z0, x1, y1, z1, x2, y2, z2, x0, y0, z0, x2, y2, z2, x3, y3, z3);
      q(-15, 0.06, 0.8, 15, 0.06, 0.8, 15, 0.06, -0.8, -15, 0.06, -0.8);
      q(-15, 0, 0, 15, 0, 0, 15, 1.4, 0, -15, 1.4, 0);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      return g;
    })(),
  );
  const holdMesh = new THREE.Mesh(holdGeo, own(new THREE.MeshBasicMaterial({ color: 0xff2020, opacity: 0.7, ...guideOpts })));
  holdMesh.frustumCulled = false;
  holdMesh.renderOrder = 9;
  holdMesh.visible = false;
  scene.add(taxiMesh, holdMesh);
  const taxiSig = { n: -1, x0: 0, y0: 0, x1: 0, y1: 0, hx: NaN, hy: NaN, elev: 0 };

  const HOOPS = 17;
  const hoopArr = new Float32Array(HOOPS * 4 * 18);
  const hoopAttr = new THREE.BufferAttribute(hoopArr, 3).setUsage(THREE.DynamicDrawUsage);
  const hoopGeo = own(new THREE.BufferGeometry());
  hoopGeo.setAttribute('position', hoopAttr);
  const hoopMesh = new THREE.Mesh(hoopGeo, own(new THREE.MeshBasicMaterial({ color: 0x35ffb2, opacity: 0.8, fog: false, ...guideOpts })));
  hoopMesh.frustumCulled = false;
  hoopMesh.renderOrder = 35;
  hoopMesh.visible = false;
  scene.add(hoopMesh);
  const hoopSig = { x: NaN, y: NaN, hdg: NaN, aim: NaN, elev: NaN };

  const wpPillar = new THREE.Mesh(own(new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, true).translate(0, 0.5, 0)), own(new THREE.MeshBasicMaterial({ color: 0xff40e0, opacity: 0.45, fog: false, ...guideOpts })));
  wpPillar.frustumCulled = false;
  wpPillar.renderOrder = 35;
  wpPillar.visible = false;
  const wpRing = new THREE.Mesh(own(new THREE.TorusGeometry(1, 0.08, 6, 28).rotateX(Math.PI / 2)), own(new THREE.MeshBasicMaterial({ color: 0xff40e0, opacity: 0.9, fog: false, ...guideOpts })));
  wpRing.frustumCulled = false;
  wpRing.renderOrder = 35;
  wpRing.visible = false;
  const [wpCanvas, wpCtx] = makeCanvas(384, 64);
  const wpTex = own(new THREE.CanvasTexture(wpCanvas));
  wpTex.colorSpace = THREE.SRGBColorSpace;
  const wpLabel = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: wpTex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true, fog: false })));
  wpLabel.center.set(0.5, 0);
  wpLabel.renderOrder = 36;
  wpLabel.visible = false;
  scene.add(wpPillar, wpRing, wpLabel);
  let wpText = '';
  let wpTextT = 0;

  // ── own aircraft ──
  const acGroup = new THREE.Group();
  acGroup.rotation.order = 'YXZ';
  scene.add(acGroup);
  const acMat = own(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x20242a, emissiveIntensity: 0.35 }));
  let acKind: AcKind | null = null;
  let model: ModelInfo | null = null;
  let bodyMesh: THREE.Mesh | null = null;
  let gearMesh: THREE.Mesh | null = null;
  const bladeMat = own(new THREE.MeshBasicMaterial({ color: 0x15171a }));
  const discMat = own(new THREE.MeshBasicMaterial({ color: 0x30343a, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
  const mkProp = (r: number, order: number) => {
    const grp = new THREE.Group();
    const blades = new THREE.Mesh(own(new THREE.BoxGeometry(r * 0.1, r * 2, 0.03)), bladeMat);
    const disc = new THREE.Mesh(own(new THREE.CircleGeometry(r, 36)), discMat);
    blades.renderOrder = order;
    disc.renderOrder = order + 1;
    grp.add(blades, disc);
    return { grp, blades, disc };
  };
  let extProp: ReturnType<typeof mkProp> | null = null;
  let propAngle = 1.05;
  // exterior lights (10 points, see ModelInfo.lights)
  const AC_L = 10;
  const acLPos = new Float32Array(AC_L * 3);
  const acLSize = new Float32Array(AC_L * 2);
  const acLGeo = own(new THREE.BufferGeometry());
  const acLPosAttr = new THREE.BufferAttribute(acLPos, 3);
  const acLSizeAttr = new THREE.BufferAttribute(acLSize, 2).setUsage(THREE.DynamicDrawUsage);
  acLGeo.setAttribute('position', acLPosAttr);
  acLGeo.setAttribute('lsize', acLSizeAttr);
  acLGeo.setAttribute(
    'lcol',
    new THREE.BufferAttribute(new Float32Array([1, 0.08, 0.05, 0.1, 1, 0.3, 1, 1, 1, 1, 0.08, 0.05, 1, 0.08, 0.05, 1, 1, 1, 1, 1, 1, 1, 0.97, 0.9, 1, 0.97, 0.9, 1, 0.97, 0.9]), 3),
  );
  {
    const d = new Float32Array(AC_L * 3);
    for (const i of [7, 8, 9]) {
      d[i * 3 + 1] = -0.06;
      d[i * 3 + 2] = -1;
    }
    acLGeo.setAttribute('ldir', new THREE.BufferAttribute(d, 3));
  }
  const acLBase = [0.5, 0.5, 0.5, 0.7, 0.7, 1.0, 1.0, 1.8, 1.8, 1.2];
  const acLRange = [9000, 9000, 9000, 12000, 12000, 16000, 16000, 25000, 25000, 12000];
  const acFlags: boolean[] = new Array(AC_L).fill(false);
  const swOn = (sw: Record<string, number>, id: string, powered: boolean, dflt: boolean) => powered && (sw[id] != null ? sw[id] > 0 : dflt);
  const acLights = new THREE.Points(acLGeo, acLightMat.m);
  acLights.frustumCulled = false;
  acLights.renderOrder = 40;
  acGroup.add(acLights);
  // ground shadow blob
  const shadowMat = own(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false }));
  const shadow = new THREE.Mesh(own(new THREE.CircleGeometry(0.5, 24).rotateX(-Math.PI / 2)), shadowMat);
  shadow.renderOrder = 9;
  shadow.frustumCulled = false;
  scene.add(shadow);

  // C172 cockpit foreground: cowling + prop, defined relative to the pilot's eye in the aircraft frame
  const cowlGroup = new THREE.Group();
  cowlGroup.visible = false;
  scene.add(cowlGroup);
  const cowlMat = own(new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, fog: false }));
  let cowlProp: ReturnType<typeof mkProp> | null = null;
  {
    const parts: Part[] = [];
    const cWhiteP = new THREE.Color(0xc4c9cf);
    const cGlare = new THREE.Color(0x17191c);
    const cowl = new THREE.BoxGeometry(0.98, 0.6, 1.2, 1, 1, 4);
    const p = cowl.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const t = 0.5 - p.getZ(i) / 1.2; // 0 at the firewall … 1 at the nose
      const s = 1 - 0.36 * t * t;
      p.setX(i, p.getX(i) * s);
      p.setY(i, p.getY(i) - (p.getY(i) > 0 ? 0.07 * t * t : 0));
    }
    cowl.computeVertexNormals();
    cowl.translate(0, -0.72, -1.35);
    parts.push({ geo: cowl, color: cWhiteP });
    parts.push({ geo: new THREE.BoxGeometry(1.5, 0.08, 0.6).translate(0, -0.45, -0.55), color: cGlare });
    parts.push({ geo: new THREE.ConeGeometry(0.16, 0.36, 10).rotateX(-Math.PI / 2).translate(0, -0.66, -2.1), color: cGlare });
    const m = new THREE.Mesh(own(mergeColored(parts)), cowlMat);
    m.renderOrder = 60;
    m.frustumCulled = false;
    cowlGroup.add(m);
    cowlProp = mkProp(0.95, 61);
    cowlProp.grp.position.set(0, -0.66, -2.0);
    cowlGroup.add(cowlProp.grp);
  }

  const syncModel = (kind: AcKind, L: number, S: number) => {
    if (kind === acKind) return;
    acKind = kind;
    if (bodyMesh) {
      acGroup.remove(bodyMesh);
      bodyMesh.geometry.dispose();
    }
    if (gearMesh) {
      acGroup.remove(gearMesh);
      gearMesh.geometry.dispose();
    }
    if (extProp) acGroup.remove(extProp.grp);
    extProp = null;
    gearMesh = null;
    model = kind === 'jet' ? buildJet(L, S) : buildC172(L, S);
    bodyMesh = new THREE.Mesh(model.body, acMat);
    bodyMesh.renderOrder = 10;
    acGroup.add(bodyMesh);
    if (model.gear) {
      gearMesh = new THREE.Mesh(model.gear, acMat);
      gearMesh.renderOrder = 10;
      acGroup.add(gearMesh);
    }
    if (model.prop) {
      extProp = mkProp(model.prop.r, 40);
      extProp.grp.position.set(model.prop.x, model.prop.y, model.prop.z);
      acGroup.add(extProp.grp);
    }
    acLPos.set(model.lights);
    acLPosAttr.needsUpdate = true;
  };

  // ── camera state ──
  const head = { yaw: 0, pitch: 0 };
  const orbit = { az: 0, el: 12, k: 1 };
  let chaseHdg = NaN;
  const fly = { valid: false, x: 0, y: 0, z: 0, side: 1 };
  let lastMode: PilotCam | null = null;
  let width = 1;
  let height = 1;
  let curFov = 60;

  // ── input ──
  let drag: { x: number; y: number; id: number } | null = null;
  const lookAllowed = (e: PointerEvent | MouseEvent) => e.button === 2 || (e.button === 0 && (e.altKey || !getYoke()));
  const onDown = (e: PointerEvent) => {
    if (!lookAllowed(e)) return; // plain left button belongs to the yoke
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    const mode = getCam();
    if (mode === 'cockpit') {
      const dpp = curFov / height;
      head.yaw = clamp(head.yaw - dx * dpp * 1.3, -120, 120);
      head.pitch = clamp(head.pitch + dy * dpp * 1.3, -45, 45);
    } else if (mode === 'chase') {
      orbit.az = (orbit.az - dx * 0.3) % 360;
      orbit.el = clamp(orbit.el + dy * 0.3, -8, 85);
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  const onDbl = () => {
    head.yaw = 0;
    head.pitch = 0;
    orbit.az = 0;
    orbit.el = 12;
    orbit.k = 1;
  };
  const onWheel = (e: WheelEvent) => {
    if (getCam() !== 'chase') return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    orbit.k = clamp(orbit.k * Math.exp(clamp(dy, -300, 300) * 0.0012), 0.35, 12);
  };
  const onCtx = (e: Event) => e.preventDefault();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onCtx);

  // ── resize ──
  const resize = () => {
    const w = Math.max(1, Math.floor(container.clientWidth));
    const h = Math.max(1, Math.floor(container.clientHeight));
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // ── scratch ──
  const eul = new THREE.Euler(0, 0, 0, 'YXZ');
  const qAc = new THREE.Quaternion();
  const qHead = new THREE.Quaternion();
  const v3 = new THREE.Vector3();
  const v3b = new THREE.Vector3();
  const cA = new THREE.Color();
  const cB = new THREE.Color();
  const cZen = new THREE.Color();
  const cHor = new THREE.Color();
  const cCloud = new THREE.Color();
  const sunDir = new THREE.Vector3();
  const moonDir = new THREE.Vector3();
  const N_ZEN = new THREE.Color(0x02040a);
  const D_ZEN = new THREE.Color(0x1d5cb4);
  const K_ZEN = new THREE.Color(0x27335f);
  const N_HOR = new THREE.Color(0x070a14);
  const D_HOR = new THREE.Color(0xa6c8e8);
  const K_HOR = new THREE.Color(0xe9955a);
  const D_GREY = new THREE.Color(0xb4bcc4);
  const SUN_DAY = new THREE.Color(0xfff3dc);
  const SUN_LOW = new THREE.Color(0xff9a4a);
  const MOON = new THREE.Color(0x8fa6d8);
  const HEMI_GROUND_D = new THREE.Color(0x5a5a48);

  let cwx = 0;
  let cwy = 0;
  let cwz = 0;
  const groundElevAt = (list: PlacedAirport[], x: number, y: number): number => {
    if (!list.length) return 0;
    let d1 = Infinity;
    let d2 = Infinity;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i < list.length; i++) {
      const d = Math.hypot(list[i].ox - x, list[i].oy - y);
      if (d < d1) {
        d2 = d1;
        e2 = e1;
        d1 = d;
        e1 = list[i].elev;
      } else if (d < d2) {
        d2 = d;
        e2 = list[i].elev;
      }
    }
    if (!isFinite(d2)) return e1;
    // exact near either airport, blended only around the midpoint
    return e1 + (e2 - e1) * sm(0.38, 0.62, d1 / (d1 + d2));
  };
  const nearestElev = (list: PlacedAirport[], x: number, y: number): number => {
    let best = Infinity;
    let e = 0;
    for (let i = 0; i < list.length; i++) {
      const d = Math.hypot(list[i].ox - x, list[i].oy - y);
      if (d < best) {
        best = d;
        e = list[i].elev;
      }
    }
    return e;
  };

  const setPapi = (slot: number, r: RunwayRef | null, eyeH: number) => {
    const o = slot * 12;
    if (!r) {
      for (let i = 0; i < 4; i++) papiSize[slot * 8 + i * 2] = 0;
      return;
    }
    const hx = Math.sin(r.hdg * DEG);
    const hy = Math.cos(r.hdg * DEG);
    const ax = r.thrX + hx * r.aim;
    const ay = r.thrY + hy * r.aim;
    const dist = Math.hypot(ax - cwx, ay - cwy);
    const ang = Math.atan2(cwz - r.elev, Math.max(1, dist)) / DEG;
    const nWhite = ang > 3.5 ? 4 : ang > 3.2 ? 3 : ang > 2.8 ? 2 : ang > 2.5 ? 1 : 0;
    // spread the boxes with distance so the four lights stay separable far out
    const sp = Math.max(9, dist * 0.0042);
    const lx = -hy;
    const ly = hx;
    for (let i = 0; i < 4; i++) {
      const off = r.width / 2 + 15 + i * sp;
      const wx = ax + lx * off;
      const wy = ay + ly * off;
      papiPos[o + i * 3] = wx - cwx;
      papiPos[o + i * 3 + 1] = r.elev + 1 + eyeH * 0 - cwz;
      papiPos[o + i * 3 + 2] = -(wy - cwy);
      const white = i >= 4 - nWhite;
      papiCol[o + i * 3] = 1;
      papiCol[o + i * 3 + 1] = white ? 1 : 0.05;
      papiCol[o + i * 3 + 2] = white ? 0.95 : 0.03;
      papiDir[o + i * 3] = -hx;
      papiDir[o + i * 3 + 1] = 0.05;
      papiDir[o + i * 3 + 2] = hy;
      papiSize[slot * 8 + i * 2] = 1.6;
      papiSize[slot * 8 + i * 2 + 1] = 45000;
    }
  };

  const rebuildTaxi = (s: PilotState) => {
    const t = s.taxi;
    const pts = t ? t.pts : null;
    const n = pts ? pts.length : 0;
    const hx = t && t.hold ? t.hold[0] : NaN;
    const hy = t && t.hold ? t.hold[1] : NaN;
    if (!pts || n < 2) {
      taxiSig.n = n;
      taxiGeo.setDrawRange(0, 0);
      taxiSig.hx = NaN;
      return;
    }
    const sameHold = hx === taxiSig.hx || (isNaN(hx) && isNaN(taxiSig.hx));
    if (n === taxiSig.n && pts[0][0] === taxiSig.x0 && pts[0][1] === taxiSig.y0 && pts[n - 1][0] === taxiSig.x1 && pts[n - 1][1] === taxiSig.y1 && sameHold && (isNaN(hy) || hy === taxiSig.hy)) return;
    taxiSig.n = n;
    taxiSig.x0 = pts[0][0];
    taxiSig.y0 = pts[0][1];
    taxiSig.x1 = pts[n - 1][0];
    taxiSig.y1 = pts[n - 1][1];
    taxiSig.hx = hx;
    taxiSig.hy = hy;
    taxiSig.elev = nearestElev(s.airports, pts[0][0], pts[0][1]);
    let o = 0;
    let segs = 0;
    let bestD = Infinity;
    let bux = 0;
    let buy = 1;
    for (let i = 0; i < n - 1 && segs < MAX_TAXI_SEG; i++) {
      const ax = pts[i][0] - taxiSig.x0;
      const ay = pts[i][1] - taxiSig.y0;
      const bx = pts[i + 1][0] - taxiSig.x0;
      const by = pts[i + 1][1] - taxiSig.y0;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.01) continue;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      if (!isNaN(hx)) {
        const tt = clamp((hx - pts[i][0]) * ux + (hy - pts[i][1]) * uy, 0, len);
        const d = Math.hypot(pts[i][0] + ux * tt - hx, pts[i][1] + uy * tt - hy);
        if (d < bestD) {
          bestD = d;
          bux = ux;
          buy = uy;
        }
      }
      const nx = -uy * 0.8;
      const ny = ux * 0.8;
      const ex = ux * 0.4;
      const ey = uy * 0.4;
      const x0 = ax - ex;
      const y0 = ay - ey;
      const x1 = bx + ex;
      const y1 = by + ey;
      const put = (x: number, y: number) => {
        taxiArr[o++] = x;
        taxiArr[o++] = 0.05;
        taxiArr[o++] = -y;
      };
      put(x0 + nx, y0 + ny);
      put(x1 + nx, y1 + ny);
      put(x1 - nx, y1 - ny);
      put(x0 + nx, y0 + ny);
      put(x1 - nx, y1 - ny);
      put(x0 - nx, y0 - ny);
      segs++;
    }
    taxiAttr.needsUpdate = true;
    taxiGeo.setDrawRange(0, segs * 6);
    holdMesh.rotation.y = -Math.atan2(bux, buy);
  };

  const rebuildHoops = (r: RunwayRef) => {
    if (r.thrX === hoopSig.x && r.thrY === hoopSig.y && r.hdg === hoopSig.hdg && r.aim === hoopSig.aim && r.elev === hoopSig.elev) return;
    hoopSig.x = r.thrX;
    hoopSig.y = r.thrY;
    hoopSig.hdg = r.hdg;
    hoopSig.aim = r.aim;
    hoopSig.elev = r.elev;
    const hx = Math.sin(r.hdg * DEG);
    const hy = Math.cos(r.hdg * DEG);
    const rx = hy;
    const ry = -hx;
    let o = 0;
    // anchor = aim point at runway elevation; hoop k sits d metres back along the approach
    for (let k = 0; k < HOOPS; k++) {
      const d = r.aim + k * 0.5 * NM;
      const W = clamp(46 + d * 0.011, 50, 210) / 2;
      const H = W * 0.55;
      const t = W * 0.07;
      const cx = -hx * d;
      const cy = -hy * d;
      const cz = GS_TAN * d;
      const quad = (u0: number, v0: number, u1: number, v1: number) => {
        const put = (u: number, v: number) => {
          hoopArr[o++] = cx + rx * u;
          hoopArr[o++] = cz + v;
          hoopArr[o++] = -(cy + ry * u);
        };
        put(u0, v0);
        put(u1, v0);
        put(u1, v1);
        put(u0, v0);
        put(u1, v1);
        put(u0, v1);
      };
      quad(-W, H - t, W, H);
      quad(-W, -H, W, -H + t);
      quad(-W, -H, -W + t, H);
      quad(W - t, -H, W, H);
    }
    hoopAttr.needsUpdate = true;
  };

  // ── frame loop ──
  let raf = 0;
  let last = performance.now();
  let disposed = false;

  const frame = (now: number) => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const s = getState();
    if (!s || !s.ac) return;
    const ac = s.ac;
    const kind: AcKind = s.cfg.aircraft === 'c172' ? 'c172' : 'jet';
    const def = ACDEF[kind];
    const mode = getCam();
    syncAirports(s.airports);
    syncModel(kind, def.length, def.span);

    // aircraft attitude: yaw, then pitch, then roll (body frame: nose −Z, right wing +X)
    eul.set(ac.pitch * DEG, -ac.hdg * DEG, -ac.bank * DEG, 'YXZ');
    qAc.setFromEuler(eul);

    const acGround = groundElevAt(s.airports, ac.x, ac.y);
    if (mode !== lastMode) {
      lastMode = mode;
      fly.valid = false;
      chaseHdg = ac.hdg;
      drag = null;
    }

    // ── camera ──
    let wantFov = 62;
    let near = 0.3;
    if (mode === 'cockpit') {
      v3.set(0, def.eye.up, -def.eye.fwd).applyQuaternion(qAc);
      cwx = ac.x + v3.x;
      cwy = ac.y - v3.z;
      cwz = ac.z + v3.y;
      eul.set(head.pitch * DEG, -head.yaw * DEG, 0, 'YXZ');
      qHead.setFromEuler(eul);
      camera.quaternion.copy(qAc).multiply(qHead);
      near = kind === 'c172' ? 0.15 : 0.5;
    } else if (mode === 'chase') {
      if (isNaN(chaseHdg)) chaseHdg = ac.hdg;
      chaseHdg += angDiff(ac.hdg, chaseHdg) * Math.min(1, dt * 3.5);
      const D = (def.length * 1.7 + 9) * orbit.k;
      const B = (chaseHdg + 180 + orbit.az) * DEG;
      const el = orbit.el * DEG;
      const tz = ac.z + def.length * 0.1 + 1;
      cwx = ac.x + Math.sin(B) * Math.cos(el) * D;
      cwy = ac.y + Math.cos(B) * Math.cos(el) * D;
      cwz = Math.max(tz + Math.sin(el) * D, groundElevAt(s.airports, cwx, cwy) + 1.2);
      v3.set(ac.x - cwx, tz - cwz, -(ac.y - cwy));
      camera.position.set(0, 0, 0);
      camera.up.set(0, 1, 0);
      camera.lookAt(v3);
      wantFov = 50;
      near = Math.max(0.5, D * 0.03);
    } else {
      const d = Math.hypot(ac.x - fly.x, ac.y - fly.y, ac.z - fly.z);
      if (!fly.valid || d > 1500) {
        const trk = (ac.gs > 2 ? ac.gtrk : ac.hdg) * DEG;
        const ahead = clamp(ac.gs * 6, 140, 1150);
        fly.side = -fly.side;
        const side = (def.span * 1.1 + 22) * fly.side;
        fly.x = ac.x + Math.sin(trk) * ahead + Math.cos(trk) * side;
        fly.y = ac.y + Math.cos(trk) * ahead - Math.sin(trk) * side;
        const g = groundElevAt(s.airports, fly.x, fly.y);
        const tAhead = ahead / Math.max(ac.gs, 20);
        fly.z = ac.onGround || ac.agl < 12 ? g + 2.2 : Math.max(g + 2.2, ac.z + ac.vs * tAhead - Math.min(30, 6 + ac.agl * 0.1));
        fly.valid = true;
      }
      cwx = fly.x;
      cwy = fly.y;
      cwz = fly.z;
      const tz = ac.z + def.length * 0.08 + 0.8;
      v3.set(ac.x - cwx, tz - cwz, -(ac.y - cwy));
      const dist = Math.max(1, v3.length());
      camera.position.set(0, 0, 0);
      camera.up.set(0, 1, 0);
      camera.lookAt(v3);
      wantFov = clamp((2 * Math.atan((def.length * 1.3) / dist)) / DEG, 4, 50);
      near = 1;
    }
    // cap the horizontal field of view so a wide strip does not distort
    const capFov = (2 * Math.atan(Math.tan(52.5 * DEG) / Math.max(0.2, camera.aspect))) / DEG;
    const fovNow = Math.min(wantFov, capFov);
    if (Math.abs(fovNow - curFov) > 1e-3 || camera.near !== near) {
      curFov = fovNow;
      camera.fov = fovNow;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    const pxScale = (height * dpr) / (2 * Math.tan((curFov * DEG) / 2));

    // ── environment ──
    const gElev = groundElevAt(s.airports, cwx, cwy);
    const hAgl = Math.max(0, cwz - gElev);
    const hour = ((s.env.hour % 24) + 24) % 24;
    const sunEl = 62 * Math.cos(((hour - 12) * Math.PI) / 12) - 2;
    const sunAz = (90 + (hour - 6) * 15) * DEG;
    const ce = Math.cos(sunEl * DEG);
    sunDir.set(Math.sin(sunAz) * ce, Math.sin(sunEl * DEG), -Math.cos(sunAz) * ce);
    moonDir.set(-sunDir.x * 0.8, Math.max(0.35, -sunDir.y), -sunDir.z * 0.8 + 0.3).normalize();
    const day = sm(-9, 12, sunEl);
    const night = 1 - sm(-14, -5, sunEl);
    const dusk = Math.exp(-((sunEl - 1) / 8) * ((sunEl - 1) / 8));
    const vis = Math.max(50, s.env.vis);
    const lowVis = 1 - sm(3000, 14000, vis);
    const hasCloud = s.env.cloudBase < 60000;
    const cBase = gElev + s.env.cloudBase * FT;
    const cTop = cBase + CLOUD_THICK;
    let white = 0;
    let under = 0;
    if (hasCloud) {
      white = cwz < cBase ? sm(cBase - 60, cBase, cwz) : 1 - sm(cTop, cTop + 60, cwz);
      under = cwz < cTop ? 1 : 0;
    }
    const L = (0.055 + 0.945 * day) * (1 - 0.32 * under);
    cZen.copy(N_ZEN).lerp(D_ZEN, day).lerp(K_ZEN, dusk * 0.3);
    cHor.copy(N_HOR).lerp(D_HOR, day).lerp(K_HOR, dusk * 0.16);
    cA.copy(D_GREY).multiplyScalar(0.05 + 0.95 * day);
    cHor.lerp(cA, Math.max(lowVis * 0.85, under * 0.7));
    cCloud.setRGB(0.62, 0.65, 0.69).multiplyScalar(0.04 + 0.96 * day);
    const visEff = Math.exp(Math.log(Math.min(150000, vis * (1 + hAgl / 2500))) * (1 - white) + Math.log(45) * white);
    const fogD = 1.5 / visEff;
    fog.color.copy(cHor).lerp(cCloud, white);
    fog.density = fogD;
    skyU.uZen.value.copy(cZen);
    skyU.uHor.value.copy(cHor);
    skyU.uWhiteCol.value.copy(cCloud);
    skyU.uWhite.value = white;
    skyU.uSunDir.value.copy(sunDir);
    skyU.uMoonDir.value.copy(moonDir);
    skyU.uSun.value = sm(-3, 2, sunEl) * (1 - lowVis * 0.7);
    skyU.uMoon.value = night;
    skyU.uDusk.value = dusk * 0.9 * (1 - lowVis);
    skyU.uDuskCol.value.copy(K_HOR);
    skyU.uSunCol.value.copy(SUN_LOW).lerp(SUN_DAY, sm(0, 25, sunEl));
    starMat.color.setScalar(night * (1 - white) * (1 - lowVis));
    starsObj.visible = night > 0.03;
    // lights
    hemi.color.copy(cZen).lerp(cB.setRGB(1, 1, 1), 0.55);
    hemi.groundColor.copy(HEMI_GROUND_D);
    hemi.intensity = (0.3 + 2.5 * day) * (1 - 0.2 * under);
    if (sunEl > -3) {
      sun.position.copy(sunDir).multiplyScalar(100);
      sun.color.copy(skyU.uSunCol.value);
      sun.intensity = 3.4 * day * (1 - 0.75 * under) * (1 - lowVis * 0.6);
    } else {
      sun.position.copy(moonDir).multiplyScalar(100);
      sun.color.copy(MOON);
      sun.intensity = 0.3 * night;
    }
    // flat (unlit) layers are tinted by the light level
    cA.setRGB(L * (0.62 + 0.38 * day), L * (0.72 + 0.28 * day), L).lerp(cB.setRGB(L * 1.05, L * 0.82, L * 0.66), dusk * 0.35 * (1 - under));
    paveMat.color.copy(cA);
    groundU.uTint.value.copy(cA);
    const Lp = Math.max(L, 0.2);
    paintMat.color.setRGB(Lp, Lp, Lp);
    for (let i = 0; i < numMatList.length; i++) numMatList[i].color.setRGB(Lp, Lp, Lp);
    bldMat.emissiveIntensity = night * 0.5;
    groundU.uNight.value = night * 1.6;
    groundU.uFogD.value = fogD;
    const lightGain = Math.max(1 - sm(0.25, 0.75, day), lowVis, under * 0.5);
    apLightMat.u.uGain.value = lightGain;
    apLightMat.u.uFogD.value = fogD;
    apLightMat.u.uScale.value = pxScale;
    papiMat.u.uFogD.value = fogD;
    papiMat.u.uScale.value = pxScale;
    papiMat.u.uRim.value = day * 0.8;
    acLightMat.u.uFogD.value = fogD;
    acLightMat.u.uScale.value = pxScale;

    // ── ground + clouds (follow the camera; texture offsets track the world position) ──
    ground.position.set(0, gElev - cwz, 0);
    groundU.uOff.value.set(frac(cwx / T1), frac(cwy / T1), frac((ROT_C * cwx + ROT_S * cwy) / T2), frac((-ROT_S * cwx + ROT_C * cwy) / T2));
    groundU.uOffD.value.set(frac(cwx / TD), frac(cwy / TD), frac(cwx / TM), frac(cwy / TM));
    groundU.uOffM.value.set(frac((ROT_C * cwx + ROT_S * cwy) / TK), frac((-ROT_S * cwx + ROT_C * cwy) / TK), frac(cwy / T3), frac(-cwx / T3));
    cloudBase.mesh.visible = hasCloud && cwz < cTop;
    cloudTop.mesh.visible = hasCloud && cwz > cBase;
    if (hasCloud) {
      cloudBase.mesh.position.set(0, cBase - cwz, 0);
      cloudTop.mesh.position.set(0, cTop - cwz, 0);
      const ox1 = frac(cwx / 7300);
      const oy1 = frac(cwy / 7300);
      const ox2 = frac(cwx / 1900);
      const oy2 = frac(cwy / 1900);
      cloudBase.u.uOff.value.set(ox1, oy1, ox2, oy2);
      cloudTop.u.uOff.value.set(ox1 + 0.37, oy1 + 0.61, ox2 + 0.13, oy2 + 0.29);
      cloudBase.u.uCol.value.setRGB(0.5, 0.53, 0.57).multiplyScalar(0.05 + 0.95 * day);
      cloudTop.u.uCol.value.setRGB(0.93, 0.94, 0.96).multiplyScalar(0.07 + 0.93 * day).lerp(cB.copy(K_HOR).multiplyScalar(0.8), dusk * 0.3);
      cloudBase.u.uFogD.value = fogD;
      cloudTop.u.uFogD.value = fogD;
      cloudBase.u.uAlpha.value = 0.9;
      cloudTop.u.uAlpha.value = 0.97;
    }

    // ── airports ──
    for (let i = 0; i < apVis.length && i < s.airports.length; i++) {
      const pa = s.airports[i];
      const g = apVis[i].group;
      const dx = pa.ox - cwx;
      const dy = pa.oy - cwy;
      const vis2 = dx * dx + dy * dy < AIRPORT_RANGE * AIRPORT_RANGE;
      g.visible = vis2;
      if (!vis2) continue;
      g.position.set(dx, pa.elev - cwz, -dy);
      for (let k = 0; k < g.children.length; k++) {
        const ch = g.children[k];
        if (ch.userData.lights) ch.visible = lightGain > 0.02;
      }
    }

    // ── PAPI ──
    const dep = s.depRwy;
    const arr = s.arrRwy;
    const sameRwy = !!dep && !!arr && dep.apIdx === arr.apIdx && dep.rwyId === arr.rwyId && dep.endIdx === arr.endIdx;
    setPapi(0, arr && Math.hypot(arr.thrX - cwx, arr.thrY - cwy) < AIRPORT_RANGE ? arr : null, 0);
    setPapi(1, dep && !sameRwy && Math.hypot(dep.thrX - cwx, dep.thrY - cwy) < AIRPORT_RANGE ? dep : null, 0);
    papiPosAttr.needsUpdate = true;
    papiColAttr.needsUpdate = true;
    papiDirAttr.needsUpdate = true;
    papiSizeAttr.needsUpdate = true;

    // ── guidance ──
    const guide = !!s.cfg.assists && s.cfg.assists.guidance;
    if (guide) rebuildTaxi(s);
    const taxiOn = guide && !!s.taxi && s.taxi.pts.length >= 2;
    taxiMesh.visible = taxiOn;
    holdMesh.visible = taxiOn && !!s.taxi && !!s.taxi.hold;
    if (taxiOn) {
      taxiMesh.position.set(taxiSig.x0 - cwx, taxiSig.elev - cwz, -(taxiSig.y0 - cwy));
      if (s.taxi && s.taxi.hold) holdMesh.position.set(s.taxi.hold[0] - cwx, taxiSig.elev - cwz, -(s.taxi.hold[1] - cwy));
    }
    const hoopsOn = guide && !!arr && !ac.onGround && Math.hypot(arr.thrX - cwx, arr.thrY - cwy) < 60000;
    hoopMesh.visible = hoopsOn;
    if (hoopsOn) {
      rebuildHoops(arr);
      const hx = Math.sin(arr.hdg * DEG);
      const hy = Math.cos(arr.hdg * DEG);
      hoopMesh.position.set(arr.thrX + hx * arr.aim - cwx, arr.elev - cwz, -(arr.thrY + hy * arr.aim - cwy));
    }
    const wp = guide && !ac.onGround && s.route ? s.route[s.leg] : undefined;
    wpPillar.visible = wpRing.visible = wpLabel.visible = !!wp;
    if (wp) {
      const dx = wp.x - cwx;
      const dy = wp.y - cwy;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const k = Math.min(1, 150000 / dist); // keep very distant fixes inside the far plane
      const px = dx * k;
      const pz = -dy * k;
      const dd = dist * k;
      const base = nearestElev(s.airports, wp.x, wp.y);
      const altM = wp.alt != null ? wp.alt * FT : ac.z;
      const wdt = Math.max(12, dd * 0.004);
      wpPillar.position.set(px, (base - cwz) * k, pz);
      wpPillar.scale.set(wdt, Math.max(600, Math.max(altM, ac.z) + 900 - base) * k, wdt);
      const rr = Math.max(60, dd * 0.022);
      wpRing.position.set(px, (altM - cwz) * k, pz);
      wpRing.scale.set(rr, rr, rr);
      wpLabel.position.set(px, (altM - cwz) * k + rr * 1.3, pz);
      const sH = 0.05 * 2 * Math.tan((curFov * DEG) / 2);
      wpLabel.scale.set(sH * 6, sH, 1);
      if (now - wpTextT > 500 || wp.name !== wpText) {
        const distAc = Math.hypot(wp.x - ac.x, wp.y - ac.y) / NM;
        const txt = wp.name + '  ' + (distAc >= 100 ? distAc.toFixed(0) : distAc.toFixed(1)) + ' NM' + (wp.alt != null ? '  ' + Math.round(wp.alt) + ' ft' : '');
        wpText = wp.name;
        wpTextT = now;
        wpCtx.clearRect(0, 0, 384, 64);
        wpCtx.font = 'bold 34px ui-monospace, Menlo, Consolas, monospace';
        wpCtx.textAlign = 'center';
        wpCtx.textBaseline = 'middle';
        wpCtx.lineWidth = 6;
        wpCtx.strokeStyle = 'rgba(10,0,14,0.85)';
        wpCtx.strokeText(txt, 192, 34, 372);
        wpCtx.fillStyle = '#ff7cf0';
        wpCtx.fillText(txt, 192, 34, 372);
        wpTex.needsUpdate = true;
      }
    }

    // ── own aircraft ──
    const rpm = s.eng && s.eng[0] ? (kind === 'c172' ? s.eng[0].rpm : 0) : 0;
    propAngle = (propAngle + (rpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
    const ext = mode !== 'cockpit';
    acGroup.visible = ext;
    cowlGroup.visible = !ext && kind === 'c172';
    if (ext) {
      acGroup.position.set(ac.x - cwx, ac.z - cwz, -(ac.y - cwy));
      acGroup.quaternion.copy(qAc);
      if (gearMesh && model) {
        const g = clamp(ac.gear, 0, 1);
        gearMesh.visible = g > 0.03;
        gearMesh.scale.y = Math.max(0.03, g);
        gearMesh.position.y = model.gearTop * (1 - g);
      }
      if (extProp) {
        extProp.grp.rotation.z = propAngle;
        extProp.blades.visible = rpm < 500;
        extProp.disc.visible = rpm >= 250;
      }
      // exterior lights
      const powered = !s.sys || s.sys.bus;
      const sw = s.sw || {};
      const tt = now * 0.001;
      const strobe = tt % 1.2 < 0.07 || (tt % 1.2 > 0.18 && tt % 1.2 < 0.24);
      const beacon = (tt + 0.5) % 1.3 < 0.16;
      const nav = swOn(sw, 'ltNav', powered, true);
      const bcn = swOn(sw, 'ltBeacon', powered, true) && beacon;
      const stb = swOn(sw, 'ltStrobe', powered, !ac.onGround) && strobe;
      const ldg = swOn(sw, 'ltLanding', powered, false);
      acFlags[0] = acFlags[1] = acFlags[2] = nav;
      acFlags[3] = bcn;
      acFlags[4] = bcn && kind === 'jet';
      acFlags[5] = acFlags[6] = stb;
      acFlags[7] = ldg;
      acFlags[8] = ldg && kind === 'jet';
      acFlags[9] = swOn(sw, 'ltTaxi', powered, false) && (kind === 'c172' || ac.gear > 0.9);
      for (let i = 0; i < AC_L; i++) {
        acLSize[i * 2] = acFlags[i] ? acLBase[i] : 0;
        acLSize[i * 2 + 1] = acLRange[i];
      }
      acLSizeAttr.needsUpdate = true;
      acLightMat.u.uGain.value = 1;
    } else if (cowlGroup.visible && cowlProp) {
      cowlGroup.quaternion.copy(qAc);
      cowlProp.grp.rotation.z = propAngle;
      cowlProp.blades.visible = rpm < 500;
      cowlProp.disc.visible = rpm >= 250;
    }
    // shadow blob on the ground under the aircraft
    const shA = (1 - clamp(ac.agl / 350, 0, 1)) * (0.12 + 0.3 * day) * (1 - 0.5 * under);
    shadow.visible = shA > 0.01 && ext;
    if (shadow.visible) {
      shadowMat.opacity = shA;
      const spread = 1 + ac.agl * 0.01;
      shadow.position.set(ac.x - cwx, acGround - cwz + 0.03, -(ac.y - cwy));
      shadow.rotation.y = -ac.hdg * DEG;
      shadow.scale.set(def.span * 0.9 * spread, 1, def.length * 0.9 * spread);
    }

    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onCtx);
      for (const v of apVis) dropAirport(v);
      apVis.length = 0;
      if (bodyMesh) bodyMesh.geometry.dispose();
      if (gearMesh) gearMesh.geometry.dispose();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

// ───────────────────────────── React component ─────────────────────────────

export default function PilotView3D(props: { getState: () => PilotState; cam: PilotCam; mouseYoke: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const getRef = useRef(props.getState);
  const camRef = useRef(props.cam);
  const yokeRef = useRef(props.mouseYoke);
  getRef.current = props.getState;
  camRef.current = props.cam;
  yokeRef.current = props.mouseYoke;
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let engine: Engine | null = null;
    try {
      engine = createEngine(
        el,
        () => getRef.current(),
        () => camRef.current,
        () => yokeRef.current,
      );
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
      el.querySelectorAll('canvas').forEach((c) => c.remove());
    }
    return () => {
      if (engine) engine.dispose();
    };
  }, []);

  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden" style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#0b1220' }}>
      {failed != null && (
        <div
          className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-slate-300"
          style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: '#cbd5e1' }}
        >
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>3D outside view unavailable</div>
            <div>This browser could not create a WebGL context, so the out-the-window view cannot be drawn. The instruments and the rest of the flight deck still work.</div>
            <div style={{ opacity: 0.6, marginTop: 6, fontSize: 11 }}>{failed}</div>
          </div>
        </div>
      )}
    </div>
  );
}
