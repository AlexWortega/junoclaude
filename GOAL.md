# Goal: land on Luna and come back

End-to-end target: build a craft in code, launch it, land on **Luna** (moon of
Droo, radius 350 km), and return to Droo. Everything driven through the bridge,
no manual flying.

## Where it stands

Working:

- `craft_build` produces craft the game loads and flies. A single-stage test
  vehicle climbed **207 m → 26.6 km in 40 s** with all parts intact.
- `scripts/fly.mjs` drives a flight through the bridge: telemetry twice a
  second, automatic staging, abort when there is thrust but no climb. This is
  the right shape — flying through individual HTTP calls is too slow to react.
- The bridge gives live telemetry, staging, throttle, and flight events.

Not working yet:

- **Multi-stage craft break up.** `JC-Luna-01` (2 stages, 7 parts) reached
  2.1 km and lost 3 parts. The builder had already flagged the joint
  `Detacher1 → RocketEngine1` as heuristically inferred — no stock craft
  contains that pair, so there is no mined recipe for it. Fix the decoupler
  joints first; nothing else matters until a stack survives separation.

## Route to the goal

Each step is verifiable on its own, and none of the later ones are worth
attempting before the earlier ones hold.

1. ~~**Survive staging.**~~ **Done.** Multi-stage craft now hold together: a
   7-part two-stage vehicle keeps all its parts through a full burn. Two fixes
   were needed.

   *Layout by attach points, not bounding boxes.* A part must be placed so its
   bottom attach point meets the top attach point of the part below. Summing
   heights leaves gaps, and a joint stretched over a gap tears apart under
   load. Engines and parachutes attach at their own origin rather than offset
   by half their height; the reference rocket's tank sits at y=-0.32 with a
   half-length of 2.5 and its engine at exactly -2.82. Our spacing now matches
   the stock rocket's tank-to-engine distance exactly.

   *The interstage encloses the engine.* Details below.

2. **Get off the pad.** The current blocker. A tall vehicle spawns already
   tilted — `pitch -19.3°` on the pad — and cannot climb; a shorter one
   spawned at `pitch 0.3°`, which is still not the `90°` a stock rocket shows.
   Something about how the craft's orientation is derived is wrong, and it
   scales with length. Compare a generated craft against a stock one in the
   designer to see which axis is off before writing more flight code.

   Note the units: a stock rocket on the pad reports `pitch 90`, ours report
   near `0`, so the nose is being treated as pointing along a different axis.

### Why the interstage matters (kept for reference)

   `Detacher1 → RocketEngine1` does not occur in any of the 61 stock craft: a
   decoupler never joins an engine directly. `Detacher1` carries a
   `CoverEngine` modifier — the interstage **encloses** the upper stage's
   engine while itself joining tank to tank (`Fuselage1 → Detacher1` 20×,
   `Detacher1 → Fuselage1` 15×). The engine hangs inside it, connected only to
   its own tank.

   So a linear stack cannot express a staged rocket directly. `craft_build`
   needs to special-case the sequence `decoupler, engine, tank`: connect the
   decoupler to the *tank* above the engine, and the engine to that same tank,
   skipping the decoupler-to-engine joint entirely.
2. **Reach orbit.** Needs a gravity turn, not a vertical climb: pitch over
   gradually with altitude and hold prograde. Success = periapsis above
   ~70 km. The autopilot already reads `orbit.apoapsis` / `periapsis`.
3. **Trans-lunar injection.** Burn at the right point to raise apoapsis to
   Luna's orbit. Needs Luna's orbital radius and a phase angle — both
   obtainable from `/planets`.
4. **Capture and landing.** Retrograde burn near periapsis, then a suicide
   burn to touch down under ~5 m/s. Landing legs required — currently the
   builder has no `landing_leg` item.
5. **Return.** Ascent from Luna, trans-Droo injection, atmospheric entry with
   a heat shield, parachute descent.

## Known gaps blocking the later steps

- No attitude control in the bridge: `targetHeading` is deliberately
  unsupported (the game models it as an orientation quaternion, not a scalar
  heading). A gravity turn needs *some* way to point the craft — either work
  out the quaternion, or drive `pitch`/`yaw` rate inputs in a closed loop from
  the autopilot.
- `craft_build` has no landing legs, no heat shield, no RCS, and no radial
  boosters wired in.
- The mass estimates in the builder are rough (the centre of mass lands within
  0.8 m of the game's own figure), which is fine for spawning but not for
  computing a burn.
