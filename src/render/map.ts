/**
 * 2D renderer for both the radar scope and the airport ground view. It draws directly from the
 * simulation state every frame – there is no separate display model of the aircraft.
 */
import type { Aircraft, Airport, Alert } from '../sim/types';
import type { Sim } from '../sim/sim';
import { KT, NM, angDiff, clamp, dist, norm360, vecOf } from '../sim/util';
import { typeOf } from '../sim/data/aircraft';
import { airlineOf } from '../sim/data/airlines';
import { isAirborne } from '../sim/world';
import { endRef, gateByName, runwayById } from '../sim/airport/query';
import { cumOf, nextHoldAhead, posOnRoute } from '../sim/ground';
import { fixByName } from '../sim/air';
import { gateUser } from '../sim/traffic';

export interface Camera { cx: number; cy: number; scale: number } // scale = px per metre
export interface DrawOpts {
  mode: 'radar' | 'ground';
  selectedId: number | null;
  tagLevel: 0 | 1 | 2;
  showFixes: boolean; showRings: boolean; showTrails: boolean; showWeather: boolean; showLabels: boolean; showVectors: boolean;
  filter: 'all' | 'arr' | 'dep';
  preview?: number[] | null;
  guidance: boolean;
  time: number; // wall-clock seconds for blinking
  /** replay frame: when set, aircraft are drawn from recorded track data instead of live state */
  replay?: { d: number[] } | null;
}

export const C = {
  bg: '#060c14', bgGround: '#0a1119', grass: '#0b141c', apron: '#141d28', twy: '#27313e', twyLine: '#c9a227', rwy: '#1c2129', rwyEdge: '#3a4350',
  rwyMark: '#d7dde5', terminal: '#2a3a50', terminalEdge: '#4b6282', green: '#56e39f', cyan: '#4cc9f0', amber: '#ffb703', red: '#ff4d5a',
  dim: '#5b6b7e', text: '#c8d4e2', white: '#f2f6fa', ring: '#12202e', fix: '#3b6a8f',
};

export const w2s = (cam: Camera, W: number, H: number, x: number, y: number): [number, number] => [W / 2 + (x - cam.cx) * cam.scale, H / 2 - (y - cam.cy) * cam.scale];
export const s2w = (cam: Camera, W: number, H: number, sx: number, sy: number): [number, number] => [cam.cx + (sx - W / 2) / cam.scale, cam.cy - (sy - H / 2) / cam.scale];

export function fitAirport(ap: Airport, W: number, H: number): Camera {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const n of ap.nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: Math.min(W / (x1 - x0 + 500), H / (y1 - y0 + 500)) };
}
export const fitRadar = (ap: Airport, W: number, H: number): Camera => ({ cx: 0, cy: 0, scale: Math.min(W, H) / (ap.airspaceRadius * 2.12) });

// taxiway label positions are static per airport
const labelCache = new WeakMap<Airport, { name: string; x: number; y: number }[]>();
function twyLabels(ap: Airport) {
  let l = labelCache.get(ap);
  if (!l) {
    l = [];
    const sorted = ap.edges.filter((e) => e.name && e.kind !== 'runway' && e.kind !== 'gate').sort((a, b) => b.len - a.len);
    for (const e of sorted) {
      const A = ap.nodes[e.a], B = ap.nodes[e.b];
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      if (e.len < 40) continue;
      if (l.some((o) => o.name === e.name && dist(o.x, o.y, mx, my) < 420)) continue;
      if (l.some((o) => dist(o.x, o.y, mx, my) < 45)) continue;
      l.push({ name: e.name, x: mx, y: my });
    }
    labelCache.set(ap, l);
  }
  return l;
}

function planeShape(ctx: CanvasRenderingContext2D, len: number, span: number, engines: number) {
  // unit drawing pointing up (-y); origin at aircraft centre
  const L = len, S = span, f = Math.max(1.2, L * 0.055);
  ctx.beginPath();
  // fuselage
  ctx.moveTo(0, -L / 2);
  ctx.quadraticCurveTo(f, -L / 2 + f * 2.2, f, -L * 0.3);
  ctx.lineTo(f, L * 0.38);
  ctx.lineTo(0, L / 2);
  ctx.lineTo(-f, L * 0.38);
  ctx.lineTo(-f, -L * 0.3);
  ctx.quadraticCurveTo(-f, -L / 2 + f * 2.2, 0, -L / 2);
  // wings (swept)
  ctx.moveTo(f, -L * 0.08);
  ctx.lineTo(S / 2, L * 0.12);
  ctx.lineTo(S / 2, L * 0.17);
  ctx.lineTo(f, L * 0.1);
  ctx.moveTo(-f, -L * 0.08);
  ctx.lineTo(-S / 2, L * 0.12);
  ctx.lineTo(-S / 2, L * 0.17);
  ctx.lineTo(-f, L * 0.1);
  // tailplane
  ctx.moveTo(f * 0.6, L * 0.36);
  ctx.lineTo(S * 0.19, L * 0.47);
  ctx.lineTo(S * 0.19, L * 0.5);
  ctx.lineTo(0, L * 0.46);
  ctx.lineTo(-S * 0.19, L * 0.5);
  ctx.lineTo(-S * 0.19, L * 0.47);
  ctx.lineTo(-f * 0.6, L * 0.36);
  void engines;
}

