# Goal: land on Luna and come back

End-to-end target: build a craft in code, launch it, land on **Luna** (moon of
Droo, radius 350 km), and return to Droo. Everything driven through the bridge,
no manual flying.

## Where it stands

**Orbit was reached once, and verified from telemetry:**

| | |
|---|---|
| periapsis | **70.0 km** |
| apoapsis | **417.1 km** |
| eccentricity | 0.114 |
| orbital speed | 3507 m/s at 122 km |

It is **marginal and not yet reproducible.** The loop stops the moment periapsis
crosses the 70 km target and there were 18 fuel units left, so there is almost
no reserve. Three further attempts from the same build — one asking for a 120 km
periapsis, two repeating the successful configuration exactly — ended at
periapsis -222 km, -579 km and -974 km. The orbit is real; the *procedure* is
not yet reliable, and nothing beyond low orbit is possible until it is.

The vehicle is not the limit. Measured from telemetry with
`mass = maxThrust / (twr · g)`, segmented at each staging event:

| stage | mass | thrust | Δv |
|---|---|---|---|
| 1 | 449 → 237 kg | 12314 N | 2084 m/s |
| 2 | 216 → 37 kg | 5303 N | 5692 m/s |
| 3 | 37 → 12 kg | 1432 N | 3674 m/s |
| | | **total** | **11450 m/s** |

Orbital speed at 100 km is 3405 m/s, so ~4600 m/s is needed with losses. The
vehicle carries nearly three times that and still only just reaches orbit,
because most of the budget is spent pointing the wrong way.

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

   **What still blocks repeatability:** the burn holds 14-38° off target on bad
   runs, and at full thrust that misdirects a large fraction of the impulse.
   Tightening the deadband to 4°/1.5° did not fix it. The next things to try are
   throttling the insertion burn down so the same attitude error costs less and
   the loop has more time per unit of impulse, and burning in shorter arcs
   centred on apoapsis rather than one long burn that drove apoapsis from 130 km
   to 417 km on the successful run and 1004 km on a failed one.

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
