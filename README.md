# TowerOps — ATC & Airport Operations Simulator

A browser-based air traffic control simulator in which you hold **every** position at an airport —
Clearance Delivery, Ground, Tower, Approach and Departure. Aircraft are persistent simulation entities
that request clearances and wait for them: nothing pushes back, taxis, crosses a runway, takes off or
lands without your authorisation. Pilots only act on their own for safety (go-around, rejected takeoff,
refusing a clearance with "unable"), and always say so on the radio.

> This is a game. It is not certified for, connected to, or suitable for real-world air traffic control.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Then open the printed URL (default http://localhost:5173). Other scripts: `npm test` (engine test
suite), `npm run build` (type-check + production build), `npm run typecheck`.

## Playing

1. Pick a mode (Sandbox, Career, Challenges, Realism), an airport, a difficulty preset or custom
   settings, traffic density, weather and emergency frequency, then **Open the position**.
2. Aircraft call you. Requests appear in the **Requests** queue (left). Click a request to select the
   aircraft; the right panel shows its details and the instructions valid for its current phase.
3. Issue instructions by **clicking**, by **typing** in the console (`DAL1426 TAXI 27R VIA B M`,
   `UAL892 DESCEND 4000, HEADING 240`, `UAL892 CLEARED ILS 26L` …; press `?` for the full reference),
   or by **voice** where the browser supports speech recognition. All three use one command pipeline.
4. Switch between **Radar**, **Ground** and **Tower 3D** views at any time — they all draw the same
   simulation state, and the selected aircraft stays selected.

Keys: `Space` pause · `1–4` speed (1×/2×/4×/8×) · `R`/`G`/`T` views · `/` command line ·
`Esc` deselect · Shift+click the map to vector the selected aircraft toward a point · double-click an
aircraft to follow it.

**Approach tip.** Every runway end has a final fix (`F26R`, 12 NM out) and two base fixes
(`B26RN`/`B26RS`, 16 NM out, 5.5 NM abeam). Send an arrival direct to a base fix at 4–5,000 ft, turn
it about 40° toward the final, descend to 3,000 ft and clear the ILS; then give the landing clearance.

## What is simulated

- **Lifecycle** — arrivals: airspace entry → vectors/holding → ILS → landing roll → runway exit →
  gate assignment → taxi (with runway-crossing clearances) → parking → turnaround
  (deboarding, unloading, servicing, boarding, de-icing in snow) → the same airframe becomes the
  outbound flight: departure clearance → pushback → taxi → hold short → line up → takeoff → climb →
  handoff at the airspace boundary.
- **Surface movement** on a routable taxiway graph: named-taxiway routing (`VIA`), turn limits,
  acceleration/braking, hold-short enforcement, following and give-way behaviour, pushback paths,
  taxiway/runway closures, head-on deadlocks (resolved by re-routing or a tug).
- **Flight model** — type-specific speeds, climb/descent, turn rates, wind drift, localiser capture,
  3° glidepath, stabilised-approach and minima checks, takeoff/landing distances, braking by surface.
- **Runways** as limited resources: occupancy, crossings, wake-turbulence intervals, closures,
  configuration changes, intersecting-runway conflicts.
- **Safety monitoring** — radar/wake/parallel/departure separation rules, predicted conflicts,
  optional TCAS-style resolution, runway incursions, ground collisions, near mid-air collisions.
  Aircraft do not vanish after an accident.
- **Weather** — wind, gusts, visibility, ceiling, rain/snow/fog/thunderstorm cells, wind shear,
  runway surface, METAR-style reports, dynamic changes that can force a runway change.
- **Emergencies** — engine failure, dual engine failure, hydraulics, gear, electrical, flight
  controls, brakes, tyres, rejected takeoff, medical, minimum fuel/fuel emergency, turbulence
  injuries, fire/evacuation, disabled aircraft on a taxiway. Disabled aircraft block the runway
  until recovered.
- **Scoring** — a 0–100 controller rating weighted 62% safety, 30% efficiency, 8% emergency handling.
- **Save / load / replay** — versioned local saves, session history, and a replay of recorded
  aircraft movements (last 30 minutes) for reviewing incidents.
