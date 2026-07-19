# JunoBridge

A mod for **Juno: New Origins** (SimpleRockets 2) that runs an HTTP server inside the game.
An external MCP server uses it to read telemetry, control flight, and read/write
Vizzy programs.

The mod deliberately exposes **primitives, not policy**: no "put me in orbit" and no
PID controllers in C#. All logic lives on the MCP side, where an iteration takes
seconds rather than the 2-5 minutes of a Unity rebuild and a game restart.

---

## 1. Building and installing on macOS

### 1.1. Unity

1. **Install Unity exactly `2022.3.62f3`** (changeset `96770f904ca7`).

   The fastest path is to open the direct link and let the Hub pick up the right version:

   ```
   unityhub://2022.3.62f3/96770f904ca7
   ```

   ```bash
   open "unityhub://2022.3.62f3/96770f904ca7"
   ```

   Manually: *Unity Hub → Installs → Install Editor → Archive → download archive* →
   find `2022.3.62f3` in the Unity 2022.x list.

   Modules: *Mac Build Support (Mono)* and *Windows Build Support (Mono)*.
   **Mono, not IL2CPP.** (*Linux Build Support (Mono)* is optional, only if you
   plan to build the `.sr2-mod` for all platforms.)

   The version is not negotiable: the `RequiredUnityVersion` constant in all three
   copies of the shipped ModTools assembly is `2022.3.62f3`. On `2022.3.20f1` the
   builder hard-blocks on the version check.

2. Create a **new empty 3D (Built-in)** project with the `2022.3.62f3` editor.

3. **Before importing ModTools** open *Window → Package Manager → Add package by name*
   and install, **in this order**:

   - `com.unity.mathematics`
   - `com.unity.collections`
   - `com.unity.burst`
   - `com.unity.textmeshpro`

   (`com.unity.ugui` and `com.unity.visualscripting` ship with the project by default —
   verify they are present.)

   > Installing Burst and Collections **after** importing the unitypackage is a known
   > path to an editor crash. The order matters here.

4. Close and reopen the project so that Burst finishes compiling before it starts
   competing with a 12 MB import.

5. **Assets → Import Package → Custom Package…** →
   ```
   ~/Library/Application Support/Steam/steamapps/common/SimpleRockets2/ModTools/SimpleRockets2_ModTools.unitypackage
   ```
   → **Import All**. About 500 assets. Wait for the import to finish completely and
   do not touch the editor while it runs.

6. Verify that `Assets/ModTools/Assemblies/ModApi.dll` and `ModApi.xml` appeared,
   and that the editor menu now has a **SimpleRockets 2** (or Mod Tools) entry.

### 1.2. Mod code

7. Create the folder `Assets/JunoBridge/` and copy the contents of
   `mod/Scripts/JunoBridge/` from this repository into it (the subfolder structure
   `Core/`, `Net/`, `Json/`, `Handlers/`, `Serialization/` is preserved).

   Wait for compilation. **The console must be clean.** A compile error means Unity
   will not emit the assembly, while Mod Builder will still produce an outwardly
   working `.sr2-mod` that does nothing.

   You do **not** need to add your own `.asmdef`: the builder creates the root assembly
   definition itself (`CreateRootAssemblyDefinition`), and an extra asmdef can move
   types into an assembly it does not scan.

### 1.3. Mod Builder

8. Menu → **SimpleRockets 2 → Mod Builder**.

9. Fill in: Name `JunoBridge`, Author, Version `0.1.0`, Description.
   **Make sure your assembly appears in the assemblies list** — this is the checkpoint
   proving Unity compiled the code and the builder found it.

10. Build for **macOS** (the fastest cycle). For distribution, build **All Platforms**
    later: the `.sr2-mod` container carries bundles for every platform at recorded
    offsets, so a single file works for everyone.

11. Copy the result to:
    ```
    ~/Library/Application Support/com.jundroo.SimpleRockets2/Mods/JunoBridge.sr2-mod
    ```

12. Start the game → **Settings → Mods** → enable **JunoBridge** → **restart the game**.

13. Check:
    ```bash
    curl -H "Authorization: Bearer $(cat ~/Library/Application\ Support/com.jundroo.SimpleRockets2/junobridge.token)" \
         http://127.0.0.1:7842/status
    ```

---

## 2. Operational caveats

- **After every game update mods are disabled automatically** and have to be re-enabled.
  The game compares `appVersionLastRun` in `Settings.xml`.
- **Disabling** a mod sets `ModInfo.PendingDisable` and requires a restart. Enabling
  also takes effect only after a restart. Assume any mod toggle = game restart.
