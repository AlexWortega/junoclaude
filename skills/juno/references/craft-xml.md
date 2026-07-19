# The craft file format

Everything here was verified against game 1.3.205 by parsing the 62 craft that
ship with it. Parsing and re-serializing all 62 reproduces the original file
byte for byte — that is, the model loses nothing.

## Overall structure

```xml
<Craft name="Name" xmlVersion="15" activeCommandPod="0"
       price="…" initialBoundsMin="…" initialBoundsMax="…" localCenterOfMass="…">
  <Assembly>
    <Parts>       … <Part> … </Parts>
    <Connections> … <Connection> … </Connections>
    <Collisions/>
    <Bodies>      … <Body> … </Bodies>
  </Assembly>
  <DesignerSettings/>
  <Themes/>
  <Symmetry/>
</Craft>
```

`xmlVersion` ranges from 2 to 15; the game upgrades older files to the current
version on load. Write new files with 15.

## Part

```xml
<Part id="3" partType="RocketEngine1" position="0,-2.82,0" rotation="0,0,0"
      name="Engine" activationStage="0" commandPodId="0" materials="0,1,2,3,4">
  <Drag drag="0,0,0,0,0,0" area="0,0,0,0,0,0"/>
  <Config/>
  <RocketEngine nozzleTypeId="Bravo" nozzleThroatSize="0.85"/>
  <InputController inputId="Throttle"/>
</Part>
```

| attribute | meaning |
|---|---|
| `id` | unique integer; does not have to be contiguous |
| `partType` | type from the catalog (`part_lookup`) |
| `position` | the part's **center**, meters, craft-local coordinates, `+Y` up |
| `rotation` | Euler angles, degrees |
| `rootPart="true"` | on exactly one part |
| `commandPodId` | which command pod controls the part |
| `activationStage` | stage; absent means zero |
| `activationGroup` | group 1..10 |
| `materials` | five indices into the theme's material list |
| `mirrored="true"` | mirrored copy |

### Derived fields

`price`, `initialBoundsMin/Max`, `localCenterOfMass`, `<Drag>` and the contents
of `<Bodies>` are **recomputed by the game on load**. Approximate values or
zeros are enough. Do not spend effort reproducing them exactly.

### Modifiers

A tag inside `<Part>` is a modifier name, its attributes are the modifier's
parameters. It is the modifiers that determine what a part actually is:

- `<Fuselage topScale="w,h" bottomScale="w,h" offset="0,length,0" cornerRadiuses="…"/>`
  — procedural fuselage. `offset.y` sets the length, `topScale`/`bottomScale`
  the ellipse semi-axes at the ends.
- `<FuelTank capacity fuel fuelType subPriority utilization/>` — `fuelType` can
  be `Jet`, `Battery`, `Mono`; absent means rocket fuel.
- `<RocketEngine nozzleTypeId mass nozzleThroatSize/>` — all rocket engines
  differ only in `nozzleTypeId`.
- `<Wing rootLeadingOffset rootTrailingOffset tipLeadingOffset tipTrailingOffset
  tipPosition/>` — procedural wing.
- `<CommandPod activationGroupNames activationGroupStates craftConfigType/>` —
  this is also where activation group names live; `craftConfigType` can be
  `Plane` or `Rocket`.
- `<FlightProgram><Program>…</Program></FlightProgram>` — an embedded Vizzy
  program; makes the craft self-contained.
- `<InputController input="AG3*Throttle" inputId="Motor"/>` — binds an actuator
  to the controls. The `input` attribute takes expressions over `Pitch`, `Roll`,
  `Yaw`, `Throttle`, `Brake`, `Slider1..3`, `AG1..AG10`.

The full list of modifiers and their default values comes from `part_lookup` by
`id`.

### Modifiers are mandatory, defaults are not filled in

If a part type declares a modifier, it **must be present in the XML**. The game
does not add it from the type definition.

Verified in practice: the `CommandPod1` command pod declares a `<FuelTank>` (the
capsule carries an onboard battery). A craft where it lacks that modifier will
not open at all — building the fuel system fails with a
`NullReferenceException` in `CraftFuelSources.Rebuild`, and all the interface
shows is that the craft will not load.

The exception is `<Config>`: the game fills in its fifty-odd service attributes
itself, and in craft it has saved it is always short.

`craft_build` adds missing modifiers automatically.

## Connections

```xml
<Connection partA="1" partB="0" attachPointsA="2,4" attachPointsB="1,5">
  <BodyJoint body="1" connectedBody="2" jointType="Normal" breakTorque="1E+07"
             position="0,3.95,0" axis="0,0,1"/>
</Connection>
```

`attachPointsA/B` are **comma-separated lists of indices**. A stack connection
links a `load` pair (structural joint, fuel flow) and a `shell` pair (skin). For
a stack connection `partA` is the lower part, `partB` the upper one.

`<BodyJoint>` is present **only when the connection joins two different rigid
bodies** — that is, on decouplers, hinges and pistons. Rigid welded joints do
not have one.

## Bodies

```xml
<Bodies>
  <Body id="1" partIds="0,2,3" mass="114.0" position="0,-0.19,0" centerOfMass="0,0,0"/>
</Bodies>
```

Groups parts into rigid bodies. The boundaries run along decouplers and movable
connections. The game recomputes mass and center of mass, but **respects the
split itself**: an incorrect grouping is a likely cause of a craft falling apart.

## Themes and symmetry

`<DesignerSettings/>` and `<Themes/>` may be empty — the game will substitute
the default theme. `<Symmetry/>` is optional too; the designer needs it to edit
mirrored parts as a group, and it has no effect on physics.

## A setting for comparison

By default the game minifies the XML it saves, dropping default values. To
compare a generated craft with what the game made of it, set the
`optimizeCraftXML="false"` attribute on the `<Designer>` element in
`Settings.xml`. `game_state` shows the current value.
