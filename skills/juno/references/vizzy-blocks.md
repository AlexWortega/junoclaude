# Vizzy block reference

Mined from programs written by the game itself: 25 programs, game version 1.3.205.

The style strings here are the real ones. Substituting a wrong style produces a program the game will not open.

## Craft properties

Used as `["prop", "Name"]`.

- **Altitude**: `Altitude.AGL`, `Altitude.ASL`
- **Craft**: `Craft.NameToID`, `Craft.Position`
- **Fuel**: `Fuel.AllStages`, `Fuel.Battery`, `Fuel.FuelInStage`, `Fuel.Mono`
- **Input**: `Input.Brake`, `Input.Pitch`, `Input.Throttle`, `Input.Yaw`
- **Mfd**: `Mfd.Color`, `Mfd.Exists`, `Mfd.Label.FontSize`, `Mfd.Label.Text`, `Mfd.Opacity`, `Mfd.Position`, `Mfd.Size`, `Mfd.Sprite.FillAmount`, `Mfd.Visible`
- **Misc**: `Misc.Grounded`, `Misc.NumStages`, `Misc.Stage`
- **Nav**: `Nav.CraftDirection`, `Nav.CraftHeading`, `Nav.Position`
- **Orbit**: `Orbit.Apoapsis`, `Orbit.Periapsis`, `Orbit.Planet`, `Orbit.TimeToApoapsis`, `Orbit.TimeToPeriapsis`
- **Part**: `Part.Activated`, `Part.LocalToPci`, `Part.Mass`, `Part.NameToID`, `Part.PciToLocal`, `Part.Position`, `Part.ThisID`
- **Performance**: `Performance.Mass`, `Performance.MaxActiveEngineThrust`, `Performance.TWR`
- **Raycast**: `Raycast`
- **Sound**: `Sound.Frequency`
- **Target**: `Target.Planet`, `Target.Position`
- **Terrain**: `Terrain.Color`, `Terrain.Height`
- **Time**: `Time.FrameDeltaTime`, `Time.TotalTime`
- **Vel**: `Vel.Acceleration`, `Vel.Gravity`, `Vel.MachNumber`, `Vel.OrbitVelocity`, `Vel.SurfaceVelocity`, `Vel.VerticalSurfaceVelocity`

## Instructions

