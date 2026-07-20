# Goal: land on Luna and come back

End-to-end target: build a craft in code, launch it, land on **Luna** (moon of
Droo, radius 350 km), and return to Droo. Everything driven through the bridge,
no manual flying.

## Where it stands

A three-stage, 10-part vehicle built from a JSON spec flies intact and stages
cleanly. It is **not in orbit**. Best trajectory measured: periapsis
**-688 km**, eccentricity **0.495**, against 0.998 on every flight before the
joints were fixed. Orbit needs periapsis above +70 km.

**The vehicle is not short of energy.** Measured from telemetry, using
`mass = maxThrust / (twr · g)` segmented at each staging event:

| stage | mass | thrust | Δv |
|---|---|---|---|
| 1 | 449 → 237 kg | 12314 N | 2084 m/s |
| 2 | 216 → 37 kg | 5303 N | 5692 m/s |
| 3 | 37 → 12 kg | 1432 N | 3674 m/s |
| | | **total** | **11450 m/s** |

Orbital speed at 100 km is 3405 m/s, so roughly 4600 m/s is needed with losses.
The vehicle carries nearly three times that. An earlier note here claiming it
was ~745 m/s short was wrong: nothing is short but the *direction* the Δv is
spent in. Stage 2 alone could reach orbit if it were pointed correctly.

## Route to the goal

1. ~~**Survive staging.**~~ **Done.** The decisive fix was `<BodyJoint>`, a
   child of the `<Connection>` that crosses a body boundary. Without it the game
   builds a default joint, the stack sags on the pad — 54° from vertical before
   ignition — and tears under thrust with the decouplers still reporting
   `activated: false`. A decoupler also belongs to the body it jettisons, not to
   one of its own, where the game recomputes it to zero mass.

2. ~~**Get off the pad.**~~ **Done.** Alignment 1.000 on the pad, same as stock.

3. **Reach orbit.** Blocked on **attitude control**, not on propulsion or
   structure. What is established:

   - **Never override a control axis you are not steering with.**
     `mode: "hold"` with `pitch: 0` pins the axis every frame and switches off
     the game's own stability assist. Passing `null` releases it. This one
     change took the peak from 13 km to 127 km.
   - **The assist holds attitude, and that is useful in one phase and harmful
     in the other.** With the axis released the vehicle flies dead straight for
     90 s; while a weak command fought the assist the tilt stayed pinned at 7°
     against a 60° demand. Slewing needs the assist out of the way, holding a
     burn attitude needs it engaged — hence hysteresis, engage at 12° of error
     and release at 3°.
   - **The steering law's sign is unreliable and fails silently.** The command
     is built from `dot(n × target, right)`, whose sign comes out wrong in some
     geometries. When it does, the loop reports `cmd -0.001` — believing it is
     holding the commanded rate — while the nose slides the other way. One burn
     watched the tilt go 78° → 6° and the horizontal speed collapse from
     1119 back to 640 m/s. **This is the immediate blocker.** Learning the sign
     from the measured response was tried and chatters on an oscillating craft
     (twelve flips in forty seconds); it is behind `JUNO_ADAPT_SIGN=1` and needs
     a far longer evidence window. Deriving the sign correctly from the frame,
     once, is the better fix.
   - **The input is a torque, and the loop is slow.** A constant 0.4 spins the
     craft through 180°. At four samples a second any hot gain saturates and
     tumbles; the craft is worst once light — the tilt swung 87°→170°→35° at
     37 kg. `rate 0.03–0.06, damp 2, clamp 0.025–0.06` is the workable range.
   - **Chasing a target more than 90° away breaks the law**, because
     `|n × target| = sin(error)` shrinks again past a right angle and the
     projection can change sign. Commands are capped to 80° of slew.
   - **Pitch only moves the nose in the plane perpendicular to `right`,** so the
     turn azimuth is derived from the craft's own geometry. Taking it from a
     near-vertical velocity's horizontal component left the command at 0.000
     against a 78° error for fifty seconds.
   - Orbit fields are `apoapsisDistance`/`periapsisDistance` from the planet's
     centre; Droo's radius is 1274.2 km. Staging keys on thrust collapsing over
     three consecutive samples, never on total fuel, never into the parachute,
     and never while coasting with the throttle shut.

   The flight is now structured as climb → coast → burn at apoapsis: the climb
   flies with no attitude input at all (stable), the slew to horizontal happens
   unpowered during the coast where there is no hurry, and the burn holds one
   fixed direction. The structure works — cutoff, coast and burn all trigger
   correctly, and periapsis rises while the tilt is near 90° — but the burn
   loses the attitude partway through to the sign bug above.

   Turning lower was tried at 8, 15, 20 and 30 km and did not help: at 45 km the
   best eccentricity was 0.495, at 15 km 0.655, at 8 km 0.991. Rebalancing mass
   toward the upper stages (JC-Orbit-04) also did not help, which is consistent
   with Δv not being the constraint.

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
