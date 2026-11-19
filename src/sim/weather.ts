/**
 * Weather model: wind, visibility, ceiling, precipitation, runway surface, convective cells
 * and wind shear, with METAR-style reporting. Weather feeds aircraft physics (wind drift,
 * braking), pilot decisions (crosswind/tailwind limits, minima, storm avoidance) and taxi speeds.
 */
import type { Weather, WeatherPreset } from './types';
import { NM, angDiff, approach, clamp, dist, norm360, rand, randRange, vecOf, pick } from './util';
import { World, csay, isAirborne, logEvent, radioPilot } from './world';
import { endRef, windComponents } from './airport/query';
import { predict } from './air';

export function makeWeather(w: World, preset: WeatherPreset): Weather {
  const { s, ap } = w;
  const sev = s.cfg.difficulty.weatherSeverity;
  // prevailing wind roughly favouring the first configuration
  const cfgEnd = endRef(ap, ap.configs[0]?.arr[0]);
  const base = cfgEnd ? cfgEnd.end.hdg : 270;
  const wx: Weather = {
    windDir: norm360(Math.round((base + randRange(s, -35, 35)) / 10) * 10), windKt: Math.round(randRange(s, 4, 9)),
    gustKt: 0, visSM: 10, ceilingFt: 99999, tempC: 22, dewC: 11, qnh: 3002, precip: 'none', surface: 'dry',
    windshear: false, cells: [], tgtWindDir: 0, tgtWindKt: 0, nextChange: s.t + 600,
  };
  const p = preset === 'dynamic' ? 'clear' : preset;
  if (p === 'rain') {
    Object.assign(wx, { windKt: Math.round(randRange(s, 9, 15 + sev * 8)), visSM: Math.round(randRange(s, 3, 6)), ceilingFt: 1800, precip: sev > 0.6 ? 'heavy_rain' : 'rain', surface: 'wet', tempC: 16, dewC: 15, qnh: 2978 });
    wx.gustKt = wx.windKt + Math.round(sev * 10);
  } else if (p === 'thunderstorm') {
    Object.assign(wx, { windKt: Math.round(randRange(s, 12, 18 + sev * 8)), visSM: 4, ceilingFt: 2800, precip: 'thunderstorm', surface: 'wet', tempC: 27, dewC: 23, qnh: 2969 });
    wx.gustKt = wx.windKt + 10 + Math.round(sev * 8);
    const n = 2 + Math.round(sev * 3);
    for (let i = 0; i < n; i++) addCell(w, wx, i === 0);
  } else if (p === 'fog') {
    Object.assign(wx, { windKt: Math.round(randRange(s, 0, 4)), visSM: sev > 0.6 ? 0.25 : 0.5, ceilingFt: 200, precip: 'fog', surface: 'wet', tempC: 9, dewC: 9, qnh: 3021 });
  } else if (p === 'winter') {
    Object.assign(wx, { windKt: Math.round(randRange(s, 10, 16 + sev * 8)), visSM: 1.5, ceilingFt: 1200, precip: 'snow', surface: sev > 0.7 ? 'ice' : 'snow', tempC: -3, dewC: -5, qnh: 2985 });
    wx.gustKt = wx.windKt + 6;
  }
  if (preset === 'custom' && s.cfg.customWeather) Object.assign(wx, s.cfg.customWeather);
  wx.tgtWindDir = wx.windDir;
  wx.tgtWindKt = wx.windKt;
  return wx;
}

function addCell(w: World, wx: Weather, near: boolean) {
  const { s, ap } = w;
  // cells form upwind and drift with the wind
  const brg = norm360(wx.windDir + randRange(s, -50, 50));
  const [ux, uy] = vecOf(brg);
  const r = (near ? randRange(s, 9, 14) : randRange(s, 14, 26)) * NM;
  const [mx, my] = vecOf(norm360(wx.windDir + 180 + randRange(s, -15, 15)));
  const speed = randRange(s, 7, 13); // m/s
  wx.cells.push({ x: ux * Math.min(r, ap.airspaceRadius * 0.9), y: uy * Math.min(r, ap.airspaceRadius * 0.9), r: randRange(s, 2.2, 4.5) * NM, intensity: randRange(s, 0.5, 1), vx: mx * speed, vy: my * speed });
}

const sameFlow = (w: World, wx: Weather) => {
  for (const n of w.s.activeConfig.arr) {
    const e = endRef(w.ap, n);
    if (e && windComponents(e.end.hdg, wx.windDir, wx.windKt).head < -7) return n;
  }
  return undefined;
};

