# JunoClaude

A Claude Code plugin for **Juno: New Origins** (SimpleRockets 2): building
craft, writing Vizzy flight programs, launching and reviewing test flights.

It has two parts:

- **The plugin** — a skill and an MCP server that work directly on the game's
  files. It works right away, with nothing else to install.
- **The bridge mod** (`mod/`) — an HTTP server inside the game for live
  telemetry and flight control. Building it requires Unity 2022.3.62f3; see
  `mod/README.md`.

## Installation

```bash
git clone <repo> junoclaude
cd junoclaude
npm install && npm run catalog     # part and block catalogs
cd mcp && npm install && npm run build
```

Then add the directory as a Claude Code plugin.

The game's paths are detected automatically on macOS and can be overridden with
`JUNO_INSTALL_DIR`, `JUNO_USER_DIR`, `JUNO_LOG_PATH`.

## Tools

| Tool | Purpose |
|---|---|
| `game_state` | Installation, whether the game is running, settings, mods |
| `craft_list` | List of craft |
| `craft_read` | Summary, part tree, or XML of selected parts |
| `craft_build` | Build a craft from a declarative spec |
| `part_lookup` | Part types, attach points, connection recipes |
| `vizzy_read` | Flight program in the compact DSL |
| `vizzy_write` | Compile the DSL to Vizzy XML and write it |
| `game_launch`, `game_quit` | Control the game process |
| `log_read` | Errors from `Player.log` with stacks |
| `junoclaude_restore` | Roll back to the snapshot taken before a write |

## How it works

The game's formats are undocumented, so what we know about them was **mined from
files the game wrote itself** rather than reasoned out:

- `scripts/build-parts-catalog.mjs` extracts the definitions of 70 part types
  from `SimpleRockets2_ModTools.unitypackage` and classifies the attach points;
- `scripts/mine-connections.mjs` counts the frequencies of attach point
  combinations across 61 stock craft and sorts them by kind of connection. This
  turned out to be necessary: the most frequent recipe for a
  `Fuselage1→Fuselage1` pair is not a stack connection at all, but attachment to
  a side surface;
- `scripts/mine-vizzy-blocks.mjs` collects the real `style` strings for 45 Vizzy
  instructions and 67 expressions.

The catalogs are committed to the repository, because installing the plugin does
not run the build.

## Verified against the running game

The following was checked against the game itself, not inferred:

- **Round-trip fidelity.** Parsing and re-serializing reproduces the original
  file byte for byte: 62 of 62 craft, 5 of 5 subassemblies, 7 of 7 flight
  programs. That is, the model loses no attribute of anything we generate.
  Differences remain on the stock `GameState`/`FlightState` files, which contain
  empty tags of the form `<X></X>`; those files are edited by targeted
  replacement rather than by rebuilding the tree.
- **The fuel capacity formula.** Derived statistically from 2286 tanks and then
  confirmed: `capacity = 550 × utilization × length × cross-section area`, where
  the area interpolates between `π·a·b` (round cross-section) and `4·a·b`
  (square). The round/square ratio came out at exactly 4/π. For the same tank
  the generated value is 8639.379797 against the game's own 8639.3798828125.
- **Modifiers are mandatory.** If a part type declares a modifier it must be
  present in the XML; the game does not fill in defaults. A `CommandPod1`
  without its `<FuelTank>` fails to load with a `NullReferenceException` in
  `CraftFuelSources.Rebuild`.
- **Rigid body splits.** A body must split *before* a detachable part, and body
  mass must not be zero — a zero-mass body makes the game spawn the craft below
  sea level.
- **The craft list is not cached.** A craft written while the game is running
  shows up in the designer immediately.
- **The attach-point resolver is correct.** The game did not alter any
  connection in a generated craft, including two that the builder had flagged as
  heuristically inferred.
- **The bridge mod works.** The game loads it, the HTTP server answers with
  token auth, and a stock rocket was launched and flown through it: altitude
  230 m → 1307 m, vertical speed +122 m/s, TWR 1.59 → 1.82. This requires
  `Run In Background` enabled in the game settings, otherwise Unity freezes
  `Update` while unfocused and the bridge times out.

## Safety

The plugin writes into the game's save directory, so:

- every write is preceded by a snapshot in `.junoclaude-backups/`, rolled back
  with a single `junoclaude_restore` call;
- files the game rewrites itself (`GameStates/`, `Settings.xml`, `Career/`) are
  not editable while it is running. Craft and flight programs are, since the
  craft list turned out not to be cached;
- writes are atomic — the game never sees a half-written file.

## Status

Working: the catalogs, reading craft, `craft_build`, the Vizzy compiler and
decompiler, launching the game, log parsing, snapshots and rollback, and the
bridge mod with live telemetry and flight control.

Known gap: `craft_build` lays the stack out from zero upward, while the game
expects the origin to sit at the center of mass. A generated craft therefore
spawns misaligned and topples. The rule is established — shift every position by
minus the center of mass — but not yet implemented. Stock craft launch and fly
correctly through the bridge.

Not started: `scenario_create` (spawning at a launch site or directly in orbit),
and wings in `craft_build` — `Wing1` is a twelve-parameter procedural surface
that does not compose with a linear stack, so use `{kind: "raw"}` meanwhile.

The bridge exposes one endpoint as deliberately unsupported: `targetHeading`
returns `501`, because the game models it as an orientation quaternion rather
than a scalar heading, and the correct construction was not documented. Writing
a plausible-looking quaternion would have steered craft blindly.

## Requirements

- macOS, Juno: New Origins 1.3.205 (Steam)
- Node 20+
- For the bridge mod: Unity **2022.3.62f3** exactly — the version is enforced by
  ModTools — with Mac and Windows Build Support (Mono)
- **Enable `Run In Background` in the game settings**, or every bridge request
  times out while the window is unfocused

## License

MIT
