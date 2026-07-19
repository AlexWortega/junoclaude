---
name: juno
description: >
  Build, program and test craft in Juno: New Origins (SimpleRockets 2).
  Use when the user mentions Juno New Origins, SimpleRockets 2, SR2, asks to
  build a rocket, plane, rover or satellite for that game, to write a Vizzy
  flight program, or to work out craft XML, staging, launching a craft or
  testing a design. Also for requests like "make me a rocket that reaches
  orbit", "write a flight program", "why did my craft explode", or when
  editing files under com.jundroo.SimpleRockets2.
---

# Juno: New Origins

The tools work directly on the game's files. All of its formats are plain XML
with no signatures or checksums, so craft and flight programs can be generated
programmatically.

## Workflow

1. `game_state` — confirm the game is **not running**: you cannot write while it is.
2. `craft_read` / `part_lookup` — understand what you are working with.
3. `vizzy_write` — the flight program (start with `dry_run: true`).
4. `game_launch` → check in game → `log_read` — feedback.
5. `junoclaude_restore` — roll back if something went wrong.

Every write takes a snapshot first; `junoclaude_restore` with no arguments lists them.

## Four rules

They prevent almost every failure.

1. **Do not write craft XML by hand.** The connection structure is not obvious
   (see below); use the tools.
2. **Do not request `craft_read` in `xml` mode without `part_ids`.** Craft reach
   2 MB — the context will run out on the first call. Start with the summary.
3. **Do not edit live what the game writes itself** — `GameStates/`,
   `Settings.xml`, `Career/`. Craft and flight programs can be written while the
   game is running: the craft list is verified not to be cached, and a new file
   shows up in the designer immediately.
4. **Do not invent Vizzy property names.** The compiler checks them against the
   catalog and suggests near matches, but it is better to check beforehand.

## Coordinate system and geometry

- **`+Y` is up along the stack.** A part's `position` is its **center**, in
  meters, in craft-local coordinates.
- `rotation` is Euler angles in **degrees**.
- Bounds and mass (`price`, `initialBounds*`, `localCenterOfMass`, `<Drag>`) are
  **derived**: the game recomputes them on load. Approximate values are enough.
- Most fuselage parts are **procedural**: `Fuselage1` is a fuel tank, an adapter
  and a nose cone all at once, the difference being only the `<Fuselage>`
  modifier (`topScale`, `bottomScale`, with `offset.y` setting the length).
  Likewise `RocketEngine1` covers every rocket engine via `nozzleTypeId`.

## Connections — the most common source of mistakes

`attachPointsA` and `attachPointsB` are **comma-separated lists of indices**, not
single numbers. A stack connection links **two pairs**: `load` (the structural
joint and fuel flow) and `shell` (the skin, which affects drag). Specifying only
`load` gives you a segmented fuselage with wrong aerodynamics.

In `<Connection partA partB>` for a stack connection, **`partA` is the lower part
and `partB` the upper one**. The game also writes the reverse order if that is
how the craft was assembled in the designer, so both occur when reading.

Verified recipes (mined from craft the game saved itself):

| lower | upper | attachPointsA | attachPointsB |
|---|---|---|---|
| `Fuselage1` | `Fuselage1` | `2,4` | `1,5` |
| `RocketEngine1` | `Fuselage1` | `0` | `1` |
| `Fuselage1` | `Detacher1` | `2,4` | `1,0` |
| `Gyroscope1` | `Fuselage1` | `2,4` | `1,5` |

The full list comes from `part_lookup` with an `id`. Radial attachment (a part on
the side of another) works differently: the `rotate` service point of the
attached part goes to the `surface` point of the receiving one.

## Stages

A stage is set by the **`activationStage` attribute on each `<Part>`**. There is
no `<Stages>` element. Stage `0` fires first; a missing attribute means zero. By
convention a decoupler belongs to the stage above the block it drops.

Activation groups (1..10) are stored in a part's `activationGroup`, and their
names in the command pod's `activationGroupNames`.

## Vizzy

A flight program is written in a compact DSL; the compiler assigns `id` and
`style` itself:

```json
{
  "name": "Liftoff",
  "on": {
    "FlightStart": [
      ["set-input", "throttle", 1],
      ["stage"],
      ["display", "Ignition", 7],
      ["while", ["<", ["prop", "Misc.Stage"], ["prop", "Misc.NumStages"]], [
        ["wait-until", ["=", ["prop", "Fuel.FuelInStage"], 0]],
        ["stage"]
      ]]
    ]
  }
}
```

- Expressions are arrays: `["<", ["prop", "Altitude.ASL"], 1000]`.
- `"$name"` is a variable reference, `["prop", "…"]` a craft property.
- A block's body (`while`, `if`, `for`, `repeat`) is the **last** argument.
- A program can be saved as a separate file or embedded in a craft
  (`craft` + `part_id`) — embedding makes the craft self-contained.

Use `dry_run: true` first to see the XML and confirm there are no errors.

## References

Read as needed:

- `references/craft-xml.md` — the full structure of a craft file, which fields
  are derived, how `<Bodies>` and `<BodyJoint>` work. *Read when you need to
  change something the tools do not cover.*
- `references/vizzy-blocks.md` — every instruction, expression and craft
  property. *Read when the compiler rejected an operation.*
- `references/troubleshooting.md` — a "symptom → cause → what to look for in the
  log" table. *Read when a craft will not load, falls apart or will not fly.*
- `references/scenarios.md` — the `FlightState` and `GameState` formats, the
  differences between versions 2 and 3, orbital elements. *Read before editing
  scenarios.*

## Bridge mod

Live telemetry, launching a flight and controlling it from chat require the
`JunoBridge` mod (the `mod/` directory). Until it is built, `game_state` will
report that no mods are installed, and feedback is limited to `log_read` and
parsing the saved state after quitting the game. Building it requires Unity
2022.3.62f3 — see `mod/README.md`.
