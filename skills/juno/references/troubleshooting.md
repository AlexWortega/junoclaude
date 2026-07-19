# What went wrong

A table of symptoms. The second column is the likely cause, the third how to
check.

## Craft

| Symptom | Cause | Check |
|---|---|---|
| The craft is not in the designer list | The file is not in `UserData/CraftDesigns/`, or the game was running when it was written and overwrote the directory | `game_state` shows whether the game was running; `craft_list` whether the plugin sees the file |
| The craft does not open at all, the log shows a `NullReferenceException` in `CraftFuelSources.Rebuild` | A part is missing a modifier declared by its type. Most often `<FuelTank>` on the command pod: the capsule carries an onboard battery, and without it the fuel system cannot be built | `part_lookup` on the part type shows the declared modifiers; compare with what is in the XML |
| The craft opened, but has fewer parts than the XML | The game dropped parts on load: unreachable from the root part, or an unknown `partType` | `craft_read` in `summary` mode — the `Предупреждения` (warnings) section lists disconnected parts |
| The same number of parts, but the craft is "scattered" | The connections point at the wrong attach points | `craft_read` in `xml` mode for the pair of parts, compare with `part_lookup` |
| The fuselage looks segmented, the craft is slowed down in the atmosphere | The stack connection specifies only the `load` pair, without the `shell` pair | For `Fuselage1→Fuselage1` it must be `a="2,4" b="1,5"`, not `a="2" b="1"` |
| Falls apart right after launch | The `<Bodies>` grouping does not match the actual hinges and decouplers | Save the craft from the designer over ours and compare `<Bodies>` |
| Tanks are empty, there is no thrust | `<FuelTank capacity>` was not recomputed | Compare with the file the game saved: if `capacity` differs there, our estimate is wrong |
| The engine does not fire | The part is on a different stage than expected, or is not linked to the command pod | The `Ступени` (stages) section of the summary |

## Flight program

| Symptom | Cause | Check |
|---|---|---|
| The compiler rejected an operation | The name is not in the DSL | The message contains the path to the error site and similar names; the full list is in `vizzy-blocks.md` |
| The compiler rejected a craft property | A typo, or the property exists only for MFDs | The property list in `vizzy-blocks.md` |
| The program opened, but the blocks lie on top of each other | The top-level blocks had no `pos` | The compiler assigns `pos` itself; restore it if you edited the XML by hand |
| The program does not run in flight | There is no `FlightStart` handler, or the program is in a part that is not a computer | `vizzy_read` shows the handlers; the carrier can be a command pod, a disk, a chip or an MFD |
| The program disappeared after saving from the game | The program was written while the game was running | `game_state` before writing; restore from a snapshot |

## General

| Symptom | Cause | Check |
|---|---|---|
| A tool answers `game_running` | The game is running | `game_quit`, then retry |
| A tool answers `file_busy` | The file was modified less than three seconds ago | Wait and retry |
| The part catalog cannot be read | The plugin was installed without the generated catalogs | `npm run catalog` in the plugin root |
| `game_state` warns about a version mismatch | The game updated after the catalog was built | Rebuild the catalog: the formats may have changed |

## Reading the log

By default `log_read` shows only errors, together with their stacks and with
repeats collapsed. Useful filters:

- `filter: "errors"` — exceptions from the game and mods;
- `filter: "mods"` — everything about mod loading; this is where you see whether
  the `.sr2-mod` was accepted and whether it was rejected over a version
  mismatch;
- `filter: "all"` — the whole tail of the log, when you need context around an
  event.

The absence of errors in the log does not mean the craft is sound: the game may
not treat parts dropped on load as an error. Compare the number of parts in the
designer with the number in the XML.
