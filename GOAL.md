# Goal: land on Luna and come back

End-to-end target: build a craft in code, launch it, land on **Luna** (moon of
Droo, radius 350 km), and return to Droo. Everything driven through the bridge,
no manual flying.

## Where it stands

A three-stage, 10-part vehicle built entirely from a JSON spec flies intact,
stages cleanly and reaches **875 km** of altitude. It is **not in orbit**: the
best trajectory so far has a periapsis of **-688 km** and an eccentricity of
**0.495**, against the 0.998 every earlier flight showed. Orbit needs a
periapsis above +70 km, so roughly 750 m/s of horizontal velocity is still
missing.

Working: `craft_build` produces multi-stage craft that hold together under load;
`scripts/fly.mjs` flies them with telemetry four times a second, automatic
staging, an above-atmosphere attitude loop and a circularisation phase;
`scripts/build-craft.mjs` turns a JSON spec into a craft in one command.

## Route to the goal

1. ~~**Survive staging.**~~ **Done.** Three separate causes, all now fixed.

   *Layout by attach points, not bounding boxes.* A part must be placed so its
   bottom attach point meets the top attach point of the part below.

   *The interstage encloses the engine.* `Detacher1` carries a `CoverEngine`
   modifier and joins tank to tank; the engine connects only to its own tank.

   *Every multi-body craft needs `<BodyJoint>`.* This was the real blocker
   behind "the decoupler does not hold". The element is a **child of the
   `<Connection>`** that crosses a body boundary, and the builder emitted none,
   so the game built a default joint instead. The stack sagged on the pad — 54°
   from vertical before ignition — and tore under thrust, with the decouplers
   still reporting `activated: false`. A decoupler also belongs to the body it
   jettisons, not to one of its own, where the game recomputes it to zero mass.

2. ~~**Get off the pad.**~~ **Done.** Thrust-to-weight below 1 was one cause;
   the missing joints were the other, and they are what made the tilt look like
   a red herring. A stock craft spawns at alignment 1.000 and so does ours now.

3. **Reach orbit.** Still the blocker, but the gap is now horizontal velocity
   rather than structure or total energy. What was measured:

   - **Never override a control axis you are not steering with.**
     `mode: "hold"` with `pitch: 0` is not "no input" — it pins the axis every
     frame and switches off the game's own stability assist. Every flight that
     posted a pitch value tumbled from 0 to 170° within twenty seconds, at
     *both* polarities; flights that posted none flew dead straight to 82 km.
     Passing `null` releases the axis. This single change took the peak from
     13 km to 127 km.
   - **`attitude.pitch` is not the angle from the horizon.** It is aircraft
     pitch of the craft's *forward* axis, so a rocket standing on the pad reads
     ~0°, not 90°. Steering on it commanded a 90° error and laid the vehicle
     over. The loop now works in vectors: the zenith is `normalize(position.pci)`
     — `pci` and the attitude basis share a frame — and the nose is whichever
     body axis is vertical on the pad (`up` for our stacks, `forward` for stock).
   - **Pitch only rotates the nose within the plane perpendicular to `right`.**
     Taking the turn azimuth from the horizontal component of a near-vertical
     velocity put the target outside that plane, and the command sat at 0.000
     against a 78° error for fifty seconds. The azimuth now comes from the
     craft's own geometry.
   - **The input is a torque, and the loop is slow.** A constant 0.4 spins the
     craft through 180°. At four samples a second over HTTP any hot gain
     saturates and tumbles; `rate 0.03, damp 2, clamp 0.025` tracks smoothly.
   - **Orbit fields are `apoapsisDistance`/`periapsisDistance`**, measured from
     the planet's centre. `orbit.apoapsis` is the apsis *position vector*, so
     the old altitude cutoff never once fired. Droo's radius is **1274.2 km**,
     from `|pci| - altitudeAsl`.
   - **Staging cannot key on total fuel.** `fuel <= 0.01` is never true on a
     multi-stage craft. It now keys on thrust collapsing, needs three
     consecutive dry samples so a spooling engine is not mistaken for a spent
     one, and never stages into the parachute.

   What is left: the vehicle spends its first 45 km climbing vertically because
   the turn is held until the air is thin, and it runs dry at 2485 m/s of
   horizontal speed against the ~3230 m/s needed. Turning lower is the obvious
   win and is untested now that the axis-override bug is gone — one attempt at
   20 km used the aggressive schedule instead of horizontal targeting and is not
   a fair test. Fins would let the turn start lower still; radial boosters
   (`RadialGroup` in the spec type) remain unimplemented.

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