| block | tag | style | arity | body |
|---|---|---|---|---|
| `SetVariable:set-variable` | SetVariable | `set-variable` | 2 |  |
| `Comment:comment` | Comment | `comment` | 1 |  |
| `SetCraftProperty:set-mfd-widget` | SetCraftProperty | `set-mfd-widget` | 2 |  |
| `If:if` | If | `if` | 1 | yes |
| `CallCustomInstruction:call-custom-instruction` | CallCustomInstruction | `call-custom-instruction` | 0/2/3/4/5 |  |
| `SetCraftProperty:create-mfd-widget` | SetCraftProperty | `create-mfd-widget` | 1 |  |
| `SetCraftProperty:set-mfd-label` | SetCraftProperty | `set-mfd-label` | 2 |  |
| `WaitSeconds:wait-seconds` | WaitSeconds | `wait-seconds` | 1 |  |
| `Event:flight-start` | Event | `flight-start` | 0 |  |
| `Event:receive-msg` | Event | `receive-msg` | 1 |  |
| `ElseIf:else-if` | ElseIf | `else-if` | 1 | yes |
| `While:while` | While | `while` | 1 | yes |
| `ElseIf:else` | ElseIf | `else` | 1 | yes |
| `SetCraftProperty:set-mfd-sprite` | SetCraftProperty | `set-mfd-sprite` | 2 |  |
| `SetCraftProperty:set-mfd-event` | SetCraftProperty | `set-mfd-event` | 3 |  |
| `For:for` | For | `for` | 3 | yes |
| `SetList:list-add` | SetList | `list-add` | 2 |  |
| `BroadcastMessage:broadcast-msg` | BroadcastMessage | `broadcast-msg` | 2 |  |
| `SetCraftProperty:set-mfd-gauge` | SetCraftProperty | `set-mfd-gauge` | 2 |  |
| `WaitUntil:wait-until` | WaitUntil | `wait-until` | 1 |  |
| `SetInput:set-input` | SetInput | `set-input` | 1 |  |
| `SetCraftProperty:play-beep` | SetCraftProperty | `play-beep` | 3 |  |
| `SetCraftProperty:set-part` | SetCraftProperty | `set-part` | 2 |  |
| `SetCraftProperty:set-mfd-map` | SetCraftProperty | `set-mfd-map` | 2 |  |
| `SetActivationGroup:set-ag` | SetActivationGroup | `set-ag` | 2 |  |
| `DisplayMessage:display` | DisplayMessage | `display` | 2 |  |
| `CustomInstruction:custom-instruction` | CustomInstruction | `custom-instruction` | 0 |  |
| `SetCraftProperty:set-mfd-alignment` | SetCraftProperty | `set-mfd-alignment` | 1 |  |
| `LockNavSphere:lock-nav-sphere` | LockNavSphere | `lock-nav-sphere` | 0 |  |
| `Repeat:repeat` | Repeat | `repeat` | 1 | yes |
| `ActivateStage:activate-stage` | ActivateStage | `activate-stage` | 0 |  |
| `SetVariable:list-init` | SetVariable | `list-init` | 2 |  |
| `SetTarget:set-target` | SetTarget | `set-target` | 1 |  |
| `ChangeVariable:change-variable` | ChangeVariable | `change-variable` | 2 |  |
| `UserInput:user-input` | UserInput | `user-input` | 2 |  |
| `SetCraftProperty:set-mfd-texture-setpixel` | SetCraftProperty | `set-mfd-texture-setpixel` | 4 |  |
| `SetList:list-clear` | SetList | `list-clear` | 1 |  |
| `Event:part-explode` | Event | `part-explode` | 0 |  |
| `SetTargetHeading:set-heading` | SetTargetHeading | `set-heading` | 1 |  |
| `BroadcastMessage:broadcast-msg-craft` | BroadcastMessage | `broadcast-msg-craft` | 2 |  |
| `SetCraftProperty:set-mfd-texture-initialize` | SetCraftProperty | `set-mfd-texture-initialize` | 3 |  |
| `Break:break` | Break | `break` | 0 |  |
| `Event:change-soi` | Event | `change-soi` | 0 |  |
| `SetCraftProperty:destroy-mfd-widget` | SetCraftProperty | `destroy-mfd-widget` | 1 |  |
| `SetCraftProperty:set-mfd-order-back` | SetCraftProperty | `set-mfd-order-back` | 2 |  |

## Expressions

Expressions are **not numbered** — they have no id attribute. The game follows this rule strictly.

