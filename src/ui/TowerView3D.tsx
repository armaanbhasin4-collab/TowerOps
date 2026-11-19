/**
 * Optional 3D tower view. Renders the SAME simulation state as the 2D views: every frame the
 * aircraft transforms are read straight from `sim.s.aircraft`; nothing is simulated here.
 *
 * World → three.js mapping: X = x (east), Z = -y (north is -Z), Y = up (alt ft × 0.3048).
 * An aircraft heading h points along (sin h, 0, -cos h)  ⇒  rotation.y = -h.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import * as THREE from 'three';
import type { Sim } from '../sim/sim';
import type { Aircraft, Airport, Precip } from '../sim/types';
import { isAirborne } from '../sim/world';
import { typeOf } from '../sim/data/aircraft';
import { airlineOf } from '../sim/data/airlines';

export type TowerCam = 'tower' | 'overview' | 'follow' | 'runway' | 'terminal';

const DEG = Math.PI / 180;
const FT = 0.3048;
const TOWER_H = 85;
const LABEL_RANGE = 9000; // m – callsign labels hidden beyond this (unless selected)
const MAX_LIGHT_AC = 256;
const PRECIP_N = 3000;

const CAMS: { id: TowerCam; label: string; help: string }[] = [
  { id: 'tower', label: 'Control Tower', help: 'Drag: look around · Wheel: zoom · Click aircraft: select' },
  { id: 'overview', label: 'Airport Overview', help: 'Drag: orbit · Wheel: distance · Right/Shift-drag: pan' },
  { id: 'follow', label: 'Aircraft Follow', help: 'Drag: orbit aircraft · Wheel: distance' },
  { id: 'runway', label: 'Runway View', help: 'Drag / arrow keys: look · Wheel: zoom' },
  { id: 'terminal', label: 'Terminal View', help: 'Drag / arrow keys: rotate · Wheel: zoom' },
];

const SKY: Record<Precip, { bg: number; amb: number; sun: number }> = {
  none: { bg: 0x0d1726, amb: 0.85, sun: 1.25 },
  rain: { bg: 0x131922, amb: 0.7, sun: 0.55 },
  heavy_rain: { bg: 0x0d1117, amb: 0.6, sun: 0.35 },
  thunderstorm: { bg: 0x0a0d13, amb: 0.55, sun: 0.28 },
  snow: { bg: 0x282d35, amb: 0.9, sun: 0.45 },
  fog: { bg: 0x232931, amb: 0.8, sun: 0.35 },
};

// ───────────────────────────── geometry helpers ─────────────────────────────

/** Push a flat quad strip from (ax,ay) to (bx,by) (world coords) of width w at height h (two triangles). */
function pushStrip(out: number[], ax: number, ay: number, bx: number, by: number, w: number, h: number, extend = 0) {
  let dx = bx - ax;
  let dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  dx /= len;
  dy /= len;
  ax -= dx * extend;
  ay -= dy * extend;
  bx += dx * extend;
  by += dy * extend;
  const nx = (-dy * w) / 2;
  const ny = (dx * w) / 2;
  // corners in three coords (x, h, -y)
  const p = [ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny];
  const idx = [0, 1, 2, 0, 2, 3];
  for (const i of idx) out.push(p[i * 2], h, -p[i * 2 + 1]);
}