- Replacing the `.sr2-mod` file requires a full restart: the AssetBundle is mapped into
  memory for the whole session.
- Leave `ignoreVersionMismatch="false"`. On `2022.3.62f3` you will not need it, and
  turning it on hides real problems.
- **Set `runInBackground="true"` in `Settings.xml` on day one.** Otherwise an unfocused
  game drops to ~1 fps, the main thread almost stops pumping the queue, and every
  request returns `504` at exactly the moment you switch to the terminal. It looks like
  a mysterious bridge bug and costs a lost day.
- Game logs: `~/Library/Logs/Jundroo/SimpleRockets 2/Player.log`. Keep a `tail -f`
  in a pane next to you.

---

## 3. Authentication

The server listens on **`127.0.0.1:7842` only**.

At mod initialization a 32-byte token is generated and written to a file with `0600`
permissions:

```
~/Library/Application Support/com.jundroo.SimpleRockets2/junobridge.token
```

A descriptor for autodiscovery is placed next to it:

```
~/Library/Application Support/com.jundroo.SimpleRockets2/junobridge.json
    { "port": 7842, "apiVersion": 1, "modVersion": "0.1.0", "pid": …, "tokenFile": "…" }
```

The token is regenerated on every game launch. Every request must carry
`Authorization: Bearer <token>` (or `?token=` — convenient for `/screenshot` in a browser).

**There are deliberately no CORS headers.** The MCP server is not a browser, and
`Access-Control-Allow-Origin` would create an attack surface where a malicious page in
the user's browser drives their game. Requests carrying an `Origin` header are rejected
with `403`.

---

## 4. HTTP API

The common response envelope:

```json
{ "ok": true,  "apiVersion": 1, "gameTime": 312.44, "data": { … } }
{ "ok": false, "apiVersion": 1, "gameTime": 312.44,
  "error": { "code": "wrong_scene", "message": "…", "detail": { … } } }
```

Branch on the stable `error.code`, not on the HTTP status.

| Method | Path | Scene | Description |
|---|---|---|---|
| GET | `/status` | any | Never fails. `scene`, `paused`, `eventSeq`, `capabilities`, `supportsCodeExecution`. |
| GET | `/events?since=&limit=` | any | Ring buffer of 512 events. `dropped > 0` means history was lost, re-read the whole state. |
| GET | `/jobs/{id}` | any | Status of an async job. |
| GET | `/telemetry` | flight | Full telemetry: position, orientation, velocities, dynamics, mass, thrust, orbit, controls. |
| GET | `/telemetry/lite` | flight | ~15 fields for high-frequency polling. |
| GET | `/craft` | flight/designer | Summary of the active craft. |
| GET | `/craft/all` | flight | All `FlightState.CraftNodes`. |
| GET | `/craft/parts` | flight/designer | All parts: id, type, stage, activation group. |
| GET | `/parts/{partId}` | flight/designer | A single part together with its modifiers. |
| GET | `/stages` | flight | `currentStage`, `numStages`, distribution of parts across stages. |
| GET | `/craft/list` | any | Identifiers of saved blueprints. |
| POST | `/craft/save` | any | `{"craftId":"…","xml":"<Craft …>"}` → file path. |
| POST | `/flight/input` | flight | Controls, see §5. |
| POST | `/flight/stage` | flight | `ICommandPod.ActivateStage()`. |
| POST | `/flight/activation-group` | flight | `{"group":1,"state":true}` or `{"group":1,"toggle":true}`. |
| POST | `/flight/timewarp` | flight | `{"modeIndex":3}` \| `{"delta":+1}` \| `{"paused":true}`. |
| POST | `/flight/launch` | any | `{"craftId":"…","launchLocation":"…"}` or `{"fromDesigner":true}`. → `202` + `jobId`. |
| POST | `/scene/load` | any | `{"scene":"menu"\|"designer"\|"planetstudio"\|"techtree"}`. → `202` + `jobId`. |
| GET | `/vizzy/{partId}` | flight/designer | XML of the flight program. |
| PUT | `/vizzy/{partId}` | **designer only** | `{"xml":"<Program>…</Program>"}`. In flight → `409 requires_designer`. |
| GET | `/screenshot?w=&h=` | any | Raw `image/png`. Default width 1280. |
| GET | `/planets` | flight | Tree of celestial bodies. |
| GET | `/launch-locations` | any | Launch pads from `IGameState`. |

### Error codes

