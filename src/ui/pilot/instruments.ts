/** Canvas renderers for the glass-cockpit displays: PFD, navigation display / moving map, engine display. */
import { DEG, FT, KT, NM, angDiff, clamp, dist, hdgOf, norm360 } from '../../sim/util';
import { ACDEF, stallKt } from '../../pilot/aircraft';
import { indicatedAlt, isJet, takeoffTrim } from '../../pilot/systems';
import { distToGo, windAt } from '../../pilot/world';
import type { PilotState } from '../../pilot/types';

const C = { sky: '#2a6fb5', gnd: '#7a5230', white: '#f2f5f8', mag: '#ff5cf4', green: '#3be07a', amber: '#ffb703', red: '#ff4d5a', cyan: '#4cc9f0', bg: '#06090d', dim: '#7d8ea3', tape: '#1b222b' };
const F = (px: number, bold = false) => `${bold ? '600 ' : ''}${px}px ui-monospace, SFMono-Regular, Menlo, monospace`;

export function fit(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function dark(ctx: CanvasRenderingContext2D, w: number, h: number, msg?: string) {
  ctx.fillStyle = '#020304';
  ctx.fillRect(0, 0, w, h);
  if (msg) { ctx.fillStyle = '#2b3440'; ctx.font = F(11); ctx.textAlign = 'center'; ctx.fillText(msg, w / 2, h / 2); }
}

const fmaLat = (p: PilotState) => ({ off: '', hdg: 'HDG SEL', lnav: 'LNAV', loc: 'LOC', rollout: 'ROLLOUT' })[p.ap.lat];
const fmaVert = (p: PilotState) => ({ off: '', alt: 'ALT HOLD', altacq: 'ALT ACQ', vs: 'V/S', flch: 'FLCH SPD', gs: 'G/S', toga: 'TO/GA' })[p.ap.vert];

export function drawPFD(cv: HTMLCanvasElement, p: PilotState) {
  const f = fit(cv);
  if (!f) return;
  const { ctx, w, h } = f;
  if (!p.sys.avionics) return dark(ctx, w, h, isJet(p) ? 'NO ELECTRICAL POWER' : 'AVIONICS OFF');
  const { ac, ap } = p;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  const top = 20, bot = 30;
  const tapeW = 46, altW = 56, vsW = 20;
  const ax = tapeW + 6, aw = w - tapeW - altW - vsW - 14, ay = top + 4, ah = h - top - bot - 8;
  const cx = ax + aw / 2, cy = ay + ah / 2;
  const ppd = ah / 44; // pixels per degree of pitch
  const aligned = p.sys.align >= 1;

  // ── attitude ──
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(ax, ay, aw, ah, 8);
  ctx.clip();
  if (aligned) {
    ctx.translate(cx, cy);
    ctx.rotate(-ac.bank * DEG);
    ctx.translate(0, ac.pitch * ppd);
    ctx.fillStyle = C.sky;
    ctx.fillRect(-400, -800, 800, 800);
    ctx.fillStyle = C.gnd;
    ctx.fillRect(-400, 0, 800, 800);
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-400, 0); ctx.lineTo(400, 0); ctx.stroke();
    ctx.fillStyle = C.white;
    ctx.font = F(9);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let d = -30; d <= 30; d += 2.5) {
      if (d === 0) continue;
      const y = -d * ppd;
      const half = d % 10 === 0 ? 26 : d % 5 === 0 ? 14 : 7;
      ctx.beginPath(); ctx.moveTo(-half, y); ctx.lineTo(half, y); ctx.stroke();
      if (d % 10 === 0) { ctx.fillText(String(Math.abs(d)), -half - 9, y); ctx.fillText(String(Math.abs(d)), half + 9, y); }
    }
  } else {
    ctx.fillStyle = '#10151b';
    ctx.fillRect(ax, ay, aw, ah);
    ctx.fillStyle = C.amber;
    ctx.font = F(14, true);
    ctx.textAlign = 'center';
    ctx.fillText('ATT', cx, cy - 6);
    ctx.font = F(9);
    ctx.fillText(`IRS ALIGN ${Math.round(p.sys.align * 100)}%`, cx, cy + 10);
  }
  ctx.restore();
  if (aligned) {
    // bank scale + pointer + slip
    ctx.save();
    ctx.translate(cx, cy);
    const R = ah / 2 - 6;
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 1.2;
    for (const b of [-45, -30, -20, -10, 0, 10, 20, 30, 45]) {
      const a = (b - 90) * DEG;
      const l = b % 30 === 0 ? 8 : 5;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * R, Math.sin(a) * R); ctx.lineTo(Math.cos(a) * (R - l), Math.sin(a) * (R - l)); ctx.stroke();
    }
    ctx.rotate(-ac.bank * DEG);
    ctx.fillStyle = Math.abs(ac.bank) > 35 ? C.amber : C.white;
    ctx.beginPath(); ctx.moveTo(0, -R + 9); ctx.lineTo(-6, -R + 19); ctx.lineTo(6, -R + 19); ctx.closePath(); ctx.fill();
    const slip = clamp(ac.beta * 2.2 + (ac.onGround ? 0 : 0), -14, 14);
    ctx.fillStyle = Math.abs(ac.beta) > 3 ? C.amber : C.white;
    ctx.fillRect(-7 + slip, -R + 21, 14, 4);
    ctx.restore();
    // flight director
    if (ap.fd && (ap.lat !== 'off' || ap.vert !== 'off')) {
      ctx.strokeStyle = C.mag;
      ctx.lineWidth = 2.5;
      const py = cy - clamp(ap.fdPitch - ac.pitch, -12, 12) * ppd;
      const bx = cx + clamp(ap.fdBank - ac.bank, -30, 30) * 1.6;
      ctx.beginPath(); ctx.moveTo(cx - 34, py); ctx.lineTo(cx + 34, py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx, cy - 34); ctx.lineTo(bx, cy + 34); ctx.stroke();
    }
    // aircraft symbol
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 5;
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      ctx.moveTo(cx - 44, cy); ctx.lineTo(cx - 18, cy); ctx.lineTo(cx - 18, cy + 7);
      ctx.moveTo(cx + 44, cy); ctx.lineTo(cx + 18, cy); ctx.lineTo(cx + 18, cy + 7);
      ctx.stroke();
      ctx.strokeStyle = '#ffd60a';
      ctx.lineWidth = 2.5;
    }
    ctx.fillStyle = '#ffd60a';
    ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
    // radio altitude
    const ra = ac.agl / FT;
    if (ra < 2500 && !ac.onGround) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(cx - 22, ay + ah - 20, 44, 15);
      ctx.fillStyle = ra < 200 ? C.amber : C.white;
      ctx.font = F(12, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(Math.round(ra / (ra < 100 ? 2 : 10)) * (ra < 100 ? 2 : 10)), cx, ay + ah - 12);
    }
  }

  // ── speed tape ──
  const sx = 2, sy = ay, sh = ah;
  ctx.fillStyle = C.tape;
  ctx.fillRect(sx, sy, tapeW, sh);
  ctx.save();
  ctx.beginPath(); ctx.rect(sx, sy, tapeW, sh); ctx.clip();
  const ppk = sh / 110; // px per knot
  const ias = Math.max(jet ? 30 : 20, ac.ias);
  const yOf = (k: number) => sy + sh / 2 - (k - ias) * ppk;
  const vs1 = stallKt(def, ac.mass, ac.flaps) * Math.sqrt(Math.max(1, ac.g));
  const vmax = Math.min(def.vmo, ac.flaps > 0.05 ? def.flaps[Math.ceil(ac.flaps - 0.01)].vfe : 999, def.retract && ac.gear > 0.05 ? def.vle : 999);
  ctx.fillStyle = C.red;
  ctx.fillRect(sx + tapeW - 5, yOf(vs1), 5, 400);
  ctx.fillRect(sx + tapeW - 5, yOf(vmax) - 400, 5, 400);
  ctx.fillStyle = C.amber;
  ctx.fillRect(sx + tapeW - 5, yOf(vs1 * 1.2), 3, yOf(vs1) - yOf(vs1 * 1.2));
  ctx.strokeStyle = C.white;
  ctx.fillStyle = C.white;
  ctx.font = F(10);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let k = Math.floor((ias - 60) / 10) * 10; k <= ias + 60; k += 10) {
    if (k < 0) continue;
    const y = yOf(k);
    ctx.beginPath(); ctx.moveTo(sx + tapeW - 12, y); ctx.lineTo(sx + tapeW - 6, y); ctx.stroke();
    if (k % 20 === 0) ctx.fillText(String(k), sx + tapeW - 15, y);
  }
  // bugs
  const bug = (k: number, label: string, col: string) => {
    const y = yOf(k);
    if (y < sy - 5 || y > sy + sh + 5) return;
    ctx.fillStyle = col;
    ctx.font = F(8, true);
    ctx.textAlign = 'left';
    ctx.fillText(label, sx + 1, y);
    ctx.fillRect(sx + tapeW - 8, y - 1, 8, 2);
  };
  if (p.phase === 'takeoff' || p.phase === 'before_takeoff' || p.phase === 'taxi_out') { if (jet) bug(p.vspeeds.v1, 'V1', C.green); bug(p.vspeeds.vr, 'VR', C.green); bug(p.vspeeds.v2, jet ? 'V2' : 'VY', C.green); }
  if (p.phase === 'approach' || p.phase === 'landing' || p.phase === 'descent') { bug(p.vspeeds.vref, 'REF', C.green); }
  if (jet || ap.vert === 'flch') { ctx.fillStyle = C.mag; const y = clamp(yOf(ap.selSpd), sy + 3, sy + sh - 3); ctx.beginPath(); ctx.moveTo(sx + tapeW, y); ctx.lineTo(sx + tapeW - 9, y - 5); ctx.lineTo(sx + tapeW - 9, y + 5); ctx.closePath(); ctx.fill(); }
  ctx.restore();
  // speed box
  ctx.fillStyle = '#000';
  ctx.strokeStyle = p.sys.stallWarn || p.sys.overspeed ? C.red : C.white;
  ctx.lineWidth = 1.5;
  ctx.fillRect(sx, sy + sh / 2 - 11, tapeW - 6, 22);
  ctx.strokeRect(sx, sy + sh / 2 - 11, tapeW - 6, 22);
  ctx.fillStyle = p.sys.stallWarn || p.sys.overspeed ? C.red : C.white;
  ctx.font = F(15, true);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(ac.ias < (jet ? 30 : 20) ? '--' : String(Math.round(ac.ias)), sx + tapeW - 9, sy + sh / 2 + 1);
  ctx.font = F(10, true);
  ctx.textAlign = 'center';
  ctx.fillStyle = C.mag;
  if (jet || ap.vert === 'flch') ctx.fillText(String(ap.selSpd), sx + tapeW / 2, sy - 7 + 0);
  if (ac.mach > 0.4) { ctx.fillStyle = C.white; ctx.fillText('.' + String(Math.round(ac.mach * 1000)).padStart(3, '0'), sx + tapeW / 2, sy + sh + 9); }
  else { ctx.fillStyle = C.dim; ctx.font = F(9); ctx.fillText(`GS ${Math.round(ac.gs / KT)}`, sx + tapeW / 2, sy + sh + 9); }

  // ── altitude tape ──
  const tx = w - altW - vsW - 2;
  const alt = indicatedAlt(p);
  ctx.fillStyle = C.tape;
  ctx.fillRect(tx, sy, altW, sh);
  ctx.save();
  ctx.beginPath(); ctx.rect(tx, sy, altW, sh); ctx.clip();
  const ppf = sh / 900;
  const ya = (a: number) => sy + sh / 2 - (a - alt) * ppf;
  ctx.strokeStyle = C.white;
  ctx.fillStyle = C.white;
  ctx.font = F(10);
  ctx.textAlign = 'left';
  for (let a = Math.floor((alt - 500) / 100) * 100; a <= alt + 500; a += 100) {
    const y = ya(a);
    ctx.beginPath(); ctx.moveTo(tx, y); ctx.lineTo(tx + (a % 500 === 0 ? 9 : 5), y); ctx.stroke();
    if (a % 200 === 0) ctx.fillText(String(a), tx + 12, y);
  }
  // ground reference
  const gndAlt = alt - ac.agl / FT;
  if (ya(gndAlt) < sy + sh) { ctx.fillStyle = 'rgba(255,183,3,0.35)'; ctx.fillRect(tx, ya(gndAlt), altW, 400); }
  if (ap.selAlt) { ctx.fillStyle = C.mag; const y = clamp(ya(ap.selAlt), sy + 3, sy + sh - 3); ctx.beginPath(); ctx.moveTo(tx, y); ctx.lineTo(tx + 9, y - 6); ctx.lineTo(tx + 9, y + 6); ctx.closePath(); ctx.fill(); }
  if (p.atc.alt && p.atc.alt !== ap.selAlt) { ctx.fillStyle = C.cyan; const y = clamp(ya(p.atc.alt), sy + 3, sy + sh - 3); ctx.fillRect(tx, y - 1, 12, 2); }
  ctx.restore();
  ctx.fillStyle = '#000';
  ctx.strokeStyle = C.white;
  ctx.fillRect(tx + 6, sy + sh / 2 - 11, altW - 6, 22);
  ctx.strokeRect(tx + 6, sy + sh / 2 - 11, altW - 6, 22);
  ctx.fillStyle = C.white;
  ctx.font = F(14, true);
  ctx.textAlign = 'right';
  ctx.fillText(String(Math.round(alt / 10) * 10), tx + altW - 3, sy + sh / 2 + 1);
  ctx.font = F(10, true);
  ctx.textAlign = 'center';
  ctx.fillStyle = C.mag;
  if (ap.selAlt) ctx.fillText(String(ap.selAlt), tx + altW / 2, sy - 7);
  const baroWrong = !p.radios.std && Math.abs(p.radios.baro - p.airports[0].qnh) > 60;
  ctx.fillStyle = p.radios.std ? C.green : baroWrong ? C.amber : C.green;
  ctx.fillText(p.radios.std ? 'STD' : `${p.radios.baro} HPA`, tx + altW / 2, sy + sh + 9);

  // ── vertical speed ──
  const vx = w - vsW;
  ctx.fillStyle = C.tape;
  ctx.fillRect(vx, sy + 14, vsW - 2, sh - 28);
  const fpm = (ac.vs / FT) * 60;
  const vy = (v: number) => sy + sh / 2 - (Math.sign(v) * Math.sqrt(Math.min(Math.abs(v), 6000) / 6000)) * (sh / 2 - 18);
  ctx.strokeStyle = C.dim;
  ctx.fillStyle = C.dim;
  ctx.font = F(8);
  ctx.textAlign = 'left';
  for (const v of [-6000, -2000, -1000, 0, 1000, 2000, 6000]) { ctx.beginPath(); ctx.moveTo(vx, vy(v)); ctx.lineTo(vx + 4, vy(v)); ctx.stroke(); if (v) ctx.fillText(String(Math.abs(v / 1000)), vx + 6, vy(v)); }
  ctx.strokeStyle = C.white;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(vx + vsW - 2, sy + sh / 2); ctx.lineTo(vx + 2, vy(fpm)); ctx.stroke();
  if (Math.abs(fpm) > 150) { ctx.fillStyle = C.white; ctx.font = F(9, true); ctx.textAlign = 'right'; ctx.fillText(String(Math.round(Math.abs(fpm) / 50) * 50), w - 2, fpm > 0 ? sy + 7 : sy + sh - 5); }
  if (ap.vert === 'vs') { ctx.fillStyle = C.mag; ctx.fillRect(vx, vy(ap.selVs) - 1, 6, 2); }

  // ── ILS ──
  if (p.ils.valid && aligned) {
    const ly = ay + ah - 4;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(cx - 52, ly - 9, 104, 10);
    ctx.fillStyle = C.white;
    for (const d of [-2, -1, 1, 2]) { ctx.beginPath(); ctx.arc(cx + d * 22, ly - 4, 2, 0, 7); ctx.fill(); }
    ctx.fillRect(cx - 0.5, ly - 9, 1, 10);
    ctx.fillStyle = C.mag;
    const lx = cx + clamp(p.ils.loc, -2.3, 2.3) * 22;
    ctx.beginPath(); ctx.moveTo(lx, ly - 9); ctx.lineTo(lx + 5, ly - 4); ctx.lineTo(lx, ly + 1); ctx.lineTo(lx - 5, ly - 4); ctx.closePath(); ctx.fill();
    if (p.ils.gsValid) {
      const gx = ax + aw - 5;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(gx - 5, cy - 50, 10, 100);
      ctx.fillStyle = C.white;
      for (const d of [-2, -1, 1, 2]) { ctx.beginPath(); ctx.arc(gx, cy + d * 21, 2, 0, 7); ctx.fill(); }
      ctx.fillRect(gx - 5, cy - 0.5, 10, 1);
      ctx.fillStyle = C.mag;
      const gy = cy - clamp(p.ils.gs, -2.3, 2.3) * 21;
      ctx.beginPath(); ctx.moveTo(gx - 5, gy); ctx.lineTo(gx, gy - 5); ctx.lineTo(gx + 5, gy); ctx.lineTo(gx, gy + 5); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = C.white;
    ctx.font = F(8);
    ctx.textAlign = 'left';
    ctx.fillText(`ILS ${p.radios.nav.act.toFixed(2)}  DME ${p.ils.dme.toFixed(1)}`, ax + 3, ay + 7);
  }

  // ── heading strip ──
  const hy = h - bot + 4;
  ctx.fillStyle = C.tape;
  ctx.fillRect(ax, hy, aw, bot - 6);
  ctx.save();
  ctx.beginPath(); ctx.rect(ax, hy, aw, bot - 6); ctx.clip();
  const pph = aw / 70;
  ctx.strokeStyle = C.white;
  ctx.fillStyle = C.white;
  ctx.font = F(9);
  ctx.textAlign = 'center';
  ctx.lineWidth = 1;
  for (let d = -40; d <= 40; d++) {
    const hd = Math.round(ac.hdg) + d;
    if (hd % 5) continue;
    const x = cx + angDiff(ac.hdg, hd) * pph;
    ctx.beginPath(); ctx.moveTo(x, hy); ctx.lineTo(x, hy + (hd % 10 === 0 ? 6 : 3)); ctx.stroke();
    if (hd % 10 === 0) ctx.fillText(String(Math.round(norm360(hd) / 10)).padStart(2, '0'), x, hy + 13);
  }
  const hb = cx + clamp(angDiff(ac.hdg, ap.selHdg), -34, 34) * pph;
  ctx.fillStyle = C.mag;
  ctx.fillRect(hb - 5, hy, 10, 4);
  if (!ac.onGround) { const tk = cx + clamp(angDiff(ac.hdg, ac.gtrk), -34, 34) * pph; ctx.strokeStyle = C.green; ctx.strokeRect(tk - 3, hy + 1, 6, 5); }
  ctx.restore();
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - 17, hy + 8, 34, 15);
  ctx.strokeStyle = C.white;
  ctx.strokeRect(cx - 17, hy + 8, 34, 15);
  ctx.fillStyle = C.white;
  ctx.font = F(12, true);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(norm360(ac.hdg)) % 360).padStart(3, '0'), cx, hy + 16);

  // ── flight mode annunciator ──
  ctx.fillStyle = '#0d1218';
  ctx.fillRect(ax, 1, aw, top - 2);
  ctx.strokeStyle = '#2a3440';
  ctx.lineWidth = 1;
  const col = aw / 4;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(ax + col * i, 1); ctx.lineTo(ax + col * i, top - 1); ctx.stroke(); }
  ctx.font = F(9, true);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cell = (i: number, t: string, c: string) => { ctx.fillStyle = c; ctx.fillText(t, ax + col * (i + 0.5), top / 2 - 3); };
  cell(0, ap.at ? ({ off: 'ARM', spd: 'SPD', n1: 'N1', idle: 'RETARD' })[ap.atMode] : '', C.green);
  cell(1, fmaLat(p) ?? '', C.green);
  cell(2, fmaVert(p) ?? '', C.green);
  cell(3, ap.cmd ? 'CMD' : ap.fd ? 'FD' : '', ap.cmd ? C.green : C.white);
  ctx.font = F(7);
  ctx.fillStyle = C.white;
  if (ap.locArmed) ctx.fillText('LOC', ax + col * 1.5, top - 4);
  if (ap.gsArmed) ctx.fillText('G/S', ax + col * 2.5, top - 4);

  // big warnings
  const warn = p.sys.warnings[0];
  if (warn) {
    ctx.fillStyle = 'rgba(160,0,10,0.85)';
    ctx.fillRect(cx - 50, ay + 10, 100, 16);
    ctx.fillStyle = '#fff';
    ctx.font = F(11, true);
    ctx.fillText(warn, cx, ay + 18);
  }
}

