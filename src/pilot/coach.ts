/** Instructor hints: what to do now, with the numbers that matter for the present phase. */
import { FT, NM, dist } from '../sim/util';
import { ACDEF } from './aircraft';
import { nextItem } from './checklists';
import { bestMixture, indicatedAlt, isJet } from './systems';
import { distToGo } from './world';
import type { PilotState } from './types';

export interface Coach { title: string; lines: string[]; ctl?: string }

export function coach(p: PilotState): Coach {
  const { ac, atc } = p;
  const jet = isJet(p);
  const def = ACDEF[p.cfg.aircraft];
  const v = p.vspeeds;
  const next = nextItem(p);
  const item = next ? `Next checklist item: ${next.item.label} — ${next.item.expect}.` : '';
  const ctl = next?.item.ctl;
  const alt = Math.round(indicatedAlt(p));
  const dtg = distToGo(p);
  const lines: string[] = [];
  switch (p.phase) {
    case 'preflight':
    case 'before_start':
      lines.push(jet ? 'Bring the aircraft to life: battery, power source, IRS to NAV, then the APU for bleed air and electrics.' : 'Master on, beacon on, prime with the fuel pump and a rich mixture, then crank with the magneto switch.');
      if (item) lines.push(item);
      if (jet && !atc.clearedIfr) lines.push('Ask Clearance Delivery for your IFR clearance, then set the squawk code and the cleared altitude.');
      if (jet && atc.clearedIfr && !atc.clearedPush) lines.push('When the Before Start checklist is done, ask Ground for pushback.');
      return { title: jet ? 'Preflight' : 'Before start', lines, ctl };
    case 'pushback':
      lines.push('Release the parking brake so the tug can push. You can start the engines during the push.', item);
      return { title: 'Pushback', lines, ctl };
    case 'engine_start':
      lines.push(jet ? 'Start switch to GRD, watch N2 rise, fuel lever to IDLE at 25% N2, watch EGT. Engine 2 first, then engine 1.' : 'Check oil pressure rises, set about 1000 RPM, avionics on.', item);
      if (!atc.clearedTaxi && p.eng.every((e) => e.running)) lines.push('Engines stable: ask Ground for taxi.');
      return { title: 'Engine start', lines, ctl };
    case 'taxi_out':
      lines.push(`Release the parking brake, add a little power to get rolling, then back to idle. Steer with the rudder keys. Keep it under ${def.taxiKt} kt, slower in turns.`);
      lines.push(`Follow the cleared route to the holding point of runway ${p.depRwy.name} and stop at the hold line.`, item);
      return { title: 'Taxi', lines, ctl };
    case 'before_takeoff':
      lines.push(jet ? `Flaps 5, trim in the green band, speedbrake down. V1 ${v.v1}, rotate ${v.vr}, V2 ${v.v2}.` : `Run-up: 1800 RPM, check each magneto (about 100 RPM drop), then back to idle. Flaps 0–10°, trim for takeoff, mixture rich. Rotate at ${v.vr} kt.`);
      if (!atc.clearedTakeoff) lines.push('Tell Tower you are ready. Do not cross the hold line until cleared.');
      else lines.push(`Cleared for takeoff: line up on the centreline, ${jet ? 'advance thrust to about 95%' : 'full throttle'}, keep straight with rudder${jet ? '' : ' (expect to need right rudder)'}.`);
      if (item) lines.push(item);
      return { title: 'Before takeoff', lines, ctl };
    case 'takeoff':
      if (ac.onGround) lines.push(`Keep it on the centreline. At ${v.vr} kt ease back to about ${jet ? '10°, then 15° once airborne' : '8° nose up'}.`);
      else lines.push(jet ? `Positive rate – gear up. Hold V2+15 (${v.v2 + 15} kt). At 1000 ft lower the nose, accelerate and retract flaps on schedule.` : `Climb at ${def.vy} kt (best rate). Flaps up above 300 ft once past 65 kt. Trim to hold the speed hands-off.`);
      return { title: 'Takeoff', lines };
    case 'climb':
      lines.push(jet ? `Climb at 250 kt below 10,000 ft, then about 280–290 kt. Cleared altitude ${atc.alt || p.cruiseAlt} ft: set it on the MCP. Autopilot is available above 400 ft.` : `Climb at ${def.vy} kt to ${p.cruiseAlt} ft. Lean the mixture above 3000 ft (best about ${Math.round(bestMixture(alt) * 100)}%).`);
      if (atc.flags.needCheckin) lines.push(`Check in with ${atc.station}.`);
      if (item) lines.push(item);
      return { title: 'Climb', lines, ctl };
    case 'cruise': {
      const base = p.route.find((w) => w.kind === 'base' || w.kind === 'final')?.alt ?? 0;
      const tod = ((alt - base) / 1000) * 3 + (jet ? 15 : 4);
      lines.push(`Level at ${p.cruiseAlt} ft. Trim, set cruise power${jet ? '' : ' (about 2300 RPM) and lean the mixture'}. ${Math.round(dtg)} NM to go.`);
      lines.push(`Plan the descent with the 3-to-1 rule: start down about ${Math.round(tod)} NM from the runway${dtg - tod > 0 ? ` – ${Math.round(dtg - tod)} NM from now` : ' – now'}.`);
      if (item) lines.push(item);
      return { title: 'Cruise', lines, ctl };
    }
    case 'descent':
      lines.push(jet ? `Descend to ${atc.alt} ft. Idle thrust, 280 kt, then 250 kt below 10,000 ft. Set the destination altimeter, tune the ILS (${p.arrRwy.ilsFreq.toFixed(2)}).` : `Descend at about 500 ft/min toward pattern altitude. Mixture richer as you come down. ${Math.round(dtg)} NM to go.`);
      if (atc.flags.needCheckin) lines.push(`Check in with ${atc.station}.`);
      if (item) lines.push(item);
      return { title: 'Descent', lines, ctl };
    case 'approach': {
      const d = dist(ac.x, ac.y, p.arrRwy.thrX, p.arrRwy.thrY) / NM;
      if (jet) lines.push(`Slow down in steps: 210 kt, flaps 1 → 190, flaps 5 → gear down and flaps 15 at glideslope capture → flaps 30, ${v.vapp} kt. Arm APP once cleared for the approach.`);
      else lines.push(`Slow to 85 kt, flaps 10° abeam the numbers. 75 kt and flaps 20° on base. Final at ${v.vapp} kt with full flap. Use the PAPI: two red, two white.`);
      lines.push(`${d.toFixed(1)} NM from the runway. On a 3° path you should be at about ${Math.round((p.arrRwy.elev / FT + d * 318) / 10) * 10} ft.`);
      if (!atc.clearedLand && atc.flags.needCheckin) lines.push(`Call ${atc.station}.`);
      if (item) lines.push(item);
      return { title: 'Approach', lines, ctl };
    }
    case 'landing':
      lines.push(jet ? `Stable at ${v.vapp} kt, gear down, flaps 30. At 30 ft close the thrust levers and raise the nose 2–3°. After touchdown: reverse, let the autobrake work.` : `Hold ${v.vapp} kt and aim at the numbers. At about 10 ft, throttle to idle and raise the nose gently; hold it off and let the main wheels touch first.`);
      if (!atc.clearedLand) lines.push('You do not have a landing clearance yet!');
      lines.push('Not stable or not sure? Go around: full power, pitch up, flaps one stage up, tell Tower.');
      return { title: 'Landing', lines };
    case 'rollout':
      lines.push(jet ? 'Keep straight with rudder. Reverse out by 60 kt. Vacate at a taxiway, then stop and call Ground.' : 'Keep straight, brake gently, vacate the runway and stop clear of the hold line.');
      return { title: 'Roll-out', lines };
    case 'taxi_in':
      lines.push(atc.clearedTaxiIn ? `Taxi to ${jet ? 'gate' : 'parking'} ${p.arrGate}. Set the parking brake when you arrive.` : 'Clear of the runway: ask Ground for taxi to the gate.', item);
      return { title: 'Taxi in', lines, ctl };
    case 'shutdown':
      lines.push(jet ? 'Parking brake set, APU generator on, then fuel levers to CUTOFF. Finish the shutdown checklist.' : 'Parking brake, avionics off, mixture to idle cut-off, magnetos off, master off.', item);
      return { title: 'Shutdown', lines, ctl };
    case 'complete':
      return { title: 'Flight complete', lines: ['Open the debrief to see how it went.'] };
  }
}