| `error.code` | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | Missing or invalid bearer token. |
| `origin_rejected` | 403 | The request carried an `Origin` header. |
| `wrong_scene` | 409 | A different scene is required (`detail.scene` is the current one). |
| `no_craft`, `no_command_pod` | 409 | No active craft or no command pod. |
| `requires_designer` | 409 | Writing Vizzy is only possible in the designer. |
| `scene_transitioning` | 503 | A scene change is in progress. Comes with `Retry-After: 1`. |
| `overloaded` | 503 | The queue to the main thread is full. |
| `shutting_down` | 503 | The game is shutting down. |
| `main_thread_timeout` | 504 | The main thread did not service the request within its budget. |

### Timeouts

| Request class | Limit |
|---|---|
| Reads (`/telemetry`, `/craft`, `/status`) | 1500 ms |
| Writes (`/flight/*`, `PUT /vizzy`) | 3000 ms |
| Screenshot | 5000 ms |
| Scene change (`/scene/load`, `/flight/launch`) | not awaited: `202` + `jobId` |

---

## 5. `POST /flight/input`

```json
{ "throttle": 0.85, "pitch": 0.1, "yaw": 0, "roll": -0.2,
  "brake": 0, "translateForward": 0, "translateRight": 0, "translateUp": 0,
  "slider1": 0.5, "targetHeading": 90,
  "activationGroups": { "1": true, "5": false },
  "mode": "hold" }
```

All fields are optional; an absent field is left unchanged, `null` releases the hold on
an axis.

| `mode` | Behavior |
|---|---|
| `set` | A single write. The game's own input will overwrite it on the next frame. |
| `hold` | **The main mode.** The value is reapplied on every `FlightPreFixedUpdate` until cancelled. Without this an agent's command lives for one frame and does nothing. |
| `pulse` | Held for `pulseMs` (250 ms by default), then reset automatically. |
| `clear` | Release all holds. |

Current holds are visible in `/telemetry` → `controls.overridesHeld`.

---

## 6. Layout

```
Scripts/JunoBridge/
├── JunoBridgeMod.cs            entry point (GameMod), singleton, lifecycle
├── Core/
│   ├── MainThreadDispatcher.cs queue to the main thread, TCS + per-frame budget
│   ├── BridgePump.cs           pumping from game loops and Update, end of frame
│   ├── SceneGate.cs            scene transition detection
│   ├── Clock.cs                time cache readable from any thread
│   ├── EventLog.cs             ring buffer of events
│   ├── EventSubscriptions.cs   subscriptions to game events
│   ├── ControlOverrides.cs     holding control inputs
│   ├── JobRegistry.cs          async jobs (202)
│   └── GameContext.cs          single access point to game objects
├── Net/                        ITransport, HttpListenerTransport, Router, Auth, envelopes
├── Json/                       JsonWriter (serialization), JsonLite (request body parsing)
├── Handlers/                   one handler per group of endpoints
└── Serialization/              telemetry, craft, orbit
```

**Two rules everything else follows from:**

1. Any access to Unity/ModApi happens on the main thread — no exceptions, not even
   reading `craftNode.Altitude`.
2. The HTTP thread never holds a lock the main thread needs. Shared state is only
   `ConcurrentQueue` and request completion objects.

Waiting is built on `TaskCompletionSource` + `TrySetResult` rather than
`ManualResetEventSlim`: on timeout the request can be abandoned, and a later
`TrySetResult` from the main thread is a harmless no-op. `mre.Set()` on a disposed
`ManualResetEventSlim` would throw **on the main thread** and take down the game loop.

`Newtonsoft.Json` is absent from the ModTools reference set, so JSON is written by hand.
Every number is formatted with `CultureInfo.InvariantCulture` and the `"R"` specifier,
and `NaN`/`Infinity` degrade to `null` — otherwise a German locale would emit `3,14`,
and the infinite periapsis of a hyperbolic trajectory would produce invalid JSON.

---

## 7. Known spots that need verification against the live game

Marked in the code with `// TODO(verify):` comments.

- The property types of `IFlightScene.GameLoop` and `IDesigner.GameLoop` — registration
  in the game loops. If this misses, the bridge keeps working through `Update()`, losing
  ordering precision relative to physics.
- `IOrbit.PeriapsisAngle` — argument of periapsis or longitude of periapsis. In JSON the
  field is named neutrally, `periapsisAngle`.
- The call shape of `ProgramSerializer.DeserializeFlightProgram` — static or instance.
  It is invoked via reflection so that a miss does not break compilation; on failure
  Vizzy program validation is simply skipped.
- Screen capture on Metal: if `ScreenCapture.CaptureScreenshotAsTexture` yields a black
  frame, a fallback path through `Camera → RenderTexture → ReadPixels` will be needed.
- The Vizzy output channel: the primary one is `FlightLog` entries of category `Vizzy`;
  mirroring to the dev console is force-enabled as a fallback path.
