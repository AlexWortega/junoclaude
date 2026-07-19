# JunoBridge

Мод для **Juno: New Origins** (SimpleRockets 2), поднимающий HTTP-сервер внутри игры.
Внешний MCP-сервер через него читает телеметрию, управляет полётом и читает/пишет
Vizzy-программы.

Мод намеренно выставляет **примитивы, а не политику**: никаких «выведи на орбиту» и
PID-регуляторов на C#. Любая логика живёт на стороне MCP, где итерация занимает
секунды, а не 2–5 минут пересборки Unity и перезапуска игры.

---

## 1. Сборка и установка на macOS

### 1.1. Unity

1. **Установите Unity ровно `2022.3.62f3`** (changeset `96770f904ca7`).

   Самый быстрый путь — открыть прямую ссылку, Hub сам подхватит нужную версию:

   ```
   unityhub://2022.3.62f3/96770f904ca7
   ```

   ```bash
   open "unityhub://2022.3.62f3/96770f904ca7"
   ```

   Вручную: *Unity Hub → Installs → Install Editor → Archive → download archive* →
   найти `2022.3.62f3` в списке Unity 2022.x.

   Модули: *Mac Build Support (Mono)* и *Windows Build Support (Mono)*.
   **Mono, не IL2CPP.** (*Linux Build Support (Mono)* — по желанию, только если
   планируется сборка `.sr2-mod` под все платформы.)

   Версия не обсуждается: константа `RequiredUnityVersion` во всех трёх копиях
   поставляемой сборки ModTools равна `2022.3.62f3`. На `2022.3.20f1` сборщик
   жёстко заблокируется проверкой версии.

2. Создайте **новый пустой 3D (Built-in)** проект редактором `2022.3.62f3`.

3. **До импорта ModTools** откройте *Window → Package Manager → Add package by name*
   и установите **по порядку**:

   - `com.unity.mathematics`
   - `com.unity.collections`
   - `com.unity.burst`
   - `com.unity.textmeshpro`

   (`com.unity.ugui` и `com.unity.visualscripting` входят в проект по умолчанию —
   проверьте, что они на месте.)

   > Установка Burst и Collections **после** импорта unitypackage — известный путь
   > к падению редактора. Порядок здесь важен.

4. Закройте и снова откройте проект, чтобы Burst закончил компиляцию до того, как
   начнёт конкурировать с 12-мегабайтным импортом.

5. **Assets → Import Package → Custom Package…** →
   ```
   ~/Library/Application Support/Steam/steamapps/common/SimpleRockets2/ModTools/SimpleRockets2_ModTools.unitypackage
   ```
   → **Import All**. Около 500 ассетов. Дождитесь полного окончания импорта и не
   трогайте редактор в процессе.

6. Проверьте, что появились `Assets/ModTools/Assemblies/ModApi.dll` и `ModApi.xml`,
   а в меню редактора — пункт **SimpleRockets 2** (или Mod Tools).

### 1.2. Код мода

7. Создайте папку `Assets/JunoBridge/` и скопируйте в неё содержимое
   `mod/Scripts/JunoBridge/` из этого репозитория (структура подпапок
   `Core/`, `Net/`, `Json/`, `Handlers/`, `Serialization/` сохраняется).

   Дождитесь компиляции. **Консоль должна быть чистой.** Ошибка компиляции означает,
   что Unity не выпустит сборку, а Mod Builder всё равно соберёт внешне рабочий
   `.sr2-mod`, который ничего не делает.

   Свой `.asmdef` добавлять **не нужно**: сборщик сам создаёт корневое определение
   сборки (`CreateRootAssemblyDefinition`), и лишний asmdef может увести типы в
   сборку, которую он не сканирует.

### 1.3. Mod Builder

8. Меню → **SimpleRockets 2 → Mod Builder**.