/** advance the weather by one simulated second */
export function updateWeather(w: World) {
  const { s, ap } = w;
  const wx = s.weather;
  const preset = s.cfg.weatherPreset;
  const sev = s.cfg.difficulty.weatherSeverity;
  wx.windDir = norm360(wx.windDir + clamp(angDiff(wx.windDir, wx.tgtWindDir), -0.12, 0.12));
  wx.windKt = approach(wx.windKt, wx.tgtWindKt, 0.03);
  for (const c of wx.cells) { c.x += c.vx; c.y += c.vy; }
  wx.cells = wx.cells.filter((c) => dist(c.x, c.y, 0, 0) < ap.airspaceRadius * 1.35);
  if (wx.precip === 'thunderstorm' && wx.cells.length < 2 && s.step % 600 === 0) addCell(w, wx, false);
  const nearCell = wx.cells.some((c) => dist(c.x, c.y, 0, 0) < c.r + 6 * NM);
  const shear = nearCell || wx.gustKt - wx.windKt >= 15;
  if (shear && !wx.windshear) logEvent(w, 'weather', 'warning', 'Wind shear alert in effect for all runways');
  wx.windshear = shear;

  if (s.t >= wx.nextChange) {
    wx.nextChange = s.t + randRange(s, 420, 900);
    if (preset === 'dynamic') {
      const roll = rand(s);
      const prev = wx.precip;
      if (roll < 0.25 + sev * 0.25) {
        const kind = pick(s, sev > 0.5 ? (['rain', 'thunderstorm', 'fog', 'rain', 'thunderstorm'] as const) : (['rain', 'rain', 'fog'] as const));
        const nw = makeWeather(w, kind);
        Object.assign(wx, { visSM: nw.visSM, ceilingFt: nw.ceilingFt, precip: nw.precip, surface: nw.surface, gustKt: nw.gustKt, tempC: nw.tempC, dewC: nw.dewC, qnh: nw.qnh });
        wx.tgtWindKt = nw.windKt;
        if (kind === 'thunderstorm') wx.cells.push(...nw.cells);
      } else if (roll < 0.6) {
        Object.assign(wx, { visSM: 10, ceilingFt: 99999, precip: 'none', gustKt: 0 });
        if (wx.surface !== 'dry') wx.surface = 'wet';
        wx.tgtWindKt = randRange(s, 4, 12);
      } else if (wx.precip === 'none') wx.surface = 'dry';
      // wind shifts – occasionally large enough to demand a runway change
      wx.tgtWindDir = norm360(Math.round((wx.windDir + (rand(s) < 0.2 + sev * 0.25 ? randRange(s, 120, 240) : randRange(s, -40, 40))) / 10) * 10);
      if (wx.precip !== prev) {
        bumpAtis(w);
        logEvent(w, 'weather', 'advisory', `Weather update: ${metar(w)}`);
      }
    } else {
      wx.tgtWindDir = norm360(wx.windDir + randRange(s, -15, 15) * (0.5 + sev));
      wx.tgtWindKt = clamp(wx.tgtWindKt + randRange(s, -3, 3), 0, 40);
    }
  }
  // tailwind advisory for the active configuration
  if (s.step % 300 === 0) {
    const bad = sameFlow(w, wx);
    if (bad && !wxFlag(w, 'tail')) {
      setWxFlag(w, 'tail', 1);
      logEvent(w, 'weather', 'warning', `Wind ${fmtWind(wx)} gives a tailwind on runway ${bad} – consider changing the runway configuration`);
    } else if (!bad) setWxFlag(w, 'tail', 0);
  }

  // storm cell interaction with airborne traffic
  if (wx.cells.length) {
    for (const ac of s.aircraft) {
      if (!isAirborne(ac)) continue;
      let inside = false, ahead = false;
      const [px, py] = predict(ac, 75);
      for (const c of wx.cells) {
        if (dist(ac.x, ac.y, c.x, c.y) < c.r * 0.85) inside = true;
        else if (dist(px, py, c.x, c.y) < c.r * 0.9) ahead = true;
      }
      if (inside && !ac.flags.inCell) {
        ac.flags.inCell = 1;
        s.stats.safetyPenalty += 3;
        logEvent(w, 'weather', 'warning', `${ac.callsign} penetrated a thunderstorm cell – severe turbulence`, [ac]);
        radioPilot(w, ac, `${csay(ac)}, encountering severe turbulence, we need out of this weather.`);
        if (rand(s) < 0.2 + sev * 0.2 && !ac.emergency) ac.flags.turbInjury = 1;
      } else if (!inside) ac.flags.inCell = 0;
      if (ahead && !inside && !ac.flags.wxWarn) {
        ac.flags.wxWarn = 1;
        radioPilot(w, ac, `${csay(ac)}, weather ahead on this heading, request deviation.`);
        logEvent(w, 'weather', 'advisory', `${ac.callsign} requests deviation around weather`, [ac]);
      } else if (!ahead && !inside) ac.flags.wxWarn = 0;
    }
  }
}

