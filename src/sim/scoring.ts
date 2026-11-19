/** Controller performance rating. Safety is weighted more heavily than efficiency. */
import type { SimState } from './types';
import { clamp } from './util';

export interface Score {
  overall: number;
  safety: number;
  efficiency: number;
  grade: string;
  avgArrDelay: number; // s
  avgDepDelay: number; // s
  taxiEfficiency: number; // 0..1 (ideal / actual)
  throughput: number; // movements per hour
  emergencyScore: number; // 0..100
  breakdown: { label: string; value: string; impact: number }[];
}

export function computeScore(s: SimState): Score {
  const st = s.stats;
  const hours = Math.max(s.t, 60) / 3600;
  const safety = clamp(100 - st.safetyPenalty, 0, 100);
  const avgArrDelay = st.arrDelayN ? st.arrDelaySum / st.arrDelayN : 0;
  const avgDepDelay = st.depDelayN ? st.depDelaySum / st.depDelayN : 0;
  // include delay accumulating on flights that are still waiting
  let waiting = 0, waitingN = 0;
  for (const a of s.aircraft) {
    if (a.phase === 'gone' || a.phase === 'crashed') continue;
    if (a.kind === 'departure' && a.turn?.stage === 'ready' || ['push_done', 'taxi_out', 'holding_short', 'vacated', 'taxi_in'].includes(a.phase)) { waiting += a.delay; waitingN++; }
  }
  const liveDelay = waitingN ? waiting / waitingN : 0;
  const delayPenalty = clamp((avgArrDelay / 60) * 2.2 + (avgDepDelay / 60) * 2.2 + (liveDelay / 60) * 1.5, 0, 55);
  const taxiEfficiency = st.taxiActualSum > 0 ? clamp(st.taxiIdealSum / st.taxiActualSum, 0, 1) : 1;
  const taxiPenalty = (1 - taxiEfficiency) * 20;
  const goAroundPenalty = Math.min(15, (st.goArounds - st.pilotGoArounds) * 1 + st.pilotGoArounds * 2.5);
  const divPenalty = Math.min(20, st.diversions * 6 + st.improperExits * 2);
  const movements = st.landed + st.departed;
  const throughput = movements / hours;
  const demandRate = Math.max(1, st.demand) / hours;
  const served = clamp(throughput / Math.max(1, demandRate * 0.8), 0, 1);
  const throughputPenalty = s.t > 900 ? (1 - served) * 20 : 0;
  const efficiency = clamp(100 - delayPenalty - taxiPenalty - goAroundPenalty - divPenalty - throughputPenalty, 0, 100);
  const emN = st.emergenciesHandled + st.emergenciesFailed;
  const avgResp = st.emergenciesHandled ? st.emergencyRespSum / st.emergenciesHandled : 0;
  const emergencyScore = emN ? clamp(100 - st.emergenciesFailed * 50 - Math.max(0, avgResp - 600) / 12, 0, 100) : 100;
  let overall = 0.62 * safety + 0.3 * efficiency + 0.08 * emergencyScore;
  if (st.collisions > 0) overall = Math.min(overall, 20);
  else if (st.nearMisses > 0 || st.incursions > 1) overall = Math.min(overall, 60);
  overall = Math.round(clamp(overall, 0, 100));
  const grade = overall >= 93 ? 'A+' : overall >= 85 ? 'A' : overall >= 75 ? 'B' : overall >= 65 ? 'C' : overall >= 50 ? 'D' : 'F';
  const m = (v: number) => `${(v / 60).toFixed(1)} min`;
  return {
    overall, safety: Math.round(safety), efficiency: Math.round(efficiency), grade,
    avgArrDelay, avgDepDelay, taxiEfficiency, throughput, emergencyScore: Math.round(emergencyScore),
    breakdown: [
      { label: 'Collisions / accidents', value: String(st.collisions), impact: -st.collisions * 55 },
      { label: 'Near mid-air collisions', value: String(st.nearMisses), impact: -st.nearMisses * 18 },
      { label: 'Runway incursions', value: String(st.incursions), impact: -st.incursions * 14 },
      { label: 'Separation violations', value: String(st.separationViolations), impact: -st.separationViolations * 7 },
      { label: 'Wake turbulence violations', value: String(st.wakeViolations), impact: -st.wakeViolations * 4 },
      { label: 'Taxi conflicts', value: String(st.groundConflicts), impact: -st.groundConflicts * 2 },
      { label: 'Average arrival delay', value: m(avgArrDelay), impact: -Math.round((avgArrDelay / 60) * 2.2) },
      { label: 'Average departure delay', value: m(avgDepDelay), impact: -Math.round((avgDepDelay / 60) * 2.2) },
      { label: 'Taxi efficiency', value: `${Math.round(taxiEfficiency * 100)}%`, impact: -Math.round(taxiPenalty) },
      { label: 'Go-arounds (controller / pilot)', value: `${st.goArounds - st.pilotGoArounds} / ${st.pilotGoArounds}`, impact: -Math.round(goAroundPenalty) },
      { label: 'Diversions / improper handoffs', value: `${st.diversions} / ${st.improperExits}`, impact: -Math.round(divPenalty) },
      { label: 'Throughput', value: `${throughput.toFixed(0)} mov/h`, impact: -Math.round(throughputPenalty) },
      { label: 'Emergencies handled / failed', value: `${st.emergenciesHandled} / ${st.emergenciesFailed}`, impact: Math.round((emergencyScore - 100) * 0.08) },
    ],
  };
}