9. Заполните: Name `JunoBridge`, Author, Version `0.1.0`, Description.
   **Убедитесь, что ваша сборка присутствует в списке assemblies** — это контрольная
   точка, доказывающая, что Unity скомпилировал код, а сборщик его нашёл.

10. Соберите под **macOS** (самый быстрый цикл). Для распространения позже соберите
    **All Platforms**: контейнер `.sr2-mod` несёт бандлы всех платформ по записанным
    смещениям, один файл подходит всем.

11. Скопируйте результат в:
    ```
    ~/Library/Application Support/com.jundroo.SimpleRockets2/Mods/JunoBridge.sr2-mod
    ```

12. Запустите игру → **Settings → Mods** → включите **JunoBridge** → **перезапустите игру**.

13. Проверка:
    ```bash
    curl -H "Authorization: Bearer $(cat ~/Library/Application\ Support/com.jundroo.SimpleRockets2/junobridge.token)" \
         http://127.0.0.1:7842/status
    ```

---

## 2. Эксплуатационные оговорки

- **После каждого обновления игры моды автоматически отключаются** и требуют повторного
  включения. Игра сравнивает `appVersionLastRun` в `Settings.xml`.
- **Отключение** мода выставляет `ModInfo.PendingDisable` и требует перезапуска.
  Включение тоже вступает в силу после перезапуска. Считайте, что любое переключение
  мода = перезапуск игры.
- Замена файла `.sr2-mod` требует полного перезапуска: AssetBundle отображён в память
  на всю сессию.
- Оставьте `ignoreVersionMismatch="false"`. На `2022.3.62f3` он не понадобится, а
  включённым скрывает настоящие проблемы.
- **Поставьте `runInBackground="true"` в `Settings.xml` в первый же день.** Иначе игра
  без фокуса падает до ~1 fps, главный поток почти перестаёт прокачивать очередь, и
  каждый запрос отдаёт `504` ровно в тот момент, когда вы переключились в терминал.
  Это выглядит как загадочный баг моста и стоит потерянного дня.
- Логи игры: `~/Library/Logs/Jundroo/SimpleRockets 2/Player.log`. Держите `tail -f`
  в соседней панели.

---

## 3. Аутентификация

Сервер слушает **только `127.0.0.1:7842`**.

При инициализации мода генерируется 32-байтовый токен и пишется в файл с правами `0600`:

```
~/Library/Application Support/com.jundroo.SimpleRockets2/junobridge.token
```

Рядом кладётся описание для автообнаружения:

```
~/Library/Application Support/com.jundroo.SimpleRockets2/junobridge.json
    { "port": 7842, "apiVersion": 1, "modVersion": "0.1.0", "pid": …, "tokenFile": "…" }
```

Токен генерируется заново при каждом запуске игры. Каждый запрос обязан нести
`Authorization: Bearer <token>` (либо `?token=` — удобно для `/screenshot` в браузере).

**CORS-заголовков нет намеренно.** MCP-сервер — не браузер, а `Access-Control-Allow-Origin`
создал бы поверхность атаки, при которой вредоносная страница в браузере пользователя
управляет его игрой. Запросы с заголовком `Origin` отбиваются `403`.

---

## 4. HTTP API

Общий конверт ответа:

```json
{ "ok": true,  "apiVersion": 1, "gameTime": 312.44, "data": { … } }
{ "ok": false, "apiVersion": 1, "gameTime": 312.44,
  "error": { "code": "wrong_scene", "message": "…", "detail": { … } } }
```

Ветвиться следует по стабильному `error.code`, а не по HTTP-статусу.