const flags = new WeakMap<object, Record<string, number>>();
const wxFlag = (w: World, k: string) => flags.get(w.s)?.[k] ?? 0;
const setWxFlag = (w: World, k: string, v: number) => { if (!flags.has(w.s)) flags.set(w.s, {}); flags.get(w.s)![k] = v; };

export function bumpAtis(w: World) {
  const c = w.s.atis.charCodeAt(0);
  w.s.atis = String.fromCharCode(c >= 90 ? 65 : c + 1);
}

export const fmtWind = (wx: Weather) =>
  wx.windKt < 1.5 ? 'calm' : `${String(Math.round(wx.windDir / 10) * 10 || 360).padStart(3, '0')}/${Math.round(wx.windKt)}${wx.gustKt > wx.windKt + 4 ? `G${Math.round(wx.gustKt)}` : ''}`;

/** spoken wind for clearances: "two seven zero at eight" */
export function sayWind(wx: Weather): string {
  if (wx.windKt < 1.5) return 'calm';
  const d = String(Math.round(wx.windDir / 10) * 10 || 360).padStart(3, '0');
  const say = (v: string | number) => String(v).split('').map((c) => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'][+c]).join(' ');
  return `${say(d)} at ${say(Math.round(wx.windKt))}${wx.gustKt > wx.windKt + 4 ? ` gusting ${say(Math.round(wx.gustKt))}` : ''}`;
}

export function metar(w: World): string {
  const { s, ap } = w;
  const wx = s.weather;
  const clock = s.cfg.startClock + s.t;
  const hh = String(Math.floor((clock / 3600) % 24)).padStart(2, '0');
  const mm = String(Math.floor((clock / 60) % 60)).padStart(2, '0');
  const wind = wx.windKt < 1.5 ? '00000KT' : `${String(Math.round(wx.windDir / 10) * 10 || 360).padStart(3, '0')}${String(Math.round(wx.windKt)).padStart(2, '0')}${wx.gustKt > wx.windKt + 4 ? `G${Math.round(wx.gustKt)}` : ''}KT`;
  const vis = wx.visSM >= 10 ? '10SM' : wx.visSM < 1 ? `${wx.visSM <= 0.25 ? '1/4' : wx.visSM <= 0.5 ? '1/2' : '3/4'}SM` : `${Math.round(wx.visSM)}SM`;
  const pw = { none: '', rain: '-RA', heavy_rain: '+RA', snow: 'SN', fog: 'FG', thunderstorm: 'TSRA' }[wx.precip];
  const sky = wx.ceilingFt > 50000 ? 'FEW250' : wx.ceilingFt <= 200 ? `VV00${Math.max(1, Math.round(wx.ceilingFt / 100))}` : `${wx.ceilingFt < 3000 ? 'OVC' : 'BKN'}${String(Math.round(wx.ceilingFt / 100)).padStart(3, '0')}${wx.precip === 'thunderstorm' ? 'CB' : ''}`;
  const t = (v: number) => (v < 0 ? 'M' : '') + String(Math.abs(Math.round(v))).padStart(2, '0');
  return [ap.icao, `18${hh}${mm}L`, wind, vis, pw, sky, `${t(wx.tempC)}/${t(wx.dewC)}`, `A${wx.qnh}`, wx.windshear ? 'WS ALL RWY' : ''].filter(Boolean).join(' ');
}

/** reasons a crew would refuse to use a runway end in the current weather (undefined = acceptable) */
export function runwayWeatherIssue(w: World, endName: string, typeXwind: number, forLanding: boolean): string | undefined {
  const e = endRef(w.ap, endName);
  if (!e) return undefined;
  const wx = w.s.weather;
  const kt = Math.max(wx.windKt, wx.gustKt * 0.85);
  const { head, cross } = windComponents(e.end.hdg, wx.windDir, kt);
  const xLimit = typeXwind * (wx.surface === 'dry' ? 1 : wx.surface === 'wet' ? 0.85 : 0.6);
  if (cross > xLimit) return `crosswind ${Math.round(cross)} knots exceeds our limit`;
  if (head < -10) return `tailwind ${Math.round(-head)} knots`;
  if (forLanding && !e.end.ils && (wx.visSM < 2 || wx.ceilingFt < 800)) return 'no instrument approach and weather below visual minimums';
  return undefined;
}
