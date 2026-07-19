# Формат файла конструкции

Всё проверено на игре 1.3.205 разбором 62 конструкций из поставки. Разбор и
обратная сборка всех 62 дают побайтово исходный файл — то есть модель ничего
не теряет.

## Общая структура

```xml
<Craft name="Имя" xmlVersion="15" activeCommandPod="0"
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

`xmlVersion` встречается от 2 до 15; игра поднимает старые файлы до текущей
версии при загрузке. Новые файлы пишите с 15.

## Деталь

```xml
<Part id="3" partType="RocketEngine1" position="0,-2.82,0" rotation="0,0,0"
      name="Двигатель" activationStage="0" commandPodId="0" materials="0,1,2,3,4">
  <Drag drag="0,0,0,0,0,0" area="0,0,0,0,0,0"/>
  <Config/>
  <RocketEngine nozzleTypeId="Bravo" nozzleThroatSize="0.85"/>
  <InputController inputId="Throttle"/>
</Part>
```

| атрибут | смысл |
|---|---|
| `id` | уникальное целое; непрерывность не требуется |
| `partType` | тип из каталога (`part_lookup`) |
| `position` | **центр** детали, метры, локальные координаты аппарата, `+Y` вверх |
| `rotation` | углы Эйлера, градусы |
| `rootPart="true"` | ровно у одной детали |
| `commandPodId` | какой командный модуль управляет деталью |
| `activationStage` | ступень; отсутствие равно нулю |
| `activationGroup` | группа 1..10 |
| `materials` | пять индексов в список материалов темы |
| `mirrored="true"` | зеркальная копия |

### Производные поля

`price`, `initialBoundsMin/Max`, `localCenterOfMass`, `<Drag>` и содержимое
`<Bodies>` игра **пересчитывает при загрузке**. Достаточно приблизительных
значений или нулей. Не тратьте усилия на их точное воспроизведение.

### Модификаторы

Тег внутри `<Part>` — имя модификатора, атрибуты — его параметры. Именно
модификаторы определяют, чем деталь является:

- `<Fuselage topScale="ш,г" bottomScale="ш,г" offset="0,длина,0" cornerRadiuses="…"/>`
  — процедурный корпус. `offset.y` задаёт длину, `topScale`/`bottomScale` —
  полуоси эллипса на торцах.
- `<FuelTank capacity fuel fuelType subPriority utilization/>` — `fuelType`
  бывает `Jet`, `Battery`, `Mono`; отсутствие означает ракетное топливо.
- `<RocketEngine nozzleTypeId mass nozzleThroatSize/>` — все ракетные двигатели
  различаются только `nozzleTypeId`.
- `<Wing rootLeadingOffset rootTrailingOffset tipLeadingOffset tipTrailingOffset
  tipPosition/>` — процедурное крыло.
- `<CommandPod activationGroupNames activationGroupStates craftConfigType/>` —
  здесь же названия групп активации; `craftConfigType` бывает `Plane` и `Rocket`.
- `<FlightProgram><Program>…</Program></FlightProgram>` — встроенная программа
  Vizzy; делает конструкцию самодостаточной.
- `<InputController input="AG3*Throttle" inputId="Motor"/>` — привязка привода к
  органам управления. Атрибут `input` принимает выражения над `Pitch`, `Roll`,
  `Yaw`, `Throttle`, `Brake`, `Slider1..3`, `AG1..AG10`.

Полный список модификаторов и их значения по умолчанию — `part_lookup` по `id`.

### Модификаторы обязательны, умолчания не подставляются

Если тип детали объявляет модификатор, он **должен присутствовать в XML**.
Игра не достраивает его из определения типа.

Проверено на практике: командный модуль `CommandPod1` объявляет `<FuelTank>`
(капсула несёт бортовую батарею). Конструкция, где у него этого модификатора
нет, не открывается вовсе — построение топливной системы падает с
`NullReferenceException` в `CraftFuelSources.Rebuild`, а в интерфейсе видно
лишь то, что аппарат не грузится.

Исключение — `<Config>`: его полсотни служебных атрибутов игра заполняет сама,
и в сохранённых ею конструкциях он всегда краткий.

`craft_build` дописывает недостающие модификаторы автоматически.

## Соединения

```xml
<Connection partA="1" partB="0" attachPointsA="2,4" attachPointsB="1,5">
  <BodyJoint body="1" connectedBody="2" jointType="Normal" breakTorque="1E+07"
             position="0,3.95,0" axis="0,0,1"/>
</Connection>
```

`attachPointsA/B` — **списки индексов через запятую**. Стековая стыковка
связывает пару `load` (силовой стык, переток топлива) и пару `shell` (обшивка).
Для стыковки `partA` — нижняя деталь, `partB` — верхняя.

`<BodyJoint>` присутствует, **только когда соединение соединяет два разных
физических тела** — то есть на отделителях, шарнирах, поршнях. Жёсткие сварные
стыки его не имеют.

## Тела

```xml
<Bodies>
  <Body id="1" partIds="0,2,3" mass="114.0" position="0,-0.19,0" centerOfMass="0,0,0"/>
</Bodies>
```

Группирует детали в жёсткие тела. Границы проходят по отделителям и подвижным
соединениям. Игра пересчитывает массу и центр масс, но **само разбиение уважает**:
неверная группировка — вероятная причина разваливающегося аппарата.

## Темы и симметрия

`<DesignerSettings/>` и `<Themes/>` могут быть пустыми — игра подставит тему по
умолчанию. `<Symmetry/>` тоже необязателен; он нужен редактору для групповой
правки зеркальных деталей, на физику не влияет.

## Настройка для сверки

Игра по умолчанию минифицирует сохраняемый XML, выбрасывая значения по
умолчанию. Чтобы сравнить сгенерированную конструкцию с тем, что игра из неё
сделала, установите в `Settings.xml` атрибут `optimizeCraftXML="false"` у
элемента `<Designer>`. Текущее значение показывает `game_state`.