| Метод | Путь | Сцена | Описание |
|---|---|---|---|
| GET | `/status` | любая | Не отказывает никогда. `scene`, `paused`, `eventSeq`, `capabilities`, `supportsCodeExecution`. |
| GET | `/events?since=&limit=` | любая | Кольцевой буфер на 512 событий. `dropped > 0` — история потеряна, перечитайте состояние целиком. |
| GET | `/jobs/{id}` | любая | Статус асинхронной задачи. |
| GET | `/telemetry` | полёт | Полная телеметрия: положение, ориентация, скорости, динамика, масса, тяга, орбита, органы управления. |
| GET | `/telemetry/lite` | полёт | ~15 полей для опроса на высокой частоте. |
| GET | `/craft` | полёт/конструктор | Сводка активного корабля. |
| GET | `/craft/all` | полёт | Все `FlightState.CraftNodes`. |
| GET | `/craft/parts` | полёт/конструктор | Все детали: id, тип, ступень, группа активации. |
| GET | `/parts/{partId}` | полёт/конструктор | Одна деталь вместе с модификаторами. |
| GET | `/stages` | полёт | `currentStage`, `numStages`, распределение деталей по ступеням. |
| GET | `/craft/list` | любая | Идентификаторы сохранённых чертежей. |
| POST | `/craft/save` | любая | `{"craftId":"…","xml":"<Craft …>"}` → путь файла. |
| POST | `/flight/input` | полёт | Органы управления, см. §5. |
| POST | `/flight/stage` | полёт | `ICommandPod.ActivateStage()`. |
| POST | `/flight/activation-group` | полёт | `{"group":1,"state":true}` либо `{"group":1,"toggle":true}`. |
| POST | `/flight/timewarp` | полёт | `{"modeIndex":3}` \| `{"delta":+1}` \| `{"paused":true}`. |
| POST | `/flight/launch` | любая | `{"craftId":"…","launchLocation":"…"}` либо `{"fromDesigner":true}`. → `202` + `jobId`. |
| POST | `/scene/load` | любая | `{"scene":"menu"\|"designer"\|"planetstudio"\|"techtree"}`. → `202` + `jobId`. |
| GET | `/vizzy/{partId}` | полёт/конструктор | XML полётной программы. |
| PUT | `/vizzy/{partId}` | **только конструктор** | `{"xml":"<Program>…</Program>"}`. В полёте → `409 requires_designer`. |
| GET | `/screenshot?w=&h=` | любая | Сырой `image/png`. По умолчанию ширина 1280. |
| GET | `/planets` | полёт | Дерево небесных тел. |
| GET | `/launch-locations` | любая | Стартовые площадки из `IGameState`. |

### Коды ошибок

| `error.code` | HTTP | Смысл |
|---|---|---|
| `unauthorized` | 401 | Нет или неверен bearer-токен. |
| `origin_rejected` | 403 | Запрос пришёл с заголовком `Origin`. |
| `wrong_scene` | 409 | Нужна другая сцена (`detail.scene` — текущая). |
| `no_craft`, `no_command_pod` | 409 | Нет активного корабля или командного модуля. |
| `requires_designer` | 409 | Запись Vizzy возможна только в конструкторе. |
| `scene_transitioning` | 503 | Идёт смена сцены. Есть `Retry-After: 1`. |
| `overloaded` | 503 | Очередь к главному потоку переполнена. |
| `shutting_down` | 503 | Игра закрывается. |
| `main_thread_timeout` | 504 | Главный поток не обслужил запрос за отведённое время. |

### Тайм-ауты

| Класс запроса | Лимит |
|---|---|
| Чтение (`/telemetry`, `/craft`, `/status`) | 1500 мс |
| Запись (`/flight/*`, `PUT /vizzy`) | 3000 мс |
| Скриншот | 5000 мс |
| Смена сцены (`/scene/load`, `/flight/launch`) | не ждётся: `202` + `jobId` |

---

## 5. `POST /flight/input`

```json
{ "throttle": 0.85, "pitch": 0.1, "yaw": 0, "roll": -0.2,
  "brake": 0, "translateForward": 0, "translateRight": 0, "translateUp": 0,
  "slider1": 0.5, "targetHeading": 90,
  "activationGroups": { "1": true, "5": false },
  "mode": "hold" }
```

