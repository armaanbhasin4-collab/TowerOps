import { useEffect, useRef } from 'react';
import { useUI } from '../store';
import { Camera, draw, fitAirport, fitRadar, pick, s2w } from '../render/map';
import { isAirborne } from '../sim/world';
import { NM } from '../sim/util';

/** Interactive canvas for the radar scope and the airport ground view (pan, zoom, select, follow). */
export default function MapCanvas({ mode }: { mode: 'radar' | 'ground' }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cams = useRef<{ radar?: Camera; ground?: Camera }>({});
  const size = useRef({ W: 300, H: 200 });
  const lastFocus = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    const resize = () => {
      const r = cv.parentElement!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      size.current = { W: Math.max(100, r.width), H: Math.max(100, r.height) };
      cv.width = Math.round(size.current.W * dpr);
      cv.height = Math.round(size.current.H * dpr);
      cv.style.width = size.current.W + 'px';
      cv.style.height = size.current.H + 'px';
    };
    const ro = new ResizeObserver(resize);
    ro.observe(cv.parentElement!);
    resize();
    let simRef: unknown = null;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const st = useUI.getState();
      const sim = st.sim;
      if (!sim) return;
      const { W, H } = size.current;
      const m = modeRef.current;
      if (simRef !== sim) { cams.current = {}; simRef = sim; }
      cams.current.radar ??= fitRadar(sim.ap, W, H);
      cams.current.ground ??= fitAirport(sim.ap, W, H);
      const cam = cams.current[m]!;
      // focus requests (from lists/boards) and follow mode
      if (st.focus && st.focus.n !== lastFocus.current) {
        lastFocus.current = st.focus.n;
        cam.cx = st.focus.x; cam.cy = st.focus.y;
        if (m === 'ground') {
          const far = Math.hypot(st.focus.x, st.focus.y) > 6000;
          if (far) { const r = cams.current.radar!; r.cx = st.focus.x; r.cy = st.focus.y; }
          else if (cam.scale < 0.25) cam.scale = 0.45;
        }
      }
      const sel = sim.s.aircraft.find((a) => a.id === st.selectedId);
      if (st.follow && sel) { cam.cx = sel.x; cam.cy = sel.y; }
      const replay = st.modal === 'replay' ? null : null;
      draw(ctx, W, H, sim, cam, { mode: m, selectedId: st.selectedId, ...st.settings, preview: st.preview?.nodes, guidance: sim.s.cfg.difficulty.atcGuidance, time: performance.now() / 1000, replay });
    };
    raf = requestAnimationFrame(loop);

    // interaction
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    const camNow = () => cams.current[modeRef.current]!;
    const down = (e: PointerEvent) => {
      const cam = camNow();
      if (!cam) return;
      drag = { x: e.clientX, y: e.clientY, cx: cam.cx, cy: cam.cy, moved: false };
      cv.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const cam = camNow();
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        cam.cx = drag.cx - dx / cam.scale;
        cam.cy = drag.cy + dy / cam.scale;
        if (useUI.getState().follow) useUI.getState().setFollow(false);
      }
    };
    const up = (e: PointerEvent) => {
      const d = drag;
      drag = null;
      if (!d || d.moved) return;
      const st = useUI.getState();
      const sim = st.sim;
      if (!sim) return;
      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const { W, H } = size.current;
      const cam = camNow();
      const sel = sim.s.aircraft.find((a) => a.id === st.selectedId);
      if (e.shiftKey && sel && isAirborne(sel)) {
        // shift-click: vector the selected aircraft toward the clicked point
        const [wx, wy] = s2w(cam, W, H, sx, sy);
        const hdg = Math.round((((Math.atan2(wx - sel.x, wy - sel.y) * 180) / Math.PI + 360) % 360) / 5) * 5 || 360;
        st.issue(sel.id, [{ t: 'HEADING', hdg: hdg % 360 }]);
        return;
      }
      const hit = pick(sim, cam, W, H, sx, sy, modeRef.current);
      st.select(hit ? hit.id : null);
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camNow();
      const sim = useUI.getState().sim;
      if (!cam || !sim) return;
      const r = cv.getBoundingClientRect();
      const { W, H } = size.current;
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [wx, wy] = s2w(cam, W, H, sx, sy);
      const f = Math.exp(-e.deltaY * 0.0015);
      const min = Math.min(W, H) / (sim.ap.airspaceRadius * 2.6), max = 3.2;
      cam.scale = Math.min(max, Math.max(min, cam.scale * f));
      cam.cx = wx - (sx - W / 2) / cam.scale;
      cam.cy = wy + (sy - H / 2) / cam.scale;
    };
    const dbl = (e: MouseEvent) => {
      const st = useUI.getState();
      const sim = st.sim;
      if (!sim) return;
      const r = cv.getBoundingClientRect();
      const { W, H } = size.current;
      const hit = pick(sim, camNow(), W, H, e.clientX - r.left, e.clientY - r.top, modeRef.current);
      if (hit) { st.select(hit.id); st.setFollow(true); }
    };
    cv.addEventListener('pointerdown', down);
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('wheel', wheel, { passive: false });
    cv.addEventListener('dblclick', dbl);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener('pointerdown', down);
      cv.removeEventListener('pointermove', move);
      cv.removeEventListener('pointerup', up);
      cv.removeEventListener('wheel', wheel);
      cv.removeEventListener('dblclick', dbl);
    };
  }, []);

  const reset = () => {
    const sim = useUI.getState().sim;
    if (!sim) return;
    const { W, H } = size.current;
    cams.current[mode] = mode === 'radar' ? fitRadar(sim.ap, W, H) : fitAirport(sim.ap, W, H);
    useUI.getState().setFollow(false);
  };
  const zoom = (f: number) => { const c = cams.current[mode]; if (c) c.scale = Math.min(3.2, Math.max(0.004, c.scale * f)); };
  const tma = () => {
    const sim = useUI.getState().sim;
    if (!sim) return;
    const { W, H } = size.current;
    cams.current[mode] = { cx: 0, cy: 0, scale: Math.min(W, H) / (16 * NM * 2) };
  };
  return (
    <div className="absolute inset-0 select-none">
      <canvas ref={ref} className="block cursor-crosshair touch-none" />
      <div className="absolute right-2 bottom-2 flex flex-col gap-1">
        <button className="btn" title="Zoom in" onClick={() => zoom(1.4)}>＋</button>
        <button className="btn" title="Zoom out" onClick={() => zoom(1 / 1.4)}>－</button>
        <button className="btn" title="Reset view" onClick={reset}>⌂</button>
        {mode === 'radar' && <button className="btn" title="Terminal area (16 NM)" onClick={tma}>16</button>}
      </div>
    </div>
  );
}