| block | tag | style | arity |
|---|---|---|---|
| `Constant` | Constant | `` | 0 |
| `Variable` | Variable | `` | 0/1 |
| `Constant:comment-text` | Constant | `comment-text` | 0 |
| `EvaluateExpression:evaluate-expression` | EvaluateExpression | `evaluate-expression` | 1 |
| `StringOp:contains` | StringOp | `contains` | 2 |
| `CraftProperty:prop-mfd-widget` | CraftProperty | `prop-mfd-widget` | 1 |
| `Conditional:conditional` | Conditional | `conditional` | 3 |
| `BinaryOp:op-mul` | BinaryOp | `op-mul` | 2 |
| `StringOp:join` | StringOp | `join` | 3/4/5 |
| `VectorOp:vec-op-1` | VectorOp | `vec-op-1` | 1 |
| `Comparison:op-eq` | Comparison | `op-eq` | 2 |
| `Constant:true` | Constant | `true` | 0 |
| `CallCustomExpression:call-custom-expression` | CallCustomExpression | `call-custom-expression` | 0/1/2 |
| `ListOp:list-get` | ListOp | `list-get` | 2 |
| `StringOp:letter` | StringOp | `letter` | 2 |
| `BinaryOp:op-sub` | BinaryOp | `op-sub` | 2 |
| `Vector:vec` | Vector | `vec` | 3 |
| `BinaryOp:op-add` | BinaryOp | `op-add` | 2 |
| `MathFunction:op-math` | MathFunction | `op-math` | 1 |
| `BinaryOp:op-div` | BinaryOp | `op-div` | 2 |
| `CraftProperty:part-id` | CraftProperty | `part-id` | 1 |
| `Constant:false` | Constant | `false` | 0 |
| `StringOp:format` | StringOp | `format` | 3/4/6/7 |
| `CraftProperty:prop-mfd-sprite` | CraftProperty | `prop-mfd-sprite` | 1 |
| `Comparison:op-lt` | Comparison | `op-lt` | 2 |
| `Not:op-not` | Not | `op-not` | 1 |
| `CraftProperty:part` | CraftProperty | `part` | 1 |
| `Comparison:op-gt` | Comparison | `op-gt` | 2 |
| `CraftProperty:prop-altitude` | CraftProperty | `prop-altitude` | 0 |
| `VectorOp:vec-op-2` | VectorOp | `vec-op-2` | 2 |
| `ActivationGroup:activation-group` | ActivationGroup | `activation-group` | 1 |
| `CraftProperty:prop-velocity` | CraftProperty | `prop-velocity` | 0 |
| `CustomExpression:custom-expression` | CustomExpression | `custom-expression` | 1 |
| `ListOp:list-create` | ListOp | `list-create` | 1 |
| `BinaryOp:op-rand` | BinaryOp | `op-rand` | 2 |
| `CraftProperty:prop-fuel` | CraftProperty | `prop-fuel` | 0 |
| `CraftProperty:note-frequency` | CraftProperty | `note-frequency` | 2 |
| `StringOp:length` | StringOp | `length` | 1 |
| `CraftProperty:prop-time` | CraftProperty | `prop-time` | 0 |
| `CraftProperty:prop-nav` | CraftProperty | `prop-nav` | 0 |
| `CraftProperty:prop-name` | CraftProperty | `prop-name` | 0 |
| `BoolOp:op-and` | BoolOp | `op-and` | 2 |
| `Planet:planet-to-lat-long-asl` | Planet | `planet-to-lat-long-asl` | 1 |
| `CraftProperty:prop-misc` | CraftProperty | `prop-misc` | 0 |
| `Planet:planet` | Planet | `planet` | 1 |
| `BinaryOp:op-min` | BinaryOp | `op-min` | 2 |
| `Comparison:op-lte` | Comparison | `op-lte` | 2 |
| `StringOp:friendly` | StringOp | `friendly` | 1 |
| `CraftProperty:prop-orbit` | CraftProperty | `prop-orbit` | 0 |
| `CraftProperty:prop-input` | CraftProperty | `prop-input` | 0 |
| `ListOp:list-length` | ListOp | `list-length` | 1 |
| `CraftProperty:part-transform` | CraftProperty | `part-transform` | 2 |
| `CraftProperty:prop-mfd-label` | CraftProperty | `prop-mfd-label` | 1 |
| `Planet:planet-to-lat-long-agl` | Planet | `planet-to-lat-long-agl` | 1 |
| `BinaryOp:op-max` | BinaryOp | `op-max` | 2 |
| `BinaryOp:op-mod` | BinaryOp | `op-mod` | 2 |
| `CraftProperty:terrain-query` | CraftProperty | `terrain-query` | 1 |
| `ListOp:list-index` | ListOp | `list-index` | 2 |
| `CraftProperty:prop-performance` | CraftProperty | `prop-performance` | 0 |
| `VectorOp:vec-op-color` | VectorOp | `vec-op-color` | 1 |
| `Planet:planet-to-position` | Planet | `planet-to-position` | 1 |
| `StringOp:substring` | StringOp | `substring` | 3 |
| `BoolOp:op-or` | BoolOp | `op-or` | 2 |
| `CraftProperty:craft` | CraftProperty | `craft` | 1 |
| `CraftProperty:craft-id` | CraftProperty | `craft-id` | 1 |
| `CraftProperty:raycast-query` | CraftProperty | `raycast-query` | 2 |
| `Comparison:op-gte` | Comparison | `op-gte` | 2 |