function flatGeometry(pos: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** Merge primitive geometries into one non-indexed geometry with per-vertex colours. Disposes the inputs. */
function mergeColored(parts: { geo: THREE.BufferGeometry; color: THREE.Color }[]): THREE.BufferGeometry {
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
    const c = parts[i].color;
    const gp = g.getAttribute('position');
    const gn = g.getAttribute('normal');
    for (let v = 0; v < gp.count; v++, o += 3) {
      pos[o] = gp.getX(v);
      pos[o + 1] = gp.getY(v);
      pos[o + 2] = gp.getZ(v);
      nor[o] = gn.getX(v);
      nor[o + 1] = gn.getY(v);
      nor[o + 2] = gn.getZ(v);
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

/** Symmetric swept lifting surface (both sides), planform in the XZ plane, top surface at y. */
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
  g.rotateX(Math.PI / 2); // (x, y, z) → (x, -z, y): shape-y becomes world z, thickness goes down
  g.translate(0, y, 0);
  return g;
}

/** Low-poly airliner, nose toward -Z, wheels on y = 0, origin under the fuselage centre. */
function buildAirliner(typeId: string, airlineId: string): THREE.BufferGeometry {
  const t = typeOf(typeId);
  const al = airlineOf(airlineId);
  const L = t.length;
  const S = t.span;
  const r = Math.min(3.4, Math.max(1.1, L * 0.052));
  const cy = r * 1.75;
  const cFus = new THREE.Color(al.color);
  const cTail = new THREE.Color(al.tail);
  const cAcc = new THREE.Color(al.accent);
  const cWing = new THREE.Color(0xb9c0c9);
  const cDark = new THREE.Color(0x1a1f26);
  const cEng = new THREE.Color(0x8d96a1);
  const parts: { geo: THREE.BufferGeometry; color: THREE.Color }[] = [];

  // fuselage
  parts.push({ geo: new THREE.CapsuleGeometry(r, Math.max(1, L - 2 * r), 5, 12).rotateX(Math.PI / 2).translate(0, cy, 0), color: cFus });
  // tail cone (tapers upward toward the fin)
  parts.push({ geo: new THREE.CylinderGeometry(r * 0.25, r * 0.97, L * 0.16, 10).rotateX(Math.PI / 2).translate(0, cy + r * 0.35, L / 2 - L * 0.05), color: cFus });
  // cheat line
  parts.push({ geo: new THREE.BoxGeometry(r * 2.03, r * 0.16, L * 0.66).translate(0, cy - r * 0.05, -L * 0.02), color: cAcc });
  // cockpit glazing
  parts.push({ geo: new THREE.BoxGeometry(r * 1.25, r * 0.3, r * 0.55).translate(0, cy + r * 0.42, -L / 2 + r * 0.8), color: cDark });
  // wings
  const zr0 = -L * 0.12;
  const sweep = S * 0.26;
  const wingY = cy - r * 0.45;
  parts.push({ geo: sweptSurface(S, zr0, L * 0.2, sweep, L * 0.055, Math.max(0.3, r * 0.2), wingY), color: cWing });
  // tailplane
  parts.push({ geo: sweptSurface(S * 0.36, L / 2 - L * 0.17, L * 0.1, S * 0.11, L * 0.04, Math.max(0.2, r * 0.12), cy + r * 0.3), color: cWing });
  // vertical fin (shape in (z, y), extruded along x)
  const fy0 = cy + r * 0.55;
  const fy1 = cy + r + L * 0.15;
  const fin = new THREE.Shape([
    new THREE.Vector2(L / 2 - L * 0.21, fy0),
    new THREE.Vector2(L / 2 - L * 0.02, fy0),
    new THREE.Vector2(L / 2 + L * 0.005, fy1),
    new THREE.Vector2(L / 2 - L * 0.065, fy1),
  ]);
  const finT = Math.max(0.3, r * 0.2);
  parts.push({ geo: new THREE.ExtrudeGeometry(fin, { depth: finT, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(finT / 2, 0, 0), color: cTail });
  // engines
  const re = r * 0.55;
  const le = Math.max(2.6, L * 0.1);
  const ks = t.engines >= 4 ? [0.3, 0.6] : t.engines >= 2 ? [0.32] : [];
  for (const k of ks) {
    for (const side of [-1, 1]) {
      const g = new THREE.CylinderGeometry(re, re * 0.8, le, 10).rotateX(-Math.PI / 2);
      g.translate(side * k * (S / 2), wingY - re * 0.95, zr0 + sweep * k - le * 0.15);
      parts.push({ geo: g, color: cEng });
    }
  }
  if (ks.length === 0) {
    // single-engine GA: nose spinner
    parts.push({ geo: new THREE.CylinderGeometry(r * 0.5, r * 0.8, r, 8).rotateX(-Math.PI / 2).translate(0, cy, -L / 2), color: cEng });
  }
  // landing gear
  const gw = Math.max(0.35, r * 0.28);
  parts.push({ geo: new THREE.BoxGeometry(gw, cy - r * 0.8, gw).translate(0, (cy - r * 0.8) / 2, -L / 2 + L * 0.13), color: cDark });
  for (const side of [-1, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(gw * 1.6, wingY, gw * 2.2).translate(side * Math.max(r * 1.3, S * 0.085), wingY / 2, L * 0.04), color: cDark });
  }
  return mergeColored(parts);
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d') as CanvasRenderingContext2D];
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, fg: string, border: string, bg: string) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = `bold ${Math.round(h * 0.56)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = Math.min(w - 16, ctx.measureText(text).width + 22);
  const x0 = (w - tw) / 2;
  ctx.fillStyle = bg;
  ctx.strokeStyle = border;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.rect(x0, 5, tw, h - 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.fillText(text, w / 2, h / 2 + 2, w - 24);
}

function pointInPoly(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToPoly(x: number, y: number, poly: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

function polyCentroid(poly: [number, number][]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f;
    cx += (poly[j][0] + poly[i][0]) * f;
    cy += (poly[j][1] + poly[i][1]) * f;
  }
  if (Math.abs(a) < 1e-6) return poly[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

function polyArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

// ───────────────────────────── engine ─────────────────────────────

interface AcVis {
  id: number;
  key: string; // type|airline
  root: THREE.Group;
  body: THREE.Mesh;
  shadow: THREE.Mesh;
  label: THREE.Sprite;
  labelTex: THREE.CanvasTexture;
  labelCtx: CanvasRenderingContext2D;
  labelKey: string;
  tug: THREE.Mesh | null;
  svc: THREE.Group | null;
  len: number;
  span: number;
  top: number; // fin top height
  pitch: number;
  bank: number;
  lastHdg: number;
  lastT: number;
  wreck: boolean;
  seen: number;
}

interface LookCam {
  x: number;
  y: number;
  z: number;
  yaw: number; // deg true
  pitch: number; // deg
  fov: number;
}

interface Engine {
  dispose(): void;
}

function createEngine(
  container: HTMLDivElement,
  sim: Sim,
  getSel: () => number | null,
  getCam: () => TowerCam,
  select: (id: number | null) => void,
): Engine {
  const ap: Airport = sim.ap;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;cursor:grab';
  // throws when WebGL is unavailable – the caller shows a fallback
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  container.appendChild(canvas);

  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const scene = new THREE.Scene();
  const bgColor = new THREE.Color(SKY.none.bg);
  const bgTarget = new THREE.Color(SKY.none.bg);
  const tmpColor = new THREE.Color();
  scene.background = bgColor;
  const fog = new THREE.FogExp2(SKY.none.bg, 0.00003);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(50, 1, 3, 120000);
  const ambient = new THREE.HemisphereLight(0xcfe0ff, 0x1a2420, 0.85);
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.25);
  sun.position.set(-0.5, 1, 0.65);
  scene.add(ambient, sun);

  // ── airport extent ──
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of ap.runways) {
    for (const e of r.ends) {
      minX = Math.min(minX, e.x);
      maxX = Math.max(maxX, e.x);
      minY = Math.min(minY, e.y);
      maxY = Math.max(maxY, e.y);
    }
  }
  for (const n of ap.nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
  }
  if (!isFinite(minX)) {
    minX = minY = -1500;
    maxX = maxY = 1500;
  }
  const cx = (minX + maxX) / 2;
  const cyW = (minY + maxY) / 2;
  const extent = Math.max(1200, Math.hypot(maxX - minX, maxY - minY));

  // ── static scene ──
  const flatMat = (color: number, order: number, map?: THREE.Texture) => {
    const m = own(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
    if (map) m.map = map;
    m.userData.order = order;
    return m;
  };
  const addFlat = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const m = new THREE.Mesh(own(geo), mat);
    m.renderOrder = (mat.userData.order as number) ?? 0;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    scene.add(m);
    return m;
  };

  {
    // grass with a faint mottled texture (gives a sense of motion for the chase camera)
    const [gc, g2] = makeCanvas(128, 128);
    g2.fillStyle = '#0c1c18';
    g2.fillRect(0, 0, 128, 128);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) & 0xffff) / 0xffff;
    for (let i = 0; i < 700; i++) {
      const v = rnd();
      g2.fillStyle = v > 0.5 ? 'rgba(40,78,60,0.09)' : 'rgba(4,10,12,0.12)';
      g2.fillRect(rnd() * 128, rnd() * 128, 2 + rnd() * 7, 2 + rnd() * 7);
    }
    const gt = own(new THREE.CanvasTexture(gc));
    gt.wrapS = gt.wrapT = THREE.RepeatWrapping;
    gt.repeat.set(240000 / 500, 240000 / 500);
    gt.colorSpace = THREE.SRGBColorSpace;
    gt.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const ground = addFlat(new THREE.PlaneGeometry(240000, 240000).rotateX(-Math.PI / 2), flatMat(0xffffff, 0, gt));
    ground.position.set(cx, 0, -cyW);
    ground.updateMatrix();
  }

  // aprons
  {
    const pos: number[] = [];
    for (const poly of ap.aprons) {
      if (poly.length < 3) continue;
      const contour = poly.map(([x, y]) => new THREE.Vector2(x, y));
      for (const tri of THREE.ShapeUtils.triangulateShape(contour, [])) for (const i of tri) pos.push(poly[i][0], 0, -poly[i][1]);
    }
    if (pos.length) addFlat(flatGeometry(pos), flatMat(0x18202c, 1));
  }

  // taxiways (merged: one pavement mesh + one centreline mesh)
  {
    const pave: number[] = [];
    const gatePave: number[] = [];
    const line: number[] = [];
    for (const e of ap.edges) {
      if (e.kind === 'runway') continue;
      const a = ap.nodes[e.a];
      const b = ap.nodes[e.b];
      if (!a || !b) continue;
      if (e.kind === 'gate') {
        pushStrip(gatePave, a.x, a.y, b.x, b.y, 7, 0, 2);
        pushStrip(line, a.x, a.y, b.x, b.y, 0.5, 0);
      } else {
        const w = e.kind === 'apron' ? 18 : 22;
        pushStrip(pave, a.x, a.y, b.x, b.y, w, 0, w * 0.45);
        pushStrip(line, a.x, a.y, b.x, b.y, 0.9, 0, 0.4);
      }
    }
    if (gatePave.length) addFlat(flatGeometry(gatePave), flatMat(0x1d2633, 2));
    if (pave.length) addFlat(flatGeometry(pave), flatMat(0x232c3a, 3));
    if (line.length) addFlat(flatGeometry(line), flatMat(0xc8a21e, 4));
  }

  // runways + markings + number labels + lights
  {
    const asphalt: number[] = [];
    const paint: number[] = [];
    const lightPos: number[] = [];
    const lightCol: number[] = [];
    const light = (x: number, y: number, h: number, r: number, g: number, b: number) => {
      lightPos.push(x, h, -y);
      lightCol.push(r, g, b);
    };
    const numTex = new Map<string, THREE.Texture>();
    for (const r of ap.runways) {
      const [e0, e1] = r.ends;
      const len = Math.hypot(e1.x - e0.x, e1.y - e0.y);
      if (len < 1) continue;
      const ux = (e1.x - e0.x) / len;
      const uy = (e1.y - e0.y) / len;
      const px = uy; // right-hand perpendicular (when moving e0 → e1)
      const py = -ux;
      const w = r.width;
      pushStrip(asphalt, e0.x, e0.y, e1.x, e1.y, w + 8, 0, 60);
      // side stripes
      for (const s of [-1, 1]) {
        const o = s * (w / 2 - 1);
        pushStrip(paint, e0.x + px * o, e0.y + py * o, e1.x + px * o, e1.y + py * o, 0.9, 0);
      }
      // centreline dashes
      for (let d = 150; d < len - 150; d += 60) {
        pushStrip(paint, e0.x + ux * d, e0.y + uy * d, e0.x + ux * (d + 30), e0.y + uy * (d + 30), 1.2, 0);
      }
      for (let k = 0; k < 2; k++) {
        const e = r.ends[k];
        const dx = k === 0 ? ux : -ux; // direction of landing from this end
        const dy = k === 0 ? uy : -uy;
        const rx = dy; // pilot's right
        const ry = -dx;
        // threshold bar + piano keys
        pushStrip(paint, e.x + rx * (w / 2 - 1), e.y + ry * (w / 2 - 1), e.x - rx * (w / 2 - 1), e.y - ry * (w / 2 - 1), 2, 0);
        const keys = 6;
        for (let i = 0; i < keys; i++) {
          for (const s of [-1, 1]) {
            const o = s * (3 + (i + 0.5) * ((w / 2 - 5) / keys));
            pushStrip(paint, e.x + dx * 6 + rx * o, e.y + dy * 6 + ry * o, e.x + dx * 36 + rx * o, e.y + dy * 36 + ry * o, 1.8, 0);
          }
        }
        // aiming point blocks
        if (len > 1500) {
          for (const s of [-1, 1]) {
            const o = s * w * 0.24;
            pushStrip(paint, e.x + dx * 300 + rx * o, e.y + dy * 300 + ry * o, e.x + dx * 345 + rx * o, e.y + dy * 345 + ry * o, w * 0.14, 0);
          }
        }
        // runway designator: flat plane that reads upright to a pilot landing from this end
        let tex = numTex.get(e.name);
        if (!tex) {
          const [c, g] = makeCanvas(128, 192);
          const m = /^(\d+)([LRC]?)$/.exec(e.name);
          g.fillStyle = '#e4e8ec';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.font = 'bold 96px Arial, Helvetica, sans-serif';
          if (m && m[2]) {
            g.fillText(m[1], 64, 58, 120);
            g.font = 'bold 84px Arial, Helvetica, sans-serif';
            g.fillText(m[2], 64, 146, 120);
          } else {
            g.fillText(m ? m[1] : e.name, 64, 96, 120);
          }
          tex = own(new THREE.CanvasTexture(c));
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
          numTex.set(e.name, tex);
        }
        const nw = w * 0.5;
        const nh = nw * 1.5;
        const ccx = e.x + dx * (48 + nh / 2);
        const ccy = e.y + dy * (48 + nh / 2);
        const corner = (u: number, v: number) => [ccx + rx * u * (nw / 2) + dx * v * (nh / 2), 0, -(ccy + ry * u * (nw / 2) + dy * v * (nh / 2))];
        const quad = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, -1],
          [1, 1],
          [-1, 1],
        ];
        const np: number[] = [];
        const nuv: number[] = [];
        for (const [u, v] of quad) {
          np.push(...corner(u, v));
          nuv.push((u + 1) / 2, (v + 1) / 2);
        }
        const ng = flatGeometry(np);
        ng.setAttribute('uv', new THREE.Float32BufferAttribute(nuv, 2));
        const nm = own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
        nm.userData.order = 7;
        addFlat(ng, nm);
        // threshold (green) + approach lights
        for (let i = 0; i <= 8; i++) {
          const o = -w / 2 + (w * i) / 8;
          light(e.x + rx * o - dx * 2, e.y + ry * o - dy * 2, 0.6, 0.15, 1, 0.35);
        }
        if (e.ils) {
          for (let d = 60; d <= 720; d += 60) light(e.x - dx * d, e.y - dy * d, 1.5, 1, 0.95, 0.8);
          for (const o of [-18, -9, 9, 18]) light(e.x - dx * 300 + rx * o, e.y - dy * 300 + ry * o, 1.5, 1, 0.95, 0.8);
        }
      }
      // edge lights
      for (let d = 0; d <= len; d += 60) {
        for (const s of [-1, 1]) {
          const o = s * (w / 2 + 2);
          light(e0.x + ux * d + px * o, e0.y + uy * d + py * o, 0.6, 1, 0.97, 0.85);
        }
      }
    }
    // tower obstruction light
    light(ap.towerPos[0], ap.towerPos[1], TOWER_H + 7, 1, 0.1, 0.1);
    if (asphalt.length) addFlat(flatGeometry(asphalt), flatMat(0x12151a, 5));
    if (paint.length) addFlat(flatGeometry(paint), flatMat(0xd9dee4, 6));
    if (lightPos.length) {
      const lg = own(new THREE.BufferGeometry());
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lightPos, 3));
      lg.setAttribute('color', new THREE.Float32BufferAttribute(lightCol, 3));
      const lm = own(new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
      const pts = new THREE.Points(lg, lm);
      pts.frustumCulled = false;
      pts.renderOrder = 12;
      scene.add(pts);
    }
  }

  // terminals
  const termLabels: THREE.Sprite[] = [];
  {
    const [wc, wg] = makeCanvas(64, 64);
    wg.fillStyle = '#141d29';
    wg.fillRect(0, 0, 64, 64);
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) & 0xffff) / 0xffff;
    for (let row = 0; row < 3; row++) {
      for (let c = 0; c < 8; c++) {
        const v = rnd();
        wg.fillStyle = v > 0.78 ? '#6fb6d2' : v > 0.4 ? '#2f6580' : '#1b3344';
        wg.fillRect(c * 8 + 1, 8 + row * 19, 6, 11);
      }
    }
    const wt = own(new THREE.CanvasTexture(wc));
    wt.wrapS = THREE.RepeatWrapping;
    wt.colorSpace = THREE.SRGBColorSpace;
    const bodyMat = own(new THREE.MeshLambertMaterial({ color: 0x2b3646, emissive: 0x0b2230, emissiveIntensity: 0.9 }));
    const wallMat = own(new THREE.MeshBasicMaterial({ map: wt, side: THREE.DoubleSide }));
    const wp: number[] = [];
    const wuv: number[] = [];
    ap.terminals.forEach((t, i) => {
      if (t.poly.length < 3) return;
      const h = 15 + ((i * 7) % 10);
      const shape = new THREE.Shape(t.poly.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = own(new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false }));
      g.rotateX(-Math.PI / 2); // (x, y, z) → (x, z, -y)
      const m = new THREE.Mesh(g, bodyMat);
      m.renderOrder = 10;
      m.matrixAutoUpdate = false;
      scene.add(m);
      // window bands just outside each wall
      const ccw = polyArea(t.poly) > 0 ? 1 : -1;
      for (let a = 0; a < t.poly.length; a++) {
        const [ax, ay] = t.poly[a];
        const [bx, by] = t.poly[(a + 1) % t.poly.length];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 4) continue;
        const ox = (((by - ay) / len) * 0.35) * ccw;
        const oy = ((-(bx - ax) / len) * 0.35) * ccw;
        const y0 = 2.5;
        const y1 = h - 1.5;
        const u1 = Math.max(1, Math.round(len / 24));
        const A = [ax + ox, -(ay + oy)];
        const B = [bx + ox, -(by + oy)];
        wp.push(A[0], y0, A[1], B[0], y0, B[1], B[0], y1, B[1], A[0], y0, A[1], B[0], y1, B[1], A[0], y1, A[1]);
        wuv.push(0, 0, u1, 0, u1, 1, 0, 0, u1, 1, 0, 1);
      }
      // name label
      const [lc, lg] = makeCanvas(256, 48);
      drawLabel(lg, t.name.toUpperCase(), '#9fb4c8', 'rgba(120,150,180,0.35)', 'rgba(8,14,22,0.55)');
      const lt = own(new THREE.CanvasTexture(lc));
      lt.colorSpace = THREE.SRGBColorSpace;
      const sm = own(new THREE.SpriteMaterial({ map: lt, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
      const sp = new THREE.Sprite(sm);
      sp.center.set(0.5, 0);
      sp.position.set(t.label[0], h + 6, -t.label[1]);
      sp.renderOrder = 19;
      scene.add(sp);
      termLabels.push(sp);
    });
    if (wp.length) {
      const wgeo = own(flatGeometry(wp));
      wgeo.setAttribute('uv', new THREE.Float32BufferAttribute(wuv, 2));
      const wm = new THREE.Mesh(wgeo, wallMat);
      wm.renderOrder = 10;
      wm.matrixAutoUpdate = false;
      scene.add(wm);
    }
  }

  // control tower
  const tower = new THREE.Group();
  {
    const shaftMat = own(new THREE.MeshLambertMaterial({ color: 0x4a5564 }));
    const cabMat = own(new THREE.MeshLambertMaterial({ color: 0x1d3b46, emissive: 0x1a6f86, emissiveIntensity: 0.7 }));
    const shaft = new THREE.Mesh(own(new THREE.CylinderGeometry(4, 6, TOWER_H - 12, 12).translate(0, (TOWER_H - 12) / 2, 0)), shaftMat);
    const collar = new THREE.Mesh(own(new THREE.CylinderGeometry(9, 5, 5, 12).translate(0, TOWER_H - 9.5, 0)), shaftMat);
    const cab = new THREE.Mesh(own(new THREE.CylinderGeometry(10.5, 8.5, 7, 12).translate(0, TOWER_H - 3.5, 0)), cabMat);
    const roof = new THREE.Mesh(own(new THREE.CylinderGeometry(3, 11, 2.5, 12).translate(0, TOWER_H + 1.25, 0)), shaftMat);
    const mast = new THREE.Mesh(own(new THREE.CylinderGeometry(0.3, 0.3, 5, 6).translate(0, TOWER_H + 4.5, 0)), shaftMat);
    tower.add(shaft, collar, cab, roof, mast);
    tower.position.set(ap.towerPos[0], 0, -ap.towerPos[1]);
    for (const c of tower.children) c.renderOrder = 10;
    scene.add(tower);
  }

  // ── shared aircraft resources ──
  const acGeo = new Map<string, THREE.BufferGeometry>();
  const acMat = own(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const wreckMat = own(new THREE.MeshLambertMaterial({ color: 0x17181a }));
  const shadowGeo = own(new THREE.CircleGeometry(0.5, 20).rotateX(-Math.PI / 2));
  const shadowMat = own(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false }));
  const tugGeo = own(new THREE.BoxGeometry(2.6, 1.6, 5).translate(0, 0.9, 0));
  const tugMat = own(new THREE.MeshLambertMaterial({ color: 0xe0b020, emissive: 0x4a3800 }));
  const svcGeo = own(new THREE.BoxGeometry(2.4, 2.4, 6).translate(0, 1.3, 0));
  const svcMatA = own(new THREE.MeshLambertMaterial({ color: 0xd8dde3, emissive: 0x20262c }));
  const svcMatB = own(new THREE.MeshLambertMaterial({ color: 0xd9772a, emissive: 0x3a1c06 }));
  const acVis = new Map<number, AcVis>();
  const acRoot = new THREE.Group();
  scene.add(acRoot);

  // aircraft lights: beacon + 2 nav lights per aircraft, single draw call
  const lightGeo = own(new THREE.BufferGeometry());
  const lightPosArr = new Float32Array(MAX_LIGHT_AC * 9);
  const lightColArr = new Float32Array(MAX_LIGHT_AC * 9);
  for (let i = 0; i < MAX_LIGHT_AC; i++) {
    lightColArr.set([1, 0.08, 0.05, 1, 0.1, 0.1, 0.1, 1, 0.25], i * 9);
  }
  const lightPosAttr = new THREE.BufferAttribute(lightPosArr, 3);
  lightPosAttr.setUsage(THREE.DynamicDrawUsage);
  lightGeo.setAttribute('position', lightPosAttr);
  lightGeo.setAttribute('color', new THREE.BufferAttribute(lightColArr, 3));
  const acLights = new THREE.Points(lightGeo, own(new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true })));
  acLights.frustumCulled = false;
  acLights.renderOrder = 13;
  scene.add(acLights);

  // selection marker
  const selRing = new THREE.Mesh(
    own(new THREE.RingGeometry(0.93, 1, 64).rotateX(-Math.PI / 2)),
    own(new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide })),
  );
  selRing.renderOrder = 9;
  selRing.visible = false;
  const selLine = new THREE.Line(
    own(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)])),
    own(new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.75, depthWrite: false })),
  );
  selLine.renderOrder = 14;
  selLine.visible = false;
  selLine.frustumCulled = false;
  scene.add(selRing, selLine);

  // precipitation
  const precipRel = new Float32Array(PRECIP_N * 3);
  const PR = 140; // half-size of the particle box around the camera
  for (let i = 0; i < PRECIP_N * 3; i++) precipRel[i] = (Math.random() * 2 - 1) * PR;
  const rainArr = new Float32Array(PRECIP_N * 6);
  const rainAttr = new THREE.BufferAttribute(rainArr, 3);
  rainAttr.setUsage(THREE.DynamicDrawUsage);
  const rainGeo = own(new THREE.BufferGeometry());
  rainGeo.setAttribute('position', rainAttr);
  const rain = new THREE.LineSegments(rainGeo, own(new THREE.LineBasicMaterial({ color: 0x9db4cc, transparent: true, opacity: 0.4, depthWrite: false, fog: false })));
  const snowAttr = new THREE.BufferAttribute(precipRel, 3);
  snowAttr.setUsage(THREE.DynamicDrawUsage);
  const snowGeo = own(new THREE.BufferGeometry());
  snowGeo.setAttribute('position', snowAttr);
  const snow = new THREE.Points(snowGeo, own(new THREE.PointsMaterial({ color: 0xe8eef5, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0.8, depthWrite: false, fog: false })));
  rain.frustumCulled = snow.frustumCulled = false;
  rain.visible = snow.visible = false;
  rain.renderOrder = snow.renderOrder = 15;
  scene.add(rain, snow);
  const lastCamPos = new THREE.Vector3();

  // ── cameras ──
  const look: Record<'tower' | 'runway' | 'terminal', LookCam> = {
    tower: {
      x: ap.towerPos[0],
      y: TOWER_H,
      z: -ap.towerPos[1],
      yaw: (Math.atan2(cx - ap.towerPos[0], cyW - ap.towerPos[1]) / DEG + 360) % 360,
      pitch: -6,
      fov: 55,
    },
    runway: { x: 0, y: 30, z: 0, yaw: 0, pitch: -3, fov: 50 },
    terminal: { x: 0, y: 28, z: 0, yaw: 0, pitch: -7, fov: 62 },
  };
  // tower: if the tower sits at the airport centre, fall back to looking at the first runway
  if (Math.hypot(cx - ap.towerPos[0], cyW - ap.towerPos[1]) < 50 && ap.runways[0]) {
    const e = ap.runways[0].ends[0];
    look.tower.yaw = (Math.atan2(e.x - ap.towerPos[0], e.y - ap.towerPos[1]) / DEG + 360) % 360;
  }
  // terminal view: over the (largest) apron centroid, nudged clear of terminal buildings
  {
    let best: [number, number][] | null = null;
    for (const p of ap.aprons) if (p.length >= 3 && (!best || Math.abs(polyArea(p)) > Math.abs(polyArea(best)))) best = p;
    let [tx, ty] = best ? polyCentroid(best) : [cx, cyW];
    if (!best && ap.gates.length) {
      tx = ty = 0;
      for (const g of ap.gates) {
        tx += ap.nodes[g.lane]?.x ?? 0;
        ty += ap.nodes[g.lane]?.y ?? 0;
      }
      tx /= ap.gates.length;
      ty /= ap.gates.length;
    }
    const clear = (x: number, y: number) => {
      let d = Infinity;
      for (const t of ap.terminals) {
        if (t.poly.length < 3) continue;
        if (pointInPoly(x, y, t.poly)) return -1;
        d = Math.min(d, distToPoly(x, y, t.poly));
      }
      return d;
    };
    if (clear(tx, ty) < 60) {
      search: for (let rad = 40; rad <= 400; rad += 40) {
        for (let a = 0; a < 360; a += 30) {
          const x = tx + Math.sin(a * DEG) * rad;
          const y = ty + Math.cos(a * DEG) * rad;
          if (clear(x, y) >= 60) {
            tx = x;
            ty = y;
            break search;
          }
        }
      }
    }
    look.terminal.x = tx;
    look.terminal.z = -ty;
    // look along the most open direction (down the alley between concourses, gates on both sides);
    // with no obstruction at all, face the nearest terminal
    let bestFree = -1;
    let anyBlocked = false;
    for (let a = 0; a < 360; a += 15) {
      let free = 0;
      for (let d = 30; d <= 900; d += 30) {
        if (clear(tx + Math.sin(a * DEG) * d, ty + Math.cos(a * DEG) * d) < 25) {
          anyBlocked = true;
          break;
        }
        free = d;
      }
      // prefer directions that stay over the apron
      if (best && !pointInPoly(tx + Math.sin(a * DEG) * free, ty + Math.cos(a * DEG) * free, best)) free *= 0.5;
      if (free > bestFree) {
        bestFree = free;
        look.terminal.yaw = a;
      }
    }
    if (!anyBlocked) {
      let bd = Infinity;
      for (const t of ap.terminals) {
        const d = Math.hypot(t.label[0] - tx, t.label[1] - ty);
        if (d < bd && d > 1) {
          bd = d;
          look.terminal.yaw = (Math.atan2(t.label[0] - tx, t.label[1] - ty) / DEG + 360) % 360;
        }
      }
    }
  }
  const orbit = { tx: cx, tz: -cyW, az: 0, el: 38 * DEG, dist: Math.min(30000, extent * 0.95) };
  const follow = { az: 0, el: 14, k: 1 };
  let rwyCamName = '';
  let effMode: TowerCam = 'overview';
  let width = 1;
  let height = 1;

  const placeRunwayCam = () => {
    const want = sim.s.activeConfig?.arr?.[0] ?? '';
    if (want === rwyCamName && rwyCamName !== '') return;
    let end = undefined as Airport['runways'][number]['ends'][number] | undefined;
    for (const r of ap.runways) for (const e of r.ends) if (e.name === want) end = e;
    if (!end) end = ap.runways[0]?.ends[0];
    rwyCamName = want || '?';
    if (!end) return;
    look.runway.x = end.x - Math.sin(end.hdg * DEG) * 400;
    look.runway.z = -(end.y - Math.cos(end.hdg * DEG) * 400);
    look.runway.y = 30;
    look.runway.yaw = end.hdg;
    look.runway.pitch = -3;
  };

  // ── input ──
  let drag: { x: number; y: number; sx: number; sy: number; moved: boolean; pan: boolean; button: number } | null = null;
  let hover = false;
  const keys = new Set<string>();
  const v3 = new THREE.Vector3();
  const v3b = new THREE.Vector3();

  const pick = (px: number, py: number): number | null => {
    let bestId: number | null = null;
    let bestScore = 1;
    const k = height / (2 * Math.tan((camera.fov * DEG) / 2));
    for (const vis of acVis.values()) {
      v3.copy(vis.root.position);
      v3.y += vis.top * 0.4;
      const d = v3.distanceTo(camera.position);
      v3.project(camera);
      if (v3.z < -1 || v3.z > 1) continue;
      const sx = (v3.x * 0.5 + 0.5) * width;
      const sy = (-v3.y * 0.5 + 0.5) * height;
      const rad = Math.max(16, (vis.len * 0.6 * k) / Math.max(1, d));
      const score = Math.hypot(sx - px, sy - py) / rad;
      if (score < bestScore) {
        bestScore = score;
        bestId = vis.id;
      }
    }
    return bestId;
  };

  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, pan: e.button === 2 || e.button === 1 || e.shiftKey, button: e.button };
    canvas.style.cursor = 'grabbing';
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
    drag.moved = true;
    if (effMode === 'overview') {
      if (drag.pan) {
        const k = (orbit.dist * 2 * Math.tan((camera.fov * DEG) / 2)) / height;
        const ca = Math.cos(orbit.az);
        const sa = Math.sin(orbit.az);
        // right = (ca, -sa), forward = (-sa, -ca) in XZ
        orbit.tx += (-ca * dx - sa * dy) * k;
        orbit.tz += (sa * dx - ca * dy) * k;
        const lim = extent * 1.5 + 20000;
        orbit.tx = Math.max(cx - lim, Math.min(cx + lim, orbit.tx));
        orbit.tz = Math.max(-cyW - lim, Math.min(-cyW + lim, orbit.tz));
      } else {
        orbit.az -= dx * 0.005;
        orbit.el = Math.max(4 * DEG, Math.min(89 * DEG, orbit.el + dy * 0.005));
      }
    } else if (effMode === 'follow') {
      follow.az -= dx * 0.3;
      follow.el = Math.max(-3, Math.min(85, follow.el + dy * 0.3));
    } else {
      const lc = look[effMode];
      const dpp = lc.fov / height;
      lc.yaw = (lc.yaw - dx * dpp + 360) % 360;
      lc.pitch = Math.max(-85, Math.min(60, lc.pitch + dy * dpp));
    }
  };
  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    canvas.style.cursor = 'grab';
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!d.moved && d.button === 0 && e.type === 'pointerup') {
      const rect = canvas.getBoundingClientRect();
      const id = pick(e.clientX - rect.left, e.clientY - rect.top);
      if (id != null) select(id); // clicking empty ground does nothing
    }
  };
  const zoom = (f: number) => {
    if (effMode === 'overview') orbit.dist = Math.max(120, Math.min(60000, orbit.dist * f));
    else if (effMode === 'follow') follow.k = Math.max(0.3, Math.min(30, follow.k * f));
    else look[effMode].fov = Math.max(15, Math.min(70, look[effMode].fov * f));
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    zoom(Math.exp(Math.max(-300, Math.min(300, dy)) * 0.0012));
  };
  const onCtx = (e: Event) => e.preventDefault();
  const onEnter = () => {
    hover = true;
  };
  const onLeave = () => {
    hover = false;
    keys.clear();
  };
  const KEYSET = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_']);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!hover || !KEYSET.has(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    keys.add(e.key);
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.key);
  };
  const onBlur = () => keys.clear();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onCtx);
  canvas.addEventListener('pointerenter', onEnter);
  canvas.addEventListener('pointerleave', onLeave);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const applyKeys = (dt: number) => {
    if (keys.size === 0) return;
    const lr = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
    const ud = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
    const zi = (keys.has('+') || keys.has('=') ? 1 : 0) - (keys.has('-') || keys.has('_') ? 1 : 0);
    if (zi) zoom(Math.exp(-zi * dt * 1.2));
    if (effMode === 'overview') {
      orbit.az += lr * dt * 0.9;
      orbit.el = Math.max(4 * DEG, Math.min(89 * DEG, orbit.el + ud * dt * 0.6));
    } else if (effMode === 'follow') {
      follow.az += lr * dt * 60;
      follow.el = Math.max(-3, Math.min(85, follow.el + ud * dt * 40));
    } else {
      const lc = look[effMode];
      lc.yaw = (lc.yaw + lr * dt * lc.fov * 0.9 + 360) % 360;
      lc.pitch = Math.max(-85, Math.min(60, lc.pitch + ud * dt * lc.fov * 0.6));
    }
  };

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

  // ── aircraft visuals ──
  const createVis = (ac: Aircraft): AcVis => {
    const key = ac.type + '|' + ac.airline;
    let geo = acGeo.get(key);
    if (!geo) {
      geo = buildAirliner(ac.type, ac.airline);
      acGeo.set(key, geo);
    }
    const t = typeOf(ac.type);
    const r = Math.min(3.4, Math.max(1.1, t.length * 0.052));
    const root = new THREE.Group();
    root.rotation.order = 'YXZ';
    const body = new THREE.Mesh(geo, acMat);
    body.rotation.order = 'YXZ';
    body.renderOrder = 10;
    root.add(body);
    const shadow = new THREE.Mesh(shadowGeo, shadowMat);
    shadow.renderOrder = 8;
    shadow.scale.set(t.span * 0.95, 1, t.length * 0.95);
    const [lc, lctx] = makeCanvas(256, 64);
    const labelTex = new THREE.CanvasTexture(lc);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true }));
    label.center.set(0.5, 0);
    label.renderOrder = 20;
    acRoot.add(root, shadow, label);
    return {
      id: ac.id, key, root, body, shadow, label, labelTex, labelCtx: lctx, labelKey: '', tug: null, svc: null,
      len: t.length, span: t.span, top: r * 2.75 + t.length * 0.15, pitch: 0, bank: 0, lastHdg: ac.hdg, lastT: sim.s.t, wreck: false, seen: 0,
    };
  };
  const removeVis = (vis: AcVis) => {
    acRoot.remove(vis.root, vis.shadow, vis.label);
    vis.labelTex.dispose();
    vis.label.material.dispose();
    acVis.delete(vis.id);
  };

  let frameNo = 0;
  let lightCount = 0;
  const stale: AcVis[] = [];

  const syncAircraft = (dt: number, now: number, selId: number | null): AcVis | null => {
    frameNo++;
    const list = sim.s.aircraft;
    const simT = sim.s.t;
    let selVis: AcVis | null = null;
    lightCount = 0;
    const labelK = (2 * Math.tan((camera.fov * DEG) / 2)) / height; // world size at distance 1 of one pixel
    const blinkBase = now * 0.001;
    for (let i = 0; i < list.length; i++) {
      const ac = list[i];
      if (ac.phase === 'gone') continue;
      let vis = acVis.get(ac.id);
      if (vis && vis.key !== ac.type + '|' + ac.airline) {
        removeVis(vis);
        vis = undefined;
      }
      if (!vis) {
        vis = createVis(ac);
        acVis.set(ac.id, vis);
      }
      vis.seen = frameNo;
      const air = isAirborne(ac);
      const wreck = ac.phase === 'crashed' || !!ac.flags?.wreck;
      const y = wreck ? 0 : Math.max(0, ac.alt) * FT;
      const x = ac.x;
      const z = -ac.y;
      vis.root.position.set(x, y, z);
      vis.root.rotation.y = -ac.hdg * DEG;

      // attitude
      let tgtPitch = 0;
      let tgtBank = 0;
      if (!wreck) {
        if (air) {
          const fpa = Math.atan2(ac.vs, Math.max(60, ac.gs) * 101.27) / DEG;
          tgtPitch = Math.max(-6, Math.min(15, fpa + 2.5));
          if (ac.phase === 'final' && ac.alt < 60) tgtPitch = 4; // flare
          const dts = simT - vis.lastT;
          if (dts > 1e-4) {
            let dh = ac.hdg - vis.lastHdg;
            dh = ((dh + 540) % 360) - 180;
            tgtBank = Math.max(-28, Math.min(28, (dh / dts) * 9));
          } else {
            tgtBank = vis.bank;
          }
        } else if (ac.phase === 'takeoff_roll' && ac.ias > typeOf(ac.type).vr - 4) {
          tgtPitch = 8;
        } else if (ac.phase === 'landing_roll' && ac.ias > 90) {
          tgtPitch = 2;
        }
      }
      vis.lastHdg = ac.hdg;
      vis.lastT = simT;
      const kS = Math.min(1, dt * 2.5);
      vis.pitch += (tgtPitch - vis.pitch) * kS;
      vis.bank += (tgtBank - vis.bank) * kS;
      if (wreck) {
        vis.body.rotation.set(-0.06, 0, 0.2);
        vis.body.position.y = -vis.top * 0.12;
      } else {
        vis.body.rotation.set(vis.pitch * DEG, 0, -vis.bank * DEG);
        vis.body.position.y = 0;
      }
      if (wreck !== vis.wreck) {
        vis.wreck = wreck;
        vis.body.material = wreck ? wreckMat : acMat;
      }

      // blob shadow
      vis.shadow.position.set(x, 0.05, z);
      vis.shadow.rotation.y = -ac.hdg * DEG;
      vis.shadow.visible = y < 1500;

      // pushback tug
      const wantTug = ac.phase === 'pushback';
      if (wantTug && !vis.tug) {
        vis.tug = new THREE.Mesh(tugGeo, tugMat);
        vis.tug.position.set(0, 0, -(vis.len / 2 + 3.2));
        vis.tug.renderOrder = 10;
        vis.root.add(vis.tug);
      }
      if (vis.tug) vis.tug.visible = wantTug;
      // turnaround service vehicles
      const wantSvc = ac.phase === 'parked' && !!ac.turn && ac.turn.stage !== 'ready' && !wreck;
      if (wantSvc && !vis.svc) {
        const g = new THREE.Group();
        const a = new THREE.Mesh(svcGeo, svcMatA);
        a.position.set(vis.len * 0.052 + 5.5, 0, -vis.len * 0.22);
        a.rotation.y = 0.5;
        const b = new THREE.Mesh(svcGeo, svcMatB);
        b.position.set(-(vis.len * 0.052 + 5), 0, vis.len * 0.27);
        b.rotation.y = -0.35;
        b.scale.set(1, 0.8, 0.8);
        const c = new THREE.Mesh(svcGeo, svcMatA);
        c.position.set(vis.len * 0.052 + 6, 0, vis.len * 0.3);
        c.scale.set(0.9, 0.6, 0.7);
        a.renderOrder = b.renderOrder = c.renderOrder = 10;
        g.add(a, b, c);
        vis.root.add(g);
        vis.svc = g;
      }
      if (vis.svc) vis.svc.visible = wantSvc;

      // label
      const selected = ac.id === selId;
      if (selected) selVis = vis;
      const dist = Math.hypot(x - camera.position.x, y - camera.position.y, z - camera.position.z);
      const showLabel = selected || dist < LABEL_RANGE;
      vis.label.visible = showLabel;
      if (showLabel) {
        const emg = ac.emergency && ac.emergency.resolved == null ? 1 : 0;
        const lk = ac.callsign + (selected ? '|s' : '|n') + emg + (wreck ? 'w' : '');
        if (lk !== vis.labelKey) {
          vis.labelKey = lk;
          const fg = wreck ? '#f87171' : emg ? '#fbbf24' : selected ? '#a5f3fc' : '#cbd5e1';
          const border = wreck || emg ? 'rgba(248,113,113,0.9)' : selected ? '#22d3ee' : 'rgba(148,163,184,0.35)';
          drawLabel(vis.labelCtx, ac.callsign, fg, border, selected ? 'rgba(8,47,73,0.85)' : 'rgba(8,14,22,0.6)');
          vis.labelTex.needsUpdate = true;
        }
        // fade size slightly with distance so far labels are less dominant
        const px = selected ? 22 : dist > 4000 ? 13 : 16;
        const sh = px * labelK;
        vis.label.scale.set(sh * 4, sh, 1);
        vis.label.position.set(x, y + vis.top + 3 + dist * 0.012, z);
      }

      // lights: beacon (blinking), port (red) and starboard (green) nav lights
      if (lightCount < MAX_LIGHT_AC) {
        const o = lightCount * 9;
        const moving = !wreck && ac.phase !== 'parked';
        const sh = Math.sin(ac.hdg * DEG);
        const ch = Math.cos(ac.hdg * DEG);
        const half = vis.span / 2 + 0.5;
        const wy = y + vis.top * 0.22;
        const wz = vis.len * 0.12 + vis.span * 0.1; // wingtips sit aft of the origin
        if (moving && (blinkBase + ac.id * 0.37) % 1.2 < 0.22) {
          lightPosArr[o] = x;
          lightPosArr[o + 1] = y + vis.top * 0.5;
          lightPosArr[o + 2] = z;
        } else {
          lightPosArr[o + 1] = -1e6;
        }
        if (!wreck) {
          // right vector = (ch, sh) in (X, Z); aft vector = (-sh, ch)
          lightPosArr[o + 3] = x - ch * half - sh * wz;
          lightPosArr[o + 4] = wy;
          lightPosArr[o + 5] = z - sh * half + ch * wz;
          lightPosArr[o + 6] = x + ch * half - sh * wz;
          lightPosArr[o + 7] = wy;
          lightPosArr[o + 8] = z + sh * half + ch * wz;
        } else {
          lightPosArr[o + 4] = lightPosArr[o + 7] = -1e6;
        }
        lightCount++;
      }
    }
    // remove visuals of aircraft that left the sim
    if (acVis.size > 0) {
      stale.length = 0;
      for (const vis of acVis.values()) if (vis.seen !== frameNo) stale.push(vis);
      for (let i = 0; i < stale.length; i++) removeVis(stale[i]);
    }
    lightGeo.setDrawRange(0, lightCount * 3);
    lightPosAttr.needsUpdate = true;
    return selVis;
  };

  // ── weather ──
  let flash = 0;
  let nextFlash = 4 + Math.random() * 8;
  let curPrecip: Precip | '' = '';
  const updateWeather = (dt: number) => {
    const wx = sim.s.weather;
    const precip: Precip = wx?.precip ?? 'none';
    const vis = wx?.visSM ?? 10;
    const sky = SKY[precip] ?? SKY.none;
    // visibility → fog: ≥10 SM is "unrestricted"
    const visM = vis >= 9.9 ? 70000 : Math.max(250, vis * 1609 * 1.25);
    const targetDensity = 1.9 / visM;
    const k = Math.min(1, dt * 1.5);
    fog.density += (targetDensity - fog.density) * k;
    bgTarget.setHex(sky.bg);
    if (precip === 'none' && vis < 6) bgTarget.lerp(tmpColor.setHex(SKY.fog.bg), Math.min(1, (6 - vis) / 5));
    bgColor.lerp(bgTarget, k);
    let amb = sky.amb;
    let sunI = sky.sun;
    if (precip === 'thunderstorm') {
      nextFlash -= dt;
      if (nextFlash <= 0) {
        flash = 1;
        nextFlash = 3 + Math.random() * 12;
      }
    }
    if (flash > 0.01) {
      flash *= Math.exp(-dt * 9);
      amb += flash * 2.2;
      sunI += flash * 1.5;
      fog.color.copy(bgColor).lerp(tmpColor.setHex(0x9aa8c0), flash * 0.5);
      scene.background = fog.color;
    } else {
      fog.color.copy(bgColor);
      scene.background = bgColor;
    }
    ambient.intensity += (amb - ambient.intensity) * Math.min(1, dt * 6);
    sun.intensity += (sunI - sun.intensity) * Math.min(1, dt * 6);

    // particles
    const isRain = precip === 'rain' || precip === 'heavy_rain' || precip === 'thunderstorm';
    const isSnow = precip === 'snow';
    if (precip !== curPrecip) {
      curPrecip = precip;
      rain.visible = isRain;
      snow.visible = isSnow;
      const n = precip === 'rain' ? Math.floor(PRECIP_N * 0.5) : PRECIP_N;
      rainGeo.setDrawRange(0, n * 2);
      snowGeo.setDrawRange(0, n);
      (rain.material as THREE.LineBasicMaterial).opacity = precip === 'rain' ? 0.32 : 0.5;
    }
    if (!isRain && !isSnow) {
      lastCamPos.copy(camera.position);
      return;
    }
    // wind blows FROM windDir
    const ws = Math.min(18, (wx.windKt ?? 0) * 0.514);
    const wvx = -Math.sin(wx.windDir * DEG) * ws;
    const wvz = Math.cos(wx.windDir * DEG) * ws;
    const fall = isRain ? 26 : 2.2;
    const mx = (wvx * (isRain ? 1 : 0.35)) * dt - (camera.position.x - lastCamPos.x);
    const my = -fall * dt - (camera.position.y - lastCamPos.y);
    const mz = (wvz * (isRain ? 1 : 0.35)) * dt - (camera.position.z - lastCamPos.z);
    lastCamPos.copy(camera.position);
    const n = precip === 'rain' ? Math.floor(PRECIP_N * 0.5) : PRECIP_N;
    const span = PR * 2;
    const sl = 0.05; // streak duration (s)
    for (let i = 0, o = 0; i < n; i++, o += 3) {
      let px = precipRel[o] + mx;
      let py = precipRel[o + 1] + my;
      let pz = precipRel[o + 2] + mz;
      if (isSnow) px += Math.sin(py * 0.2 + i) * dt * 0.8;
      // wrap into the box (also handles camera teleports)
      if (px < -PR || px > PR) px = ((((px + PR) % span) + span) % span) - PR;
      if (py < -PR || py > PR) py = ((((py + PR) % span) + span) % span) - PR;
      if (pz < -PR || pz > PR) pz = ((((pz + PR) % span) + span) % span) - PR;
      precipRel[o] = px;
      precipRel[o + 1] = py;
      precipRel[o + 2] = pz;
      if (isRain) {
        const q = i * 6;
        rainArr[q] = px;
        rainArr[q + 1] = py;
        rainArr[q + 2] = pz;
        rainArr[q + 3] = px - wvx * sl;
        rainArr[q + 4] = py + fall * sl;
        rainArr[q + 5] = pz - wvz * sl;
      }
    }
    if (isRain) {
      rain.position.copy(camera.position);
      rainAttr.needsUpdate = true;
    } else {
      snow.position.copy(camera.position);
      snowAttr.needsUpdate = true;
    }
  };

  // ── camera update ──
  const updateCamera = (mode: TowerCam, target: AcVis | null) => {
    let fov = 50;
    if (mode === 'overview') {
      const ce = Math.cos(orbit.el);
      camera.position.set(orbit.tx + Math.sin(orbit.az) * ce * orbit.dist, Math.max(3, Math.sin(orbit.el) * orbit.dist), orbit.tz + Math.cos(orbit.az) * ce * orbit.dist);
      camera.up.set(0, 1, 0);
      camera.lookAt(orbit.tx, 0, orbit.tz);
    } else if (mode === 'follow' && target) {
      const d = Math.max(45, target.len * 3.2) * follow.k;
      const b = (-target.root.rotation.y / DEG + 180 + follow.az) * DEG;
      const el = follow.el * DEG;
      const p = target.root.position;
      camera.position.set(p.x + Math.sin(b) * Math.cos(el) * d, Math.max(1.5, p.y + target.top * 0.5 + Math.sin(el) * d), p.z - Math.cos(b) * Math.cos(el) * d);
      camera.up.set(0, 1, 0);
      camera.lookAt(p.x, p.y + target.top * 0.5, p.z);
      fov = 45;
    } else if (mode !== 'follow') {
      const lc = look[mode];
      camera.position.set(lc.x, lc.y, lc.z);
      const cp = Math.cos(lc.pitch * DEG);
      camera.up.set(0, 1, 0);
      camera.lookAt(lc.x + Math.sin(lc.yaw * DEG) * cp, lc.y + Math.sin(lc.pitch * DEG), lc.z - Math.cos(lc.yaw * DEG) * cp);
      fov = lc.fov;
    }
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  };

  // ── main loop ──
  let raf = 0;
  let last = performance.now();
  let disposed = false;
  const frame = (now: number) => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
    last = now;
    if (width < 2 || height < 2) return;

    const selId = getSel();
    let mode = getCam();
    let selVis: AcVis | null = selId != null ? (acVis.get(selId) ?? null) : null;
    if (mode === 'follow' && !selVis) {
      // the visual may not exist yet on the very first frame – check the sim directly
      let exists = false;
      if (selId != null) for (const a of sim.s.aircraft) if (a.id === selId && a.phase !== 'gone') exists = true;
      if (!exists) mode = 'overview';
    }
    effMode = mode;
    applyKeys(dt);
    if (mode === 'runway') placeRunwayCam();

    // first pass camera (labels/pick need a current camera), then aircraft, then chase camera refinement
    updateCamera(mode, selVis);
    selVis = syncAircraft(dt, now, selId);
    if (mode === 'follow' && selVis) updateCamera(mode, selVis);

    tower.visible = mode !== 'tower';
    updateWeather(dt);

    // selection marker
    if (selVis) {
      const p = selVis.root.position;
      const d = p.distanceTo(camera.position);
      const rr = Math.max(selVis.span * 0.62, d * 0.022);
      selRing.visible = true;
      selRing.position.set(p.x, 0.08, p.z);
      selRing.scale.set(rr, 1, rr);
      selLine.visible = true;
      selLine.position.set(p.x, 0, p.z);
      selLine.scale.set(1, p.y + selVis.top + 3 + d * 0.012, 1);
    } else {
      selRing.visible = false;
      selLine.visible = false;
    }

    // terminal labels: constant pixel size, hidden when far
    const lk = (2 * Math.tan((camera.fov * DEG) / 2)) / height;
    for (let i = 0; i < termLabels.length; i++) {
      const sp = termLabels[i];
      const d = v3b.copy(sp.position).distanceTo(camera.position);
      sp.visible = d < 7000 && d > 60;
      if (sp.visible) sp.scale.set(13 * lk * (256 / 48), 13 * lk, 1);
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
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onCtx);
      canvas.removeEventListener('pointerenter', onEnter);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      for (const vis of [...acVis.values()]) removeVis(vis);
      for (const g of acGeo.values()) g.dispose();
      acGeo.clear();
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      scene.clear();
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        /* ignore */
      }
      canvas.remove();
    },
  };
}

// ───────────────────────────── component ─────────────────────────────

export default function TowerView3D(props: {
  sim: Sim;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  cam: TowerCam;
  onCam: (c: TowerCam) => void;
}): JSX.Element {
  const { sim, selectedId, onSelect, cam, onCam } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const selRef = useRef(selectedId);
  const camRef = useRef(cam);
  const onSelectRef = useRef(onSelect);
  selRef.current = selectedId;
  camRef.current = cam;
  onSelectRef.current = onSelect;
  const [failed, setFailed] = useState(false);
  const ap = sim.ap;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: Engine | null = null;
    try {
      engine = createEngine(
        host,
        sim,
        () => selRef.current,
        () => camRef.current,
        (id) => onSelectRef.current(id),
      );
      setFailed(false);
    } catch (err) {
      console.warn('TowerView3D: WebGL unavailable', err);
      setFailed(true);
    }
    return () => {
      engine?.dispose();
      engine = null;
    };
  }, [sim, ap]);

  const selAc = selectedId != null ? sim.s.aircraft.find((a) => a.id === selectedId && a.phase !== 'gone') : undefined;
  const noFollowTarget = cam === 'follow' && !selAc;
  const help = CAMS.find((c) => c.id === (noFollowTarget ? 'overview' : cam))?.help ?? '';

  return (
    <div className="absolute inset-0 overflow-hidden bg-[#0d1726] select-none" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div ref={hostRef} className="absolute inset-0" style={{ position: 'absolute', inset: 0 }} />
      {failed ? (
        <div className="absolute inset-0 flex items-center justify-center p-6" style={{ position: 'absolute', inset: 0 }}>
          <div className="max-w-md rounded-lg border border-slate-700 bg-slate-900/90 p-5 text-center text-sm text-slate-300 shadow-xl">
            <div className="mb-2 text-base font-semibold text-cyan-300">3D tower view unavailable</div>
            <p>
              Your browser or graphics driver could not start WebGL, so the 3D view cannot be shown. The 2D radar and ground views keep working
              normally – enable hardware acceleration or try another browser to use the tower view.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="pointer-events-none absolute left-2 top-2 flex flex-col items-start gap-1.5" style={{ position: 'absolute', left: 8, top: 8 }}>
            <div className="pointer-events-auto flex flex-wrap gap-1 rounded-md border border-slate-700/70 bg-slate-950/70 p-1 shadow-lg backdrop-blur-sm">
              {CAMS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onCam(c.id)}
                  aria-pressed={cam === c.id}
                  title={c.help}
                  className={
                    'rounded px-2 py-1 text-[11px] font-medium uppercase tracking-wide transition-colors ' +
                    (cam === c.id
                      ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-inset ring-cyan-400/60'
                      : 'text-slate-400 hover:bg-slate-800/80 hover:text-slate-200')
                  }
                >
                  {c.label}
                </button>
              ))}
            </div>
            {noFollowTarget && (
              <div className="rounded border border-amber-500/40 bg-slate-950/75 px-2 py-1 text-[11px] text-amber-300 shadow">
                No aircraft selected – click an aircraft to follow it (showing overview).
              </div>
            )}
            {cam === 'follow' && selAc && (
              <div className="rounded border border-cyan-500/30 bg-slate-950/70 px-2 py-1 font-mono text-[11px] text-cyan-200 shadow">
                Following {selAc.callsign} · {selAc.type}
              </div>
            )}
          </div>
          <div
            className="pointer-events-none absolute bottom-2 left-2 rounded bg-slate-950/60 px-2 py-1 text-[10px] text-slate-400"
            style={{ position: 'absolute', left: 8, bottom: 8 }}
          >
            {help}
          </div>
        </>
      )}
    </div>
  );
}