export interface NdOpts { range: number; chart: boolean }

export function drawND(cv: HTMLCanvasElement, p: PilotState, o: NdOpts) {
  const f = fit(cv);
  if (!f) return;
  const { ctx, w, h } = f;
  if (!p.sys.avionics) return dark(ctx, w, h, 'OFF');
  const { ac } = p;
  const jet = isJet(p);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  if (jet && p.sys.align < 1) { ctx.fillStyle = C.amber; ctx.font = F(13, true); ctx.textAlign = 'center'; ctx.fillText('MAP', w / 2, h / 2); ctx.font = F(9); ctx.fillText('waiting for IRS alignment', w / 2, h / 2 + 16); return; }
  // chart mode: north-up centred on the aircraft; otherwise track-up with the aircraft low on the display
  const up = o.chart ? 0 : ac.onGround ? ac.hdg : ac.gtrk;
  const ox = w / 2, oy = o.chart ? h / 2 : h - 46;
  const R = o.chart ? Math.min(w, h) / 2 - 6 : h - 76;
  const scale = R / (o.range * NM);
  const cs = Math.cos(up * DEG), sn = Math.sin(up * DEG);
  const P = (x: number, y: number): [number, number] => {
    const dx = (x - ac.x) * scale, dy = (y - ac.y) * scale;
    return [ox + dx * cs - dy * sn, oy - (dx * sn + dy * cs)];
  };
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();

  // range rings / compass
  if (!o.chart) {
    ctx.strokeStyle = '#33404e';
    ctx.lineWidth = 1;
    for (const k of [0.5, 1]) { ctx.beginPath(); ctx.arc(ox, oy, R * k, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke(); }
    ctx.fillStyle = C.dim;
    ctx.font = F(8);
    ctx.textAlign = 'left';
    ctx.fillText(String(o.range / 2), ox + 3, oy - R / 2 - 3);
    ctx.fillStyle = C.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 10) {
      const rel = angDiff(up, d);
      if (Math.abs(rel) > 62) continue;
      const a = (rel - 90) * DEG;
      ctx.strokeStyle = C.white;
      ctx.beginPath(); ctx.moveTo(ox + Math.cos(a) * R, oy + Math.sin(a) * R); ctx.lineTo(ox + Math.cos(a) * (R - (d % 30 ? 4 : 8)), oy + Math.sin(a) * (R - (d % 30 ? 4 : 8))); ctx.stroke();
      if (d % 30 === 0) ctx.fillText(String(d / 10), ox + Math.cos(a) * (R - 15), oy + Math.sin(a) * (R - 15));
    }
  }

  // airports
  for (const pa of p.airports) {
    const d = dist(ac.x, ac.y, pa.ox, pa.oy);
    if (d > o.range * NM * 2.2 + 8000) continue;
    const ap = pa.ap;
    const detail = o.range <= 5;
    if (detail) {
      ctx.strokeStyle = '#3a4756';
      ctx.lineWidth = Math.max(1, 22 * scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const e of ap.edges) {
        if (e.kind === 'runway') continue;
        const a = ap.nodes[e.a], b = ap.nodes[e.b];
        const [x1, y1] = P(a.x + pa.ox, a.y + pa.oy), [x2, y2] = P(b.x + pa.ox, b.y + pa.oy);
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      }
      ctx.stroke();
      ctx.fillStyle = '#18222d';
      for (const t of ap.terminals) {
        ctx.beginPath();
        t.poly.forEach(([x, y], i) => { const [px, py] = P(x + pa.ox, y + pa.oy); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
        ctx.closePath(); ctx.fill();
      }
    }
    for (const r of ap.runways) {
      const [x1, y1] = P(r.ends[0].x + pa.ox, r.ends[0].y + pa.oy), [x2, y2] = P(r.ends[1].x + pa.ox, r.ends[1].y + pa.oy);
      ctx.strokeStyle = detail ? '#9aa7b5' : C.white;
      ctx.lineWidth = Math.max(2, r.width * scale);
      ctx.lineCap = 'butt';
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (detail || o.range <= 20) {
        ctx.fillStyle = C.white;
        ctx.font = F(9, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const ux = (x2 - x1) / (Math.hypot(x2 - x1, y2 - y1) || 1), uy = (y2 - y1) / (Math.hypot(x2 - x1, y2 - y1) || 1);
        ctx.fillText(r.ends[0].name, x1 - ux * 12, y1 - uy * 12);
        ctx.fillText(r.ends[1].name, x2 + ux * 12, y2 + uy * 12);
      }
    }
    if (detail && o.range <= 2.5) {
      // taxiway names and gates
      ctx.font = F(8);
      ctx.fillStyle = '#c9a227';
      ctx.textAlign = 'center';
      const seen = new Set<string>();
      for (const e of ap.edges) {
        if (!e.name || e.kind !== 'taxiway' || e.len < 150) continue;
        const a = ap.nodes[e.a], b = ap.nodes[e.b];
        const key = e.name + Math.round((a.x + b.x) / 700) + ':' + Math.round((a.y + b.y) / 700);
        if (seen.has(key)) continue;
        seen.add(key);
        const [mx, my] = P((a.x + b.x) / 2 + pa.ox, (a.y + b.y) / 2 + pa.oy);
        ctx.fillText(e.name, mx, my);
      }
      ctx.fillStyle = C.dim;
      for (const g of ap.gates) {
        if (g.name !== p.depGate && g.name !== p.arrGate) continue;
        const n = ap.nodes[g.node];
        const [gx, gy] = P(n.x + pa.ox, n.y + pa.oy);
        ctx.fillStyle = C.cyan;
        ctx.fillText(g.name, gx, gy - 8);
        ctx.beginPath(); ctx.arc(gx, gy, 3, 0, 7); ctx.fill();
      }
    }
    if (!detail) { const [ax2, ay2] = P(pa.ox, pa.oy); ctx.fillStyle = C.cyan; ctx.font = F(9, true); ctx.textAlign = 'left'; ctx.fillText(ap.icao, ax2 + 8, ay2 + 10); }
  }

  // cleared taxi route
  const showTaxi = p.taxi && (p.atc.clearedTaxi || p.atc.clearedTaxiIn) && ac.onGround && (p.phase === 'taxi_in' ? p.atc.clearedTaxiIn : true);
  if (showTaxi && o.range <= 5) {
    ctx.strokeStyle = C.mag;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    p.taxi!.pts.forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.stroke();
    if (p.taxi!.hold && !(p.atc.clearedLineup || p.atc.clearedTakeoff)) { const [hx, hy] = P(p.taxi!.hold[0], p.taxi!.hold[1]); ctx.strokeStyle = C.red; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(hx, hy, 6, 0, 7); ctx.stroke(); }
  }

  // extended centreline of the landing runway
  {
    const r = p.arrRwy;
    const [tx, ty] = P(r.thrX, r.thrY);
    const far = 12 * NM;
    const [fx, fy] = P(r.thrX - Math.sin(r.hdg * DEG) * far, r.thrY - Math.cos(r.hdg * DEG) * far);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.setLineDash([]);
  }

  // route
  if (o.range > 1) {
    ctx.strokeStyle = C.mag;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let i = Math.max(0, p.leg - 1); i < p.route.length; i++) {
      const [x, y] = P(p.route[i].x, p.route[i].y);
      if (!started) { if (i === p.leg) { ctx.moveTo(ox, oy); ctx.lineTo(x, y); } else ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.font = F(9);
    ctx.textAlign = 'left';
    for (let i = 0; i < p.route.length; i++) {
      const wp = p.route[i];
      const [x, y] = P(wp.x, wp.y);
      if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
      ctx.strokeStyle = i === p.leg ? C.mag : C.white;
      ctx.fillStyle = i === p.leg ? C.mag : C.white;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.stroke();
      ctx.fillText(wp.name, x + 7, y - 2);
      if (wp.alt && wp.kind !== 'rwy') { ctx.fillStyle = C.dim; ctx.fillText(String(wp.alt), x + 7, y + 8); }
    }
  }
  ctx.restore();

  // heading bug + aircraft symbol
  if (!o.chart) {
    const hb = angDiff(up, p.ap.selHdg);
    if (Math.abs(hb) < 62) { const a = (hb - 90) * DEG; ctx.fillStyle = C.mag; ctx.beginPath(); ctx.arc(ox + Math.cos(a) * R, oy + Math.sin(a) * R, 4, 0, 7); ctx.fill(); }
  }
  ctx.save();
  ctx.translate(ox, oy);
  ctx.rotate((ac.hdg - up) * DEG);
  ctx.strokeStyle = C.white;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(0, 9); ctx.moveTo(-10, 0); ctx.lineTo(10, 0); ctx.moveTo(-4, 8); ctx.lineTo(4, 8); ctx.stroke();
  ctx.restore();

  // data blocks
  const wnd = windAt(p, ac.x, ac.y, ac.z);
  ctx.fillStyle = C.white;
  ctx.font = F(10);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`GS ${Math.round(ac.gs / KT)}  TAS ${Math.round(ac.tas / KT)}`, 4, 12);
  ctx.fillText(`${String(Math.round(wnd.dir)).padStart(3, '0')}°/${Math.round(wnd.kt)}`, 4, 24);
  // wind arrow relative to the display
  ctx.save();
  ctx.translate(16, 38);
  ctx.rotate((wnd.dir + 180 - up) * DEG);
  ctx.strokeStyle = C.white;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, 8); ctx.lineTo(0, -8); ctx.lineTo(-3, -3); ctx.moveTo(0, -8); ctx.lineTo(3, -3); ctx.stroke();
  ctx.restore();
  if (p.leg < p.route.length) {
    const wp = p.route[p.leg];
    const d = dist(ac.x, ac.y, wp.x, wp.y) / NM;
    ctx.textAlign = 'right';
    ctx.fillStyle = C.mag;
    ctx.fillText(wp.name, w - 4, 12);
    ctx.fillStyle = C.white;
    ctx.fillText(`${d.toFixed(d < 10 ? 1 : 0)} NM`, w - 4, 24);
    ctx.fillText(`${String(Math.round(hdgOf(wp.x - ac.x, wp.y - ac.y))).padStart(3, '0')}°`, w - 4, 36);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = C.dim;
  ctx.font = F(9);
  ctx.fillText(`${o.chart ? 'NORTH UP' : ac.onGround ? 'HDG UP' : 'TRK UP'} · ${o.range} NM`, w - 4, h - 5);
  ctx.textAlign = 'left';
  ctx.fillText(`TO GO ${Math.round(distToGo(p))} NM`, 4, h - 5);
}

function arcGauge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, frac: number, label: string, value: string, col: string, redFrom = 1.01) {
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#2b3642';
  ctx.beginPath(); ctx.arc(x, y, r, a0, a1); ctx.stroke();
  if (redFrom < 1) { ctx.strokeStyle = C.red; ctx.beginPath(); ctx.arc(x, y, r, a0 + (a1 - a0) * redFrom, a1); ctx.stroke(); }
  ctx.strokeStyle = col;
  ctx.beginPath(); ctx.arc(x, y, r, a0, a0 + (a1 - a0) * clamp(frac, 0, 1)); ctx.stroke();
  const a = a0 + (a1 - a0) * clamp(frac, 0, 1);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.stroke();
  ctx.fillStyle = col;
  ctx.font = F(12, true);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, x, y + r * 0.55);
  ctx.fillStyle = C.dim;
  ctx.font = F(8);
  ctx.fillText(label, x, y - r - 6);
}

export function drawENG(cv: HTMLCanvasElement, p: PilotState) {
  const f = fit(cv);
  if (!f) return;
  const { ctx, w, h } = f;
  if (!p.sys.bus) return dark(ctx, w, h, 'OFF');
  const { ac, eng, sys } = p;
  const def = ACDEF[p.cfg.aircraft];
  const jet = isJet(p);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  const r = Math.min(26, w / 7);
  let y = 0;
  if (jet) {
    const xs = [w * 0.27, w * 0.73];
    eng.forEach((e, i) => {
      arcGauge(ctx, xs[i], 40, r, e.n1 / 104, `N1 ${i + 1}`, e.n1.toFixed(1), e.running ? C.white : C.dim, 0.97);
      arcGauge(ctx, xs[i], 40 + r * 2 + 22, r * 0.8, e.egt / 950, 'EGT', String(Math.round(e.egt)), e.egt > 850 ? C.red : e.running || e.starting ? C.white : C.dim, 0.9);
      ctx.fillStyle = C.white;
      ctx.font = F(10);
      ctx.textAlign = 'center';
      ctx.fillText(`N2 ${e.n2.toFixed(0)}`, xs[i], 40 + r * 3.6 + 26);
      ctx.fillText(`FF ${(e.ff / 1000).toFixed(2)}`, xs[i], 40 + r * 3.6 + 39);
      if (ac.reverse && e.running) { ctx.fillStyle = C.green; ctx.fillText('REV', xs[i], 12); }
      if (e.starting > 0 && !e.running) { ctx.fillStyle = C.cyan; ctx.fillText('START', xs[i], 12); }
    });
    y = 40 + r * 3.6 + 50;
  } else {
    const e = eng[0];
    arcGauge(ctx, w / 2, 44, r * 1.25, e.rpm / 2800, 'RPM', String(Math.round(e.rpm / 10) * 10), e.rpm > 2700 ? C.red : e.running ? C.white : C.dim, 0.965);
    ctx.fillStyle = C.white;
    ctx.font = F(10);
    ctx.textAlign = 'left';
    const rows: [string, string, boolean][] = [
      ['FUEL FLOW', `${(e.ff / 2.72).toFixed(1)} GPH`, false],
      ['OIL PRESS', `${Math.round(e.oilP)} PSI`, e.running && e.oilP < 25],
      ['OIL TEMP', `${Math.round(e.oilT)} °C`, false],
      ['EGT', `${Math.round(e.egt)} °C`, false],
      ['MIXTURE', `${Math.round(ac.mixture * 100)} %`, false],
      ['VOLTS', sys.source === 'gen' ? '28.0' : sys.bus ? (24 * (0.9 + 0.1 * sys.batt)).toFixed(1) : '0.0', sys.source === 'battery' && e.running],
    ];
    y = 44 + r * 1.25 + 22;
    for (const [k, v, bad] of rows) { ctx.fillStyle = C.dim; ctx.textAlign = 'left'; ctx.fillText(k, 8, y); ctx.fillStyle = bad ? C.red : C.white; ctx.textAlign = 'right'; ctx.fillText(v, w - 8, y); y += 13; }
  }
  // fuel / config strip
  ctx.font = F(10);
  ctx.textAlign = 'left';
  ctx.fillStyle = C.dim;
  ctx.fillText('FUEL', 8, y + 4);
  ctx.fillStyle = ac.fuel < (jet ? 1400 : 14) ? C.amber : C.white;
  ctx.textAlign = 'right';
  ctx.fillText(jet ? `${(ac.fuel / 1000).toFixed(1)} T` : `${(ac.fuel / 2.72).toFixed(1)} GAL`, w - 8, y + 4);
  y += 16;
  // flaps
  ctx.textAlign = 'left';
  ctx.fillStyle = C.dim;
  ctx.fillText('FLAPS', 8, y + 4);
  const fx = 52, fw = w - fx - 40;
  ctx.fillStyle = '#2b3642';
  ctx.fillRect(fx, y, fw, 5);
  ctx.fillStyle = Math.abs(ac.flaps - ac.flapIdx) > 0.03 ? C.cyan : C.green;
  ctx.fillRect(fx, y, (fw * ac.flaps) / (def.flaps.length - 1), 5);
  ctx.textAlign = 'right';
  ctx.fillText(def.flaps[ac.flapIdx].label, w - 8, y + 5);
  y += 15;
  ctx.textAlign = 'left';
  ctx.fillStyle = C.dim;
  ctx.fillText('TRIM', 8, y + 4);
  ctx.fillStyle = '#2b3642';
  ctx.fillRect(fx, y, fw, 5);
  const tt = takeoffTrim(p);
  ctx.fillStyle = 'rgba(59,224,122,0.5)';
  ctx.fillRect(fx + ((tt - 0.12 + 1) / 2) * fw, y, (0.24 / 2) * fw, 5);
  ctx.fillStyle = C.white;
  ctx.fillRect(fx + ((ac.trim + 1) / 2) * fw - 1.5, y - 2, 3, 9);
  y += 15;
  if (jet) {
    ctx.fillStyle = C.dim;
    ctx.fillText('GEAR', 8, y + 4);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = ac.gear > 0.99 ? C.green : ac.gear < 0.01 ? '#2b3642' : C.red;
      ctx.fillRect(fx + i * 16, y - 2, 11, 9);
    }
    ctx.fillStyle = ac.spoiler > 0.05 ? C.amber : ac.spoilerArmed ? C.green : C.dim;
    ctx.textAlign = 'right';
    ctx.fillText(ac.spoiler > 0.05 ? `SPLR ${Math.round(ac.spoiler * 100)}` : ac.spoilerArmed ? 'SPLR ARMED' : 'SPLR DN', w - 8, y + 5);
    y += 15;
    ctx.textAlign = 'left';
    ctx.fillStyle = C.dim;
    ctx.fillText(`HYD ${Math.round(sys.hyd[0] / 100) * 100}/${Math.round(sys.hyd[1] / 100) * 100}  APU ${Math.round(sys.apuN)}%  DUCT ${Math.round(sys.duct)}`, 8, y + 5);
    y += 13;
    ctx.fillText(`ELEC ${sys.source.toUpperCase()}  CAB ALT ${Math.round(sys.cabinAlt / 100) * 100}`, 8, y + 5);
    y += 13;
  }
  if (ac.parkBrake) { ctx.fillStyle = C.red; ctx.textAlign = 'left'; ctx.fillText('PARK BRAKE', 8, y + 5); y += 13; }
  // alerts
  ctx.font = F(10, true);
  ctx.textAlign = 'left';
  for (const m of sys.warnings) { if (y > h - 4) break; ctx.fillStyle = C.red; ctx.fillText(m, 8, y + 6); y += 12; }
  for (const m of sys.cautions) { if (y > h - 4) break; ctx.fillStyle = C.amber; ctx.fillText(m, 8, y + 6); y += 12; }
}
