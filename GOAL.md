# Goal: land on Luna and come back

End-to-end target: build a craft in code, launch it, land on **Luna** (moon of
Droo, radius 350 km), and return to Droo. Everything driven through the bridge,
no manual flying.

## Where it stands

**No orbit has been demonstrated. The earlier claim was wrong.**

Commit `c3bd69c` announced "ORBIT: periapsis 70.0 km, apoapsis 417.1 km,
eccentricity 0.114, verified from telemetry". That claim is withdrawn. See
"The orbit claim, retracted" below.

What *is* supported by saved telemetry: on three flights the periapsis rose
above +70 km, with the arithmetic checked — Droo's radius derives as
`|pci| - altitudeAsl` = 1 274 200.0 m on the pad, and the best sample gives
`periapsisDistance` 1 344 379.7 m, so 70.18 km of altitude. But **each of those
traces contains exactly one sample above the threshold, and in every case it is
the last sample in the file**, because the autopilot declares success and stops
the instant periapsis crosses the target. Periapsis crossing a line at engine
cutoff is not an orbit; no telemetry shows any craft completing a revolution.

Every generated craft until commit `a2bf34f` also carried a gyroscope with
`maxAcceleration="0"`, which produces no torque at all. The vehicles could not
rotate, by any means — so the trajectories were thrust-shaped parabolas, and a
large part of the attitude-control work below was measuring a craft that was
never able to respond.

## The orbit claim, retracted

- **The trace cannot be produced.** Until late in the session `fly.mjs` wrote
  every flight to a fixed path, `/tmp/juno-flight-<craftId>.json`, so each run
  clobbered the one before it. The file at that path is a later flight. This is
  why per-run stamped filenames now exist, and it is the reason a headline
  result became unverifiable.
- **The conclusion was wrong regardless of the missing file.** The pattern is
  visible in the traces that *do* survive: one sample at the threshold, then the
  file ends. The same shape almost certainly produced the `c3bd69c` numbers.
- **Findings that do not depend on attitude and still stand:** the Δv budget
  measured from telemetry (11 450 m/s, from `mass = maxThrust / (twr · g)`
  segmented at staging), Droo's radius and μ, the descent throttle law, and the
  bridge round-trip measurement of 17 ms.
- **Findings that must be re-derived on a craft that can actually turn:** every
  conclusion about rotation axes, command polarity, signed tilt discontinuities
  and control bandwidth.

## Route to the goal

1. ~~**Survive staging.**~~ **Done.** The decisive fix was `<BodyJoint>`, a child
   of the `<Connection>` that crosses a body boundary. Without it the game builds
   a default joint, the stack sags on the pad — 54° from vertical before ignition
   — and tears under thrust, with the decouplers still reporting
   `activated: false`. A decoupler belongs to the body it jettisons, not to one
   of its own, where the game recomputes it to zero mass.

2. ~~**Get off the pad.**~~ **Done.** Alignment 1.000, same as stock.

3. **Reach orbit.** **Achieved once**; making it repeatable is the open work.

   The flight is flown as climb → coast → burn at apoapsis. The climb uses *no
   attitude input at all*: overriding an axis switches off the game's own
   stability assist, and left alone the vehicle flies dead straight. All turning
   happens unpowered during the coast, and the burn holds one fixed direction.

   Control is a cascade on **tilt from vertical**, the one scalar with an
   unambiguous target of 90°. An earlier law built its command from
   `dot(n × target, right)`; that sign depends on the frame's handedness *and*
   on the craft's roll at spawn — two runs measured +0.0558 and -0.0553 rad/s
   for the same command — and getting it wrong failed **silently**, the loop
   reporting cmd -0.001 while the nose slid from 78° to 6°. So `d(tilt)/d(cmd)`
   is now calibrated per flight with a single pulse during the coast, and the
   loop warns in the trace whenever the error grows under a non-zero command.

   Coast and burn need different regimes. Coasting, the only actuator is the
   pod's own torque and the loop holds continuously — releasing hands the nose
   to the assist, which holds attitude *inertially*, so the local vertical
   rotates out from under it and the tilt drifts to 126°. Burning, the engine
   gimbal is far stronger, so the gain drops and a deadband leans on the assist.
   Damping and position gains are separate: with one value the burn lost the
   craft as stage two ran light, the tilt rate going 2 → 8 → 22 → -39 deg/s in
   five seconds.

   **What blocked repeatability, found and fixed:** the loop steered on the
   *unsigned* angle from vertical, which is direction-blind. A craft pointing
   along the horizon but *backwards* reads exactly 90° and the loop reports no
   error, while the burn subtracts horizontal speed instead of adding it.
   Measured on a failed trace: 169 of 454 burning samples — 37% — had the nose
   retrograde, and every such stretch destroyed speed (t+220..237 took the
   horizontal component from 249 to 45 m/s; t+299..321 from 924 to 606 m/s) with
   the reported tilt sitting between 86° and 114° throughout. The tilt is now
   signed by whether the nose leans along the direction of travel, so a
   backwards attitude is a 180° error the loop rotates out through the vertical.

   This is the second silent failure of the same shape — the loop satisfied
   while the flight came apart — which is why the trace now carries a warning
   whenever the error grows under a non-zero command.

4. **Trans-lunar injection.** **Blocked on a missing bridge capability.**
   `/planets` returns only `name`, `sphereOfInfluence`, `rotationAngle` and
   `terrainLoaded` — no orbital radius, no position, no elements. A phase angle
   cannot be computed from that, and nothing on the client side can recover it:
   the craft's own `position.solar` locates the craft, not Luna. Exposing
   celestial body positions or orbits from the mod is the prerequisite, and is
   the one change so far that genuinely needs a Unity rebuild.

   (Luna's sphere of influence is 6 661 802 m and Droo's is 413 815 643 m, which
   is all the geometry currently available.)

5. **Capture and landing.** Landing legs now exist: `craft_build` takes a
   `radial` group on a tank, laid out the way stock craft do it — a ring on a
   circle of the parent's radius, each member joining its attach point 0 to the
   parent's surface point, sharing one `symmetryId`, with the azimuth appearing
   in the position as `(R cos θ, y, R sin θ)` and inverted in the rotation as
   `90 - θ`. Radial parts ride in their parent's body. Not yet flown.

   Still missing: a heat shield and RCS. Touchdown must be under about 5 m/s.

6. **Return.** Ascent from Luna, trans-Droo injection, entry behind a heat
   shield, parachute descent.

## Known gaps blocking the later steps

- **No celestial body positions.** `/planets` carries no orbital elements, so
  no transfer to Luna can be planned. This needs the mod.
- **Missing parts** in `craft_build`: heat shield, RCS, radial boosters.
  (Landing legs are done — see step 5.)
- **Rough mass estimates.** The centre of mass lands within 0.8 m of the game's
  own figure — fine for spawning, not good enough for planning a burn. Stage
  masses for a Δv budget are better measured in flight from
  `maxThrust / (twr · g)` than taken from the builder.
- **Flight control should move into Vizzy.** The external autopilot pays a
  network round trip per decision, and the 4 Hz that leaves is the direct cause
  of the attitude loop's fragility: every gain here is limited by it. The Vizzy
  compiler is ready and verified byte-exact against seven stock programs, so an
  in-game program is the natural home for the control loop.
