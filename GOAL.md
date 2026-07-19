# Goal: land on Luna and come back

End-to-end target: build a craft in code, launch it, land on **Luna** (moon of
Droo, radius 350 km), and return to Droo. Everything driven through the bridge,
no manual flying.

## Where it stands

A two-stage, 7-part vehicle built entirely from a JSON spec flies to **15.1 km**
with both stages firing and every part intact. A lighter single-stage one
reaches **26.6 km**. Nothing has reached orbit yet.

Working: `craft_build` produces craft the game loads and flies; `scripts/fly.mjs`
drives a flight through the bridge with telemetry twice a second, automatic
staging and an abort when there is thrust but no climb; the bridge supplies live
telemetry, staging, throttle and flight events.

## Route to the goal

1. ~~**Survive staging.**~~ **Done.** Two fixes were needed.

   *Layout by attach points, not bounding boxes.* A part must be placed so its
   bottom attach point meets the top attach point of the part below. Summing
   heights leaves gaps, and a joint stretched over a gap tears apart under load.
   Engines and parachutes attach at their own origin rather than offset by half
   their height: the stock reference rocket puts its tank at y=-0.32 with a
   half-length of 2.5 and its engine at exactly -2.82. Generated spacing now
   matches the stock rocket's tank-to-engine distance exactly.

   *The interstage encloses the engine.* `Detacher1 → RocketEngine1` occurs in
   none of the 61 stock craft — a decoupler never joins an engine directly.
   `Detacher1` carries a `CoverEngine` modifier: it **encloses** the upper
   stage's engine while itself joining tank to tank (`Fuselage1 → Detacher1`
   20×, `Detacher1 → Fuselage1` 15×), and the engine connects only to its own
   tank. `craft_build` special-cases the sequence `decoupler, engine, tank`.

2. ~~**Get off the pad.**~~ **Done**, and the first diagnosis was wrong, which
   is worth remembering.

   "Craft spawn tilted" was a red herring: the stock `__new__` rocket also
   reports a small pitch on the pad, and a craft reporting `pitch -13.6°` flew
   to 26 km. The `90°` a large stock rocket shows comes from something else.

   The real cause was **thrust-to-weight below 1**. Measured, all with a single
   default `Bravo` engine (thrust 3631):

   | tank | fuel | TWR | result |
   |---|---|---|---|
   | 5 m × 2 m, single stage | 88 | 3.34 | 26.6 km |
   | 9 m × 2 m + upper stage | 204 | ~1.7 | **15.1 km, both stages fired** |
   | 18 m × 2.4 m + upper stage | 571 | 0.62 | never left the pad |

   A `size: 2` engine raises thrust but burns 679 units in 6 s (~113/s against
   ~2/s at `size: 1`), so it is not a free fix. Thrust and flow both scale with
   `nozzleThroatSize`; stock craft use 0.5–1.0.

3. **Reach orbit.** The current blocker. Peak vertical speed is 508 m/s against
   roughly 2500 m/s needed for orbit around Droo. That calls for more stages
   rather than a bigger single engine, while keeping lift-off TWR above about
   1.3, and for a gravity turn — a vertical climb spends everything fighting
   gravity. Success = periapsis above ~70 km; the autopilot already reads
   `orbit.apoapsis` and `orbit.periapsis`.

   Radial boosters are the natural answer and are not implemented: `RadialGroup`
   exists in the spec type but the builder ignores it.

4. **Trans-lunar injection.** Burn to raise apoapsis to Luna's orbit. Needs
   Luna's orbital radius and a phase angle, both available from `/planets`.

5. **Capture and landing.** Retrograde burn near periapsis, then a suicide burn
   to touch down under ~5 m/s. Needs landing legs, which `craft_build` has no
   item for.

6. **Return.** Ascent from Luna, trans-Droo injection, atmospheric entry behind
   a heat shield, parachute descent.

## Known gaps blocking the later steps

- **No attitude control.** A gravity turn needs some way to point the craft.
  The bridge deliberately rejects `targetHeading` (the game models it as an
  orientation quaternion, not a scalar heading), so either work out the
  quaternion or drive `pitch`/`yaw` inputs in a closed loop from the autopilot.
- **Missing parts** in `craft_build`: landing legs, heat shield, RCS, radial
  boosters.
- **Rough mass estimates.** The centre of mass lands within 0.8 m of the game's
  own figure — fine for spawning, not good enough for planning a burn.
- **Flight control should move into Vizzy.** The external autopilot pays a
  network round trip per decision. The Vizzy compiler is ready and verified
  byte-exact against seven stock programs, so an in-game program is the natural
  home for the ascent loop once attitude control works.