function drawPlane(ctx: CanvasRenderingContext2D, ac: { type: string; airline: string }, sx: number, sy: number, hdg: number, scale: number, opts: { alpha?: number; outline?: string; minPx?: number; boost?: number } = {}) {
  const t = typeOf(ac.type);
  const al = airlineOf(ac.airline);
  const k = Math.max(scale, (opts.minPx ?? 9) / t.length) * (opts.boost ?? 1);
  const L = t.length * k, S = t.span * k;
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate((hdg * Math.PI) / 180);
  ctx.globalAlpha = opts.alpha ?? 1;
  planeShape(ctx, L, S, t.engines);
  ctx.fillStyle = al.color;
  ctx.fill();
  if (L > 12) {
    // engines
    ctx.fillStyle = '#8a94a0';
    const eOff = t.engines >= 4 ? [0.18, 0.32] : t.family === 'Bombardier' ? [] : [0.2];
    for (const o of eOff) for (const sgn of [-1, 1]) ctx.fillRect(sgn * S * o - L * 0.02, -L * 0.02 + o * L * 0.25, L * 0.04, L * 0.1);
    // tail fin + accent stripe in airline colours
    ctx.fillStyle = al.tail;
    ctx.beginPath();
    ctx.moveTo(0, L * 0.3); ctx.lineTo(L * 0.035, L * 0.47); ctx.lineTo(-L * 0.035, L * 0.47); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = al.accent;
    ctx.fillRect(-L * 0.012, -L * 0.3, L * 0.024, L * 0.5);
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = opts.outline ?? 'rgba(10,16,24,0.9)';
  planeShape(ctx, L, S, t.engines);
  ctx.stroke();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, color: string, bg = 'rgba(6,12,20,0.78)', border?: string) {
  const h = 12;
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  ctx.fillStyle = bg;
  ctx.fillRect(x - 3, y - h + 2, w + 6, lines.length * h + 3);
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.strokeRect(x - 3.5, y - h + 1.5, w + 7, lines.length * h + 4); }
  ctx.fillStyle = color;
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * h));
}

const acColor = (ac: Aircraft, sel: boolean, alert?: Alert) =>
  sel ? C.white : ac.emergency && !ac.emergency.resolved ? C.red : alert?.level === 'critical' || alert?.level === 'violation' ? C.red : alert ? C.amber : ac.kind === 'departure' ? C.cyan : C.green;