Все поля необязательны; отсутствующее поле не меняется, `null` снимает удержание с оси.

| `mode` | Поведение |
|---|---|
| `set` | Однократная запись. Собственный ввод игры перезапишет её на следующем кадре. |
| `hold` | **Основной режим.** Значение переставляется каждый `FlightPreFixedUpdate` до отмены. Без этого команда агента живёт один кадр и ничего не делает. |
| `pulse` | Удержание на `pulseMs` (по умолчанию 250 мс), затем автоматический сброс. |
| `clear` | Снять все удержания. |

Текущие удержания видны в `/telemetry` → `controls.overridesHeld`.

---

## 6. Устройство

```
Scripts/JunoBridge/
├── JunoBridgeMod.cs            точка входа (GameMod), синглтон, жизненный цикл
├── Core/
│   ├── MainThreadDispatcher.cs очередь к главному потоку, TCS + бюджет на кадр
│   ├── BridgePump.cs           прокачка из игровых циклов и Update, конец кадра
│   ├── SceneGate.cs            детект перехода сцен
│   ├── Clock.cs                кэш времени, читаемый с любого потока
│   ├── EventLog.cs             кольцевой буфер событий
│   ├── EventSubscriptions.cs   подписки на события игры
│   ├── ControlOverrides.cs     удержание органов управления
│   ├── JobRegistry.cs          асинхронные задачи (202)
│   └── GameContext.cs          единая точка доступа к объектам игры
├── Net/                        ITransport, HttpListenerTransport, Router, Auth, конверты
├── Json/                       JsonWriter (сериализация), JsonLite (разбор тел запросов)
├── Handlers/                   по обработчику на группу ручек
└── Serialization/              телеметрия, корабль, орбита
```

**Два правила, из которых следует всё остальное:**

1. Любое обращение к Unity/ModApi происходит на главном потоке — без исключений,
   даже чтение `craftNode.Altitude`.
2. HTTP-поток никогда не держит замок, нужный главному потоку. Общее состояние —
   только `ConcurrentQueue` и объекты завершения запросов.

Ожидание построено на `TaskCompletionSource` + `TrySetResult`, а не на
`ManualResetEventSlim`: по тайм-ауту запрос можно бросить, и последующий
`TrySetResult` с главного потока окажется безобидным no-op. `mre.Set()` на
уничтоженном `ManualResetEventSlim` бросил бы исключение **на главном потоке**
и уронил игровой цикл.

`Newtonsoft.Json` в наборе ссылок ModTools отсутствует, поэтому JSON пишется вручную.
Каждое число форматируется с `CultureInfo.InvariantCulture` и спецификатором `"R"`, а
`NaN`/`Infinity` вырождаются в `null` — иначе немецкая локаль выдала бы `3,14`, а
бесконечный перицентр гиперболической траектории — невалидный JSON.

---

## 7. Известные места, требующие проверки на живой игре

В коде помечены комментариями `// TODO(проверить):`.

- Типы свойств `IFlightScene.GameLoop` и `IDesigner.GameLoop` — регистрация в игровых
  циклах. При промахе мост продолжит работать через `Update()`, потеряв точность
  порядка относительно физики.
- `IOrbit.PeriapsisAngle` — аргумент перицентра или долгота перицентра. В JSON поле
  названо нейтрально `periapsisAngle`.
- Форма вызова `ProgramSerializer.DeserializeFlightProgram` — статический или
  экземплярный. Вызывается через рефлексию, чтобы промах не ломал компиляцию;
  при неудаче валидация Vizzy-программы просто пропускается.
- Захват экрана на Metal: если `ScreenCapture.CaptureScreenshotAsTexture` даёт чёрный
  кадр, потребуется резервный путь через `Camera → RenderTexture → ReadPixels`.
- Канал вывода Vizzy: основной — записи `FlightLog` категории `Vizzy`; дублирование в
  дев-консоль включается принудительно как запасной путь.