- **Optional AI delegation** per position (off by default). AI controllers issue instructions through
  the same pipeline and rules as the player.

## Airports

| Airport | Notes |
|---|---|
| KATL Atlanta (flagship) | 5 parallel runways, concourses T/A–F, 189 gates, Delta-heavy traffic mix |
| KJFK New York JFK | 4 runways, international widebody mix |
| KLAX Los Angeles | 4 parallels in two complexes |
| EGLL London Heathrow | 2 parallels, long-haul heavy mix |
| KLGA LaGuardia | 2 intersecting runways |
| KCVR Cedar Valley Regional | fictional single-runway regional airport with GA |
| Custom | fictional airports from the builder: 1–8 runways, parallel/intersecting/mixed, terminals, gates |

## Data integrity — what is real and what is not

1. **Real**: airline names, ICAO codes and telephony callsigns; aircraft type names; runway
   designators, runway counts and the general arrangement of each real airport.
2. **Approximated from general knowledge (not surveyed, not downloaded)**: runway threshold
   positions and lengths; terminal/concourse placement. Map services (OpenStreetMap, OurAirports) were
   not reachable from the build environment, so no licensed geodata is bundled. LAX is drawn on a
   single 065° bearing; JFK's 4L/13R runway intersection is not modelled.
3. **Simplified / invented for playability**: taxiway networks and their letters, gate positions and
   counts, navigation fix positions (some names are real, positions are schematic), holding points.
4. **Simulated**: every flight, schedule, registration and weather report. Nothing is live data, and
   there is no live flight-data or real-weather integration in this build.
5. **Game mechanics**: turnarounds are compressed to minutes; headings are treated as true; aircraft
   performance figures are documented approximations (`src/sim/data/aircraft.ts`); the airspace is a
   30 NM cylinder to 14,000 ft; SIDs/STARs are reduced to entry/exit fixes.

## Known limitations

- AI controllers are basic assistants. They cope with light-to-moderate traffic; in heavy traffic
  they cause delays, holding, diversions and occasional separation losses.
- Voice input depends on the browser's Web Speech API (Chromium-based browsers); pilot voices use
  `speechSynthesis`. The game is fully playable without either.
- The 3D tower view is a visualisation of the same state; it is simpler than the 2D views (no storm
  cells or closed-runway markings) and has not been performance-profiled on real GPUs.
- Departures cannot return to a gate once pushed back (except emergency aircraft that land again).
- The custom airport generator is solid for parallel layouts (1–8 runways). Dense crossing layouts
  (roughly 3+ intersecting runways or many large terminals) can produce runway ends without a
  full-length holding point, or stands too close to a crossing runway; the builder preview lists
  these warnings. Such airports still route and play, with intersection departures.
- Replay covers recorded positions only (2-second samples, last 30 minutes), not full state rewind.

## Architecture

```
src/sim/            simulation engine – no DOM, no rendering, fully deterministic for a given seed
  types.ts          entity + state types (SimState is plain JSON → save/load/replay)
  sim.ts            Sim class: fixed 0.1 s step loop, command entry points, serialisation
  airport/          build.ts (layout → routable graph), query.ts, custom.ts (generator), defs/*
  pathfind.ts       directed-edge Dijkstra with turn limits, VIA constraints, deconfliction costs
  ground.ts         taxi, pushback, hold-short, give-way, line-up, takeoff/landing rolls, turnaround
  air.ts            airborne guidance and physics, ILS, go-around, departure
  commands.ts       validate → pilot check → readback → apply;  parse.ts typed commands;  voice.ts
  traffic.ts, weather.ts, emergencies.ts, separation.ts, scoring.ts, delegation.ts, scenarios.ts
src/render/map.ts   canvas renderer for radar and ground views
src/ui/             React panels, start screen, 3D tower view (three.js)
src/store.ts        Zustand store + real-time loop (render loop independent of the sim step)
tests/              vitest suite incl. the end-to-end Atlanta scenario
```

Adding an airport = adding one `AirportDef` (runway thresholds, named taxiway centrelines, gates) in
`src/sim/airport/defs/` and registering it in `src/sim/airport/index.ts`. Simulation logic never
references specific runway or taxiway identifiers.