export function draw(ctx: CanvasRenderingContext2D, W: number, H: number, sim: Sim, cam: Camera, o: DrawOpts) {
  const { ap, s } = sim;
  const P = (x: number, y: number) => w2s(cam, W, H, x, y);
  const radar = o.mode === 'radar';
  const px = cam.scale;
  ctx.setTransform(devicePixelRatio || 1, 0, 0, devicePixelRatio || 1, 0, 0);
  ctx.fillStyle = radar ? C.bg : C.bgGround;
  ctx.fillRect(0, 0, W, H);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'alphabetic';
  const [ox, oy] = P(0, 0);

  // ── airspace furniture ──
  if (o.showRings && px < 0.12) {
    ctx.lineWidth = 1;
    for (let r = 5; r * NM <= ap.airspaceRadius + 1; r += 5) {
      ctx.strokeStyle = r % 10 === 0 ? '#16283a' : C.ring;
      ctx.beginPath(); ctx.arc(ox, oy, r * NM * px, 0, Math.PI * 2); ctx.stroke();
      if (r % 10 === 0 && px * NM * 5 > 26) { ctx.fillStyle = '#2c4660'; ctx.fillText(`${r}`, ox + 3, oy - r * NM * px - 3); }
    }
    ctx.strokeStyle = '#1f4a63';
    ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.arc(ox, oy, ap.airspaceRadius * px, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  // weather cells
  if (o.showWeather) {
    for (const c of s.weather.cells) {
      const [x, y] = P(c.x, c.y);
      const r = c.r * px;
      if (x + r < 0 || x - r > W || y + r < 0 || y - r > H) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,60,60,${0.32 * c.intensity})`);
      g.addColorStop(0.45, `rgba(255,170,0,${0.25 * c.intensity})`);
      g.addColorStop(0.8, `rgba(60,200,90,${0.16 * c.intensity})`);
      g.addColorStop(1, 'rgba(60,200,90,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  // extended centrelines for active arrival runways
  if (px < 0.25) {
    const act = new Set(s.activeConfig.arr);
    for (const r of ap.runways) for (const e of r.ends) {
      const on = act.has(e.name);
      if (!on && !radar) continue;
      const [ux, uy] = vecOf(e.hdg);
      const len = (on ? 16 : 6) * NM;
      const [x0, y0] = P(e.x, e.y), [x1, y1] = P(e.x - ux * len, e.y - uy * len);
      ctx.strokeStyle = on ? '#1d5a7a' : '#12293a';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.setLineDash([]);
      if (on && px * NM > 5) {
        for (let d = 1; d <= 16; d++) {
          const [tx, ty] = P(e.x - ux * d * NM, e.y - uy * d * NM);
          const tl = d % 5 === 0 ? 5 : 2.5;
          ctx.beginPath(); ctx.moveTo(tx - uy * tl, ty - ux * tl); ctx.lineTo(tx + uy * tl, ty + ux * tl); ctx.stroke();
        }
        const [lx, ly] = P(e.x - ux * 16.6 * NM, e.y - uy * 16.6 * NM);
        ctx.fillStyle = '#2f7da3';
        ctx.fillText(e.name, lx - 8, ly + 4);
      }
    }
  }
  if (o.showFixes && px < 0.2) {
    for (const f of ap.fixes) {
      const [x, y] = P(f.x, f.y);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      // approach fixes only for the active arrival runways (all of them once zoomed in)
      if ((f.kind === 'nav' || f.kind === 'final') && !(f.rwy && s.activeConfig.arr.includes(f.rwy)) && px * NM < 28) continue;
      if (f.kind === 'nav' && px * NM < 7) continue;
      ctx.strokeStyle = f.kind === 'arrival' ? '#3f8f6f' : f.kind === 'departure' ? '#3b79a8' : C.fix;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (f.kind === 'final' || f.kind === 'nav') { ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3); }
      else { ctx.moveTo(x, y - 5); ctx.lineTo(x + 4.5, y + 3.5); ctx.lineTo(x - 4.5, y + 3.5); ctx.closePath(); }
      ctx.stroke();
      ctx.fillStyle = f.kind === 'arrival' ? '#4fae88' : f.kind === 'departure' ? '#4f93c8' : '#3d6485';
      ctx.fillText(f.name, x + 7, y + 4);
    }
  }

  // ── airport surface ──
  const detail = px > 0.035;
  if (detail) {
    ctx.fillStyle = C.apron;
    for (const poly of ap.aprons) {
      ctx.beginPath();
      poly.forEach(([x, y], i) => { const [sx, sy] = P(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.closePath(); ctx.fill();
    }
    const closed = new Set(s.closedEdges);
    // taxiways
    for (const pass of [0, 1]) {
      for (const e of ap.edges) {
        if (e.kind === 'runway') continue;
        if (e.kind === 'gate' && px < 0.25) continue;
        const A = ap.nodes[e.a], B = ap.nodes[e.b];
        const [x0, y0] = P(A.x, A.y), [x1, y1] = P(B.x, B.y);
        if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > W || Math.max(y0, y1) < 0 || Math.min(y0, y1) > H) continue;
        if (pass === 0) {
          ctx.strokeStyle = closed.has(e.id) ? '#4a2026' : e.kind === 'apron' ? '#1c2632' : C.twy;
          ctx.lineWidth = Math.max(e.kind === 'gate' ? 1 : 1.6, (e.kind === 'taxiway' ? 23 : e.kind === 'apron' ? 18 : 8) * px);
          ctx.lineCap = 'round';
        } else {
          if (px < 0.22) continue;
          ctx.strokeStyle = e.kind === 'gate' ? 'rgba(201,162,39,0.35)' : 'rgba(201,162,39,0.6)';
          ctx.lineWidth = 1;
          ctx.lineCap = 'butt';
        }
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }
    ctx.lineCap = 'butt';
  }
  // runways
  for (const r of ap.runways) {
    const [a, b] = r.ends;
    const [x0, y0] = P(a.x, a.y), [x1, y1] = P(b.x, b.y);
    const st = s.rwy[r.id];
    const wpx = Math.max(radar && px < 0.03 ? 1.5 : 3, r.width * px);
    ctx.strokeStyle = C.rwyEdge;
    ctx.lineWidth = wpx + 2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = st.closed ? '#3a1d22' : detail ? C.rwy : '#8fa3b8';
    ctx.lineWidth = wpx;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    if (detail && wpx > 4) {
      ctx.strokeStyle = C.rwyMark;
      ctx.lineWidth = Math.max(1, wpx * 0.07);
      ctx.setLineDash([Math.max(4, 30 * px), Math.max(4, 30 * px)]);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.setLineDash([]);
      // thresholds + numbers
      for (const e of r.ends) {
        const [ux, uy] = vecOf(e.hdg);
        const [tx, ty] = P(e.x + ux * 12, e.y + uy * 12);
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate((e.hdg * Math.PI) / 180);
        ctx.fillStyle = C.rwyMark;
        const n = 6, bw = (wpx * 0.8) / (n * 2 - 1);
        for (let i = 0; i < n; i++) ctx.fillRect(-wpx * 0.4 + i * bw * 2, -Math.max(4, 30 * px), bw, Math.max(4, 30 * px));
        if (wpx > 9) {
          ctx.font = `bold ${Math.round(clamp(wpx * 0.62, 8, 40))}px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(e.name, 0, -Math.max(4, 30 * px) - wpx * 0.5);
          ctx.textAlign = 'left';
        }
        ctx.restore();
      }
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    }
    if (st.closed) {
      ctx.strokeStyle = C.red; ctx.lineWidth = 2;
      for (const f of [0.2, 0.5, 0.8]) {
        const cx = x0 + (x1 - x0) * f, cy = y0 + (y1 - y0) * f, q = Math.max(5, wpx * 0.5);
        ctx.beginPath(); ctx.moveTo(cx - q, cy - q); ctx.lineTo(cx + q, cy + q); ctx.moveTo(cx + q, cy - q); ctx.lineTo(cx - q, cy + q); ctx.stroke();
      }
    }
    if ((!detail || wpx <= 9) && px * r.length > 40) {
      for (const e of r.ends) {
        const [ux, uy] = vecOf(e.hdg);
        const [tx, ty] = P(e.x - ux * 14 / Math.max(px, 0.001) * 0.001 - ux * (12 / px), e.y - uy * (12 / px));
        ctx.fillStyle = s.activeConfig.arr.includes(e.name) ? C.green : s.activeConfig.dep.includes(e.name) ? C.cyan : '#6f8196';
        ctx.fillText(e.name, tx - 8, ty + 4);
      }
    }
  }
  if (detail) {
    // terminals
    for (const t of ap.terminals) {
      ctx.beginPath();
      t.poly.forEach(([x, y], i) => { const [sx, sy] = P(x, y); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
      ctx.closePath();
      ctx.fillStyle = C.terminal; ctx.fill();
      ctx.strokeStyle = C.terminalEdge; ctx.lineWidth = 1; ctx.stroke();
      if (px > 0.07 && o.showLabels) {
        const [lx, ly] = P(t.label[0], t.label[1]);
        ctx.fillStyle = '#9fb6d1';
        ctx.textAlign = 'center';
        ctx.fillText(px > 0.3 ? t.name : t.name.replace(/^(Concourse|Terminal) /, ''), lx, ly + 4);
        ctx.textAlign = 'left';
      }
    }
    // tower
    const [tx, ty] = P(ap.towerPos[0], ap.towerPos[1]);
    ctx.fillStyle = '#7fd0ff';
    ctx.beginPath(); ctx.moveTo(tx, ty - 6); ctx.lineTo(tx + 5, ty + 4); ctx.lineTo(tx - 5, ty + 4); ctx.closePath(); ctx.fill();
    if (px > 0.1) { ctx.fillStyle = '#7fd0ff'; ctx.fillText('TWR', tx + 8, ty + 4); }
    // hold lines
    if (px > 0.12) {
      for (const n of ap.nodes) {
        if (n.kind !== 'hold' || !n.rwy) continue;
        const [hx, hy] = P(n.x, n.y);
        if (hx < 0 || hx > W || hy < 0 || hy > H) continue;
        const r = runwayById(ap, n.rwy)!;
        const [ux, uy] = vecOf(r.ends[0].hdg);
        const q = Math.max(4, 16 * px);
        ctx.strokeStyle = '#ffb703'; ctx.lineWidth = Math.max(1.5, 2 * px);
        ctx.beginPath(); ctx.moveTo(hx - ux * q, hy + uy * q); ctx.lineTo(hx + ux * q, hy - uy * q); ctx.stroke();
      }
    }
    // gates
    if (px > 0.16) {
      for (const g of ap.gates) {
        const n = ap.nodes[g.node];
        const [gx, gy] = P(n.x, n.y);
        if (gx < -20 || gx > W + 20 || gy < -20 || gy > H + 20) continue;
        const user = gateUser(sim, g.name);
        const occ = user && (user.phase === 'parked' || user.phase === 'pushback');
        if (!occ) {
          ctx.strokeStyle = user ? C.amber : '#3f5670';
          ctx.lineWidth = 1;
          ctx.strokeRect(gx - 3, gy - 3, 6, 6);
          if (px > 0.3 && o.showLabels) { ctx.fillStyle = user ? C.amber : '#58708c'; ctx.fillText(g.name, gx + 6, gy + 4); }
        }
      }
    }
    // taxiway designators
    if (px > 0.09 && o.showLabels) {
      ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      const drawn: number[] = [];
      const minGap = px > 0.3 ? 0 : 34;
      for (const l of twyLabels(ap)) {
        const [lx, ly] = P(l.x, l.y);
        if (lx < 0 || lx > W || ly < 0 || ly > H) continue;
        let clash = false;
        for (let i = 0; i < drawn.length && !clash; i += 2) if (Math.abs(drawn[i] - lx) < minGap && Math.abs(drawn[i + 1] - ly) < minGap * 0.6) clash = true;
        if (clash) continue;
        drawn.push(lx, ly);
        const w = ctx.measureText(l.name).width + 6;
        ctx.fillStyle = '#0b0f14';
        ctx.fillRect(lx - w / 2, ly - 7, w, 13);
        ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 1; ctx.strokeRect(lx - w / 2 + 0.5, ly - 6.5, w - 1, 12);
        ctx.fillStyle = '#f5c518';
        ctx.fillText(l.name, lx, ly + 3.5);
      }
      ctx.textAlign = 'left';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    }
  }

  // ── replay mode ──
  if (o.replay) {
    const d = o.replay.d;
    for (let i = 0; i < d.length; i += 6) {
      const ac = s.aircraft.find((a) => a.id === d[i]);
      const [x, y] = P(d[i + 1], d[i + 2]);
      if (x < -30 || x > W + 30 || y < -30 || y > H + 30) continue;
      const ground = d[i + 5] !== 0;
      if (ground && !detail) continue;
      const proto = ac ?? { type: 'A320', airline: 'GA' };
      drawPlane(ctx, proto, x, y, d[i + 4], px, { minPx: ground ? 8 : 12, alpha: d[i + 5] === 2 ? 0.55 : 1, outline: o.selectedId === d[i] ? C.white : undefined });
      if (d[i + 5] !== 2 && ac) label(ctx, [ac.callsign, ground ? 'GND' : `${String(Math.round(d[i + 3] / 100)).padStart(3, '0')}`], x + 12, y - 8, ground ? C.amber : C.green);
    }
    return;
  }

  // ── planned / cleared route of the selected aircraft, route preview ──
  const sel = s.aircraft.find((a) => a.id === o.selectedId);
  if (o.preview && o.preview.length > 1 && detail) {
    ctx.strokeStyle = 'rgba(255,183,3,0.9)'; ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]);
    ctx.beginPath();
    o.preview.forEach((id, i) => { const [x, y] = P(ap.nodes[id].x, ap.nodes[id].y); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
  }
  if (sel) {
    if (!isAirborne(sel) && sel.route.length > 1 && detail && sel.phase !== 'parked') {
      const cum = cumOf(ap, sel.route);
      const p0 = posOnRoute(ap, sel.route, cum, sel.routeS);
      ctx.strokeStyle = 'rgba(76,201,240,0.9)'; ctx.lineWidth = 2.5; ctx.setLineDash([]);
      ctx.beginPath();
      const [sx, sy] = P(sel.x, sel.y);
      ctx.moveTo(sx, sy);
      for (let i = p0.i + 1; i < sel.route.length; i++) { const [x, y] = P(ap.nodes[sel.route[i]].x, ap.nodes[sel.route[i]].y); ctx.lineTo(x, y); }
      ctx.stroke();
      const h = nextHoldAhead(sim, sel, cum);
      const stopS = Math.min(sel.routeStop, h ? h.s : Infinity, cum[cum.length - 1]);
      const sp = posOnRoute(ap, sel.route, cum, stopS);
      const [qx, qy] = P(sp.x, sp.y);
      ctx.fillStyle = C.red;
      ctx.beginPath(); ctx.arc(qx, qy, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.white; ctx.fillRect(qx - 3, qy - 1, 6, 2);
    }
    if (isAirborne(sel)) {
      // predicted trajectory (2 min) following the current guidance
      let x = sel.x, y = sel.y, hdg = sel.hdg;
      const tgt = sel.latMode === 'hdg' ? sel.tgtHdg : undefined;
      const f = fixByName(sim, sel.fix);
      ctx.strokeStyle = 'rgba(242,246,250,0.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
      ctx.beginPath();
      const [sx, sy] = P(x, y); ctx.moveTo(sx, sy);
      const v = sel.gs * KT;
      for (let t = 0; t < 150; t += 3) {
        let want = tgt ?? hdg;
        if ((sel.latMode === 'fix' || sel.latMode === 'hold') && f) want = norm360((Math.atan2(f.x - x, f.y - y) * 180) / Math.PI);
        if (sel.latMode === 'loc') { const e = endRef(ap, sel.rwy); if (e) want = e.end.hdg; }
        hdg = norm360(hdg + clamp(angDiff(hdg, want), -7.5, 7.5));
        const [ux, uy] = vecOf(hdg);
        x += ux * v * 3; y += uy * v * 3;
        const [qx, qy] = P(x, y); ctx.lineTo(qx, qy);
      }
      ctx.stroke(); ctx.setLineDash([]);
      if (f && (sel.latMode === 'fix' || sel.latMode === 'hold')) {
        const [fx, fy] = P(f.x, f.y);
        ctx.strokeStyle = 'rgba(76,201,240,0.5)'; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(fx, fy); ctx.stroke();
      }
    }
  }

  // ── conflict links ──
  const alertOf = new Map<number, Alert>();
  for (const a of s.alerts) {
    for (const id of a.ac) { const cur = alertOf.get(id); if (!cur || (cur.level === 'predict' && a.level !== 'predict')) alertOf.set(id, a); }
    if (a.ac.length >= 2 && (a.kind === 'airborne' || a.kind === 'wake' || a.kind === 'approach')) {
      const p = s.aircraft.find((x) => x.id === a.ac[0]), q = s.aircraft.find((x) => x.id === a.ac[1]);
      if (p && q) {
        const [x0, y0] = P(p.x, p.y), [x1, y1] = P(q.x, q.y);
        ctx.strokeStyle = a.level === 'predict' ? 'rgba(255,183,3,0.7)' : C.red;
        ctx.lineWidth = a.level === 'predict' ? 1 : 2;
        ctx.setLineDash(a.level === 'predict' ? [5, 4] : []);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // ── aircraft ──
  const blink = Math.floor(o.time * 2) % 2 === 0;
  const order = [...s.aircraft].sort((a, b) => Number(isAirborne(a)) - Number(isAirborne(b)) || Number(a.id === o.selectedId) - Number(b.id === o.selectedId));
  for (const ac of order) {
    if (ac.phase === 'gone') continue;
    const air = isAirborne(ac);
    if (o.filter !== 'all' && (o.filter === 'arr') !== (ac.kind === 'arrival') && ac.id !== o.selectedId) continue;
    const [x, y] = P(ac.x, ac.y);
    if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue;
    const isSel = ac.id === o.selectedId;
    const alert = alertOf.get(ac.id);
    const col = acColor(ac, isSel, alert);
    const em = ac.emergency && !ac.emergency.resolved;

    if (ac.phase === 'crashed') {
      ctx.strokeStyle = C.red; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke();
      label(ctx, [ac.callsign, 'ACCIDENT'], x + 10, y - 4, C.red);
      continue;
    }
    if (!air) {
      // surface traffic
      if (!detail) {
        if (ac.phase === 'parked') continue;
        ctx.fillStyle = em ? C.red : C.amber;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        continue;
      }
      const parked = ac.phase === 'parked';
      if (isSel) { ctx.strokeStyle = C.white; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, Math.max(14, typeOf(ac.type).length * px * 0.7), 0, Math.PI * 2); ctx.stroke(); }
      const pending = ac.request && (ac.request.deferredUntil ?? 0) < s.t;
      if ((pending || em) && blink) {
        ctx.strokeStyle = em ? C.red : C.amber; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, Math.max(11, typeOf(ac.type).length * px * 0.62), 0, Math.PI * 2); ctx.stroke();
      }
      // ground service vehicles during turnaround
      if (parked && ac.turn && ac.turn.stage !== 'ready' && px > 0.3) {
        const t = typeOf(ac.type);
        const [fx, fy] = vecOf(ac.hdg), rx = fy, ry = -fx;
        const veh: [number, number, string, boolean][] = [
          [0.1, 0.42, '#e9c46a', ac.turn.stage === 'unloading' || ac.turn.stage === 'boarding'], // baggage carts
          [-0.05, -0.45, '#4cc9f0', ac.turn.stage === 'servicing'], // fuel truck
          [0.3, 0.3, '#f4f4f4', ac.turn.stage === 'servicing'], // catering
          [-0.32, 0.4, '#e9c46a', ac.turn.stage === 'unloading'],
          [0.2, -0.5, '#ff8fab', ac.turn.stage === 'deicing'],
          [-0.2, 0.5, '#ff8fab', ac.turn.stage === 'deicing'],
        ];
        for (const [f, sgn, colr, on] of veh) {
          if (!on) continue;
          const vx = ac.x + fx * t.length * f + rx * t.span * sgn * 0.5, vy = ac.y + fy * t.length * f + ry * t.span * sgn * 0.5;
          const [qx, qy] = P(vx, vy);
          ctx.fillStyle = colr;
          ctx.fillRect(qx - 3 * px, qy - 1.5 * px, Math.max(3, 6 * px), Math.max(2, 3 * px));
        }
      }
      drawPlane(ctx, ac, x, y, ac.hdg, px, { alpha: parked ? 0.92 : 1, outline: isSel ? C.white : ac.flags.wreck ? C.red : undefined, minPx: px > 0.08 ? 13 : 8 });
      if (ac.phase === 'pushback' || (ac.reverse && ac.flags.tow)) {
        const t = typeOf(ac.type);
        const [fx, fy] = vecOf(ac.hdg);
        const [qx, qy] = P(ac.x + fx * (t.length / 2 + 4), ac.y + fy * (t.length / 2 + 4));
        ctx.fillStyle = '#ffd166';
        ctx.fillRect(qx - Math.max(2, 3 * px), qy - Math.max(2, 3 * px), Math.max(4, 6 * px), Math.max(4, 6 * px));
      }
      if (ac.phase === 'disabled') {
        ctx.strokeStyle = C.red; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x - 7, y - 7); ctx.lineTo(x + 7, y + 7); ctx.moveTo(x + 7, y - 7); ctx.lineTo(x - 7, y + 7); ctx.stroke();
      }
      if (o.showLabels && (px > 0.14 || !parked) && (px > 0.07 || isSel || pending)) {
        const lines = [ac.callsign];
        if (!parked && px > 0.1) lines.push(ac.phase === 'holding_short' ? `HS ${ac.rwy}` : ac.kind === 'departure' ? `→${ac.rwy ?? '?'}` : `→${ac.gate ?? '?'}`);
        else if (parked && px > 0.35) lines.push(ac.turn?.stage === 'ready' ? (ac.depCleared ? 'RDY PUSH' : 'RDY') : `${Math.round((ac.turn?.progress ?? 0) * 100)}%`);
        const off = Math.max(12, typeOf(ac.type).span * px * 0.55);
        label(ctx, lines, x + off, y - off * 0.4, parked ? (ac.turn?.stage === 'ready' ? C.amber : '#7f93a8') : col, undefined, isSel ? C.white : undefined);
      }
      continue;
    }
    // airborne
    if (o.showTrails) {
      ctx.fillStyle = col;
      for (let i = 0; i < ac.trail.length; i += 2) {
        const [hx, hy] = P(ac.trail[i], ac.trail[i + 1]);
        ctx.globalAlpha = 0.15 + (0.5 * i) / Math.max(2, ac.trail.length);
        ctx.fillRect(hx - 1, hy - 1, 2, 2);
      }
      ctx.globalAlpha = 1;
    }
    if (o.showVectors) {
      const [ux, uy] = vecOf(ac.track);
      const [vx, vy] = P(ac.x + ux * ac.gs * KT * 60, ac.y + uy * ac.gs * KT * 60);
      ctx.strokeStyle = col; ctx.globalAlpha = 0.7; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(vx, vy); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (radar && px < 0.05) {
      ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (ac.kind === 'departure') { ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); }
      else ctx.rect(x - 4, y - 4, 8, 8);
      ctx.stroke();
      ctx.fillStyle = col; ctx.fillRect(x - 1, y - 1, 2, 2);
    } else {
      // shadow + sprite, larger with altitude so climb/descent is visible in the ground view
      const lift = Math.min(18, ac.alt / 180);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(x + lift * 0.6, y + lift, 7, 3, 0, 0, Math.PI * 2); ctx.fill();
      drawPlane(ctx, ac, x, y, ac.hdg, px, { minPx: 15, boost: 1 + Math.min(0.5, ac.alt / 6000), outline: col });
    }
    if (isSel) { ctx.strokeStyle = C.white; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke(); }
    if ((em || alert) && blink) { ctx.strokeStyle = em || alert!.level !== 'predict' ? C.red : C.amber; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.stroke(); }
    // data tag
    const alt = String(Math.round(ac.alt / 100)).padStart(3, '0');
    const trend = ac.vs > 300 ? '↑' : ac.vs < -300 ? '↓' : '=';
    const tgt = Math.abs(ac.tgtAlt - ac.alt) > 150 ? String(Math.round(ac.tgtAlt / 100)).padStart(3, '0') : '';
    const lines: string[] = [];
    const t = typeOf(ac.type);
    lines.push(`${ac.callsign}${t.wake === 'H' ? ' H' : t.wake === 'J' ? ' J' : ''}${em ? ' EM' : ''}`);
    if (o.tagLevel >= 1 || isSel) lines.push(`${alt}${trend}${tgt} ${String(Math.round(ac.gs / 10)).padStart(2, '0')}`);
    if (o.tagLevel >= 2 || isSel) lines.push(`${ac.type} ${ac.phase === 'final' || ac.phase === 'approach' ? `ILS${ac.rwy}` : ac.latMode === 'hdg' ? `H${String(Math.round(ac.tgtHdg) || 360).padStart(3, '0')}` : ac.latMode === 'hold' ? `HOLD ${ac.fix ?? ''}` : ac.fix ?? ''}${ac.landCleared ? ' CTL' : ''}`);
    const pending = ac.request && (ac.request.deferredUntil ?? 0) < s.t;
    const lx = x + 16, ly = y - 14;
    ctx.strokeStyle = col; ctx.globalAlpha = 0.6; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 6, y - 6); ctx.lineTo(lx - 2, ly + 2); ctx.stroke();
    ctx.globalAlpha = 1;
    label(ctx, lines, lx, ly, col, undefined, isSel ? C.white : pending && blink ? C.amber : undefined);
  }

  // ── weather overlay (precipitation / fog) on the ground view ──
  if (o.showWeather && !radar) {
    const wx = s.weather;
    if (wx.visSM < 3) { ctx.fillStyle = `rgba(150,165,180,${clamp(0.32 - wx.visSM * 0.09, 0.04, 0.3)})`; ctx.fillRect(0, 0, W, H); }
    if (wx.precip === 'rain' || wx.precip === 'heavy_rain' || wx.precip === 'thunderstorm' || wx.precip === 'snow') {
      const snow = wx.precip === 'snow';
      const n = wx.precip === 'rain' ? 90 : 170;
      ctx.strokeStyle = snow ? 'rgba(235,240,250,0.5)' : 'rgba(140,180,220,0.28)';
      ctx.fillStyle = 'rgba(235,240,250,0.55)';
      ctx.lineWidth = 1;
      const [wxu] = vecOf(norm360(wx.windDir + 180));
      for (let i = 0; i < n; i++) {
        const sx = ((i * 9301 + 49297) % 233280) / 233280 * W;
        const sp = snow ? 40 : 520;
        const sy = ((((i * 7919) % 1000) / 1000) * H + o.time * sp * (0.7 + (i % 5) * 0.1)) % H;
        if (snow) ctx.fillRect((sx + Math.sin(o.time + i) * 6 + W) % W, sy, 1.6, 1.6);
        else { ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + wxu * 5, sy + 11); ctx.stroke(); }
      }
    }
  }

  // ── scale bar, north arrow, wind ──
  const barM = [50, 100, 200, 500, 1000, 1852, 1852 * 5, 1852 * 10].find((m) => m * px > 60) ?? 1852 * 20;
  const bx = 14, by = H - 16;
  ctx.strokeStyle = C.dim; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + barM * px, by); ctx.lineTo(bx + barM * px, by - 4); ctx.stroke();
  ctx.fillStyle = C.dim;
  ctx.fillText(barM >= 1852 ? `${Math.round(barM / 1852)} NM` : `${barM} m`, bx + 4, by - 6);
  const nx = W - 34, ny = 40;
  ctx.strokeStyle = C.dim; ctx.fillStyle = C.dim;
  ctx.beginPath(); ctx.moveTo(nx, ny - 14); ctx.lineTo(nx + 5, ny); ctx.lineTo(nx, ny - 4); ctx.lineTo(nx - 5, ny); ctx.closePath(); ctx.fill();
  ctx.fillText('N', nx - 3.5, ny + 14);
  const wxv = s.weather;
  if (wxv.windKt >= 1.5) {
    const [ux, uy] = vecOf(norm360(wxv.windDir + 180));
    const wx0 = W - 34, wy0 = 86;
    ctx.strokeStyle = C.cyan; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(wx0 - ux * 12, wy0 + uy * 12); ctx.lineTo(wx0 + ux * 12, wy0 - uy * 12); ctx.stroke();
    ctx.fillStyle = C.cyan;
    ctx.beginPath(); ctx.arc(wx0 + ux * 12, wy0 - uy * 12, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillText(`${Math.round(wxv.windKt)}kt`, wx0 - 13, wy0 + 26);
  }
}

/** nearest aircraft to a screen point */
export function pick(sim: Sim, cam: Camera, W: number, H: number, sx: number, sy: number, mode: 'radar' | 'ground'): Aircraft | undefined {
  let best: Aircraft | undefined, bd = 1e9;
  const detail = cam.scale > 0.035;
  for (const ac of sim.s.aircraft) {
    if (ac.phase === 'gone') continue;
    const air = isAirborne(ac);
    if (!air && !detail) continue;
    const [x, y] = w2s(cam, W, H, ac.x, ac.y);
    const r = Math.max(air ? 16 : 12, typeOf(ac.type).length * cam.scale * 0.6);
    const d = Math.hypot(x - sx, y - sy);
    // prefer airborne targets slightly on the radar, surface targets on the ground view
    const bias = (mode === 'radar') === air ? 0 : 4;
    if (d < r && d + bias < bd) { bd = d + bias; best = ac; }
  }
  return best;
}

export { gateByName };
