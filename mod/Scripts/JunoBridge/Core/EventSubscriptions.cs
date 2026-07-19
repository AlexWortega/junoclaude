using System;
using JunoBridge.Json;
using ModApi;
using ModApi.Craft;
using ModApi.Craft.Parts;
using ModApi.Flight.Sim;
using ModApi.Flight.UI;
using ModApi.Scenes.Events;
using UnityEngine;

namespace JunoBridge.Core
{
    internal static class EventSubscriptions
    {
        private static bool _globalAttached;
        private static bool _flightAttached;

        private static ICraftScript _craftScript;
        private static ICommandPod _commandPod;
        private static IFlightLog _flightLog;

        public static void AttachGlobal()
        {
            if (_globalAttached) return;
            _globalAttached = true;

            Application.logMessageReceived += OnUnityLog;

            var scenes = GameContext.Scenes;
            if (scenes == null) return;

            scenes.SceneLoading += OnSceneLoading;
            scenes.SceneLoaded += OnSceneLoaded;
            scenes.SceneTransitionCompleted += OnSceneTransitionCompleted;
        }

        public static void DetachGlobal()
        {
            if (!_globalAttached) return;
            _globalAttached = false;

            Application.logMessageReceived -= OnUnityLog;

            var scenes = GameContext.Scenes;
            if (scenes == null) return;

            scenes.SceneLoading -= OnSceneLoading;
            scenes.SceneLoaded -= OnSceneLoaded;
            scenes.SceneTransitionCompleted -= OnSceneTransitionCompleted;
        }

        private static void OnSceneLoading(object sender, SceneEventArgs e)
        {
            SceneGate.Enter();
        }

        private static void OnSceneLoaded(object sender, SceneEventArgs e)
        {
            EventLog.Record(EventKind.SceneLoaded, "Scene loaded: " + e.Scene,
                new JsonWriter(64).BeginObject().Str("scene", e.Scene).EndObject().ToString());
        }

        private static void OnSceneTransitionCompleted(object sender, SceneTransitionEventArgs e)
        {
            SceneGate.Exit();
            DetachFlight();
            BridgePump.RegisterWithSceneLoops();
            AttachFlight();
            JobRegistry.CompleteAllOfKind("scene", true, "Scene transition completed.");
            JobRegistry.CompleteAllOfKind("launch", true, "Flight scene loaded.");
        }

        public static void AttachFlight()
        {
            if (_flightAttached) return;

            var flight = GameContext.Flight;
            if (flight == null) return;

            _flightAttached = true;

            flight.PlayerChangedSoi += OnPlayerChangedSoi;
            flight.CraftChanged += OnCraftChanged;

            if (flight.FlightSceneUI != null)
            {
                _flightLog = flight.FlightSceneUI.FlightLog;
                if (_flightLog != null) _flightLog.LogEntryAdded += OnFlightLogEntryAdded;
            }

            HookCraft();
        }

        public static void DetachFlight()
        {
            if (!_flightAttached) return;
            _flightAttached = false;

            var flight = GameContext.Flight;
            if (flight != null)
            {
                flight.PlayerChangedSoi -= OnPlayerChangedSoi;
                flight.CraftChanged -= OnCraftChanged;
            }

            if (_flightLog != null)
            {
                _flightLog.LogEntryAdded -= OnFlightLogEntryAdded;
                _flightLog = null;
            }

            UnhookCraft();
            ControlOverrides.ReleaseAll();
        }

        private static void HookCraft()
        {
            UnhookCraft();

            _craftScript = GameContext.PlayerCraftScript;
            if (_craftScript != null)
            {
                _craftScript.PartExploded += OnPartExploded;
                _craftScript.CraftStructureChanged += OnCraftStructureChanged;
            }

            _commandPod = GameContext.ActiveCommandPod;
            if (_commandPod != null) _commandPod.StageActivated += OnStageActivated;

            ForceVizzyConsoleOutput();
        }

        private static void UnhookCraft()
        {
            if (_craftScript != null)
            {
                _craftScript.PartExploded -= OnPartExploded;
                _craftScript.CraftStructureChanged -= OnCraftStructureChanged;
                _craftScript = null;
            }
            if (_commandPod != null)
            {
                _commandPod.StageActivated -= OnStageActivated;
                _commandPod = null;
            }
        }

        /// Основной канал вывода Vizzy — записи FlightLog категории Vizzy. Дублирование
        /// в дев-консоль включается как запасной путь, если категория окажется пустой.
        private static void ForceVizzyConsoleOutput()
        {
            try
            {
                var craft = GameContext.PlayerCraftScript;
                if (craft == null || craft.Data == null || craft.Data.Assembly == null) return;

                foreach (var part in craft.Data.Assembly.Parts)
                {
                    var program = part.GetModifier<Assets.Scripts.Craft.Parts.Modifiers.FlightProgramData>();
                    if (program != null) program.OutputToDevConsole = true;
                }
            }
            catch (Exception ex)
            {
                EventLog.Record(EventKind.Exception, "ForceVizzyConsoleOutput: " + ex);
            }
        }

        private static void OnPlayerChangedSoi(ICraftNode craftNode, IPlanetNode planet)
        {
            string planetName = planet == null ? null : planet.Name;
            EventLog.Record(EventKind.SoiChange, "Entered sphere of influence: " + (planetName ?? "?"),
                new JsonWriter(96).BeginObject().Str("planet", planetName).EndObject().ToString());
        }

        private static void OnCraftChanged(ICraftNode craftNode)
        {
            HookCraft();
            EventLog.Record(EventKind.CraftChanged, "Active craft changed.",
                new JsonWriter(96).BeginObject()
                    .Num("nodeId", craftNode == null ? -1 : craftNode.NodeId)
                    .EndObject().ToString());
        }

        /// ICraftScript.CraftStructureChanged — это SimpleNotificationDelegate, без аргументов:
        /// изменившийся корабль всегда текущий.
        private static void OnCraftStructureChanged()
        {
            EventLog.Record(EventKind.CraftStructureChanged, "Craft structure changed.");
        }

        private static void OnPartExploded(PartData part)
        {
            EventLog.Record(EventKind.Explosion, "Part exploded: " + (part == null ? "?" : part.Name),
                new JsonWriter(96).BeginObject()
                    .Num("partId", part == null ? -1 : part.Id)
                    .Str("partName", part == null ? null : part.Name)
                    .EndObject().ToString());
        }

        private static void OnStageActivated(ICommandPod source, int stage)
        {
            EventLog.Record(EventKind.Staging, "Stage " + stage + " activated.",
                new JsonWriter(64).BeginObject().Num("stage", stage).EndObject().ToString());
        }

        private static void OnFlightLogEntryAdded(FlightLogEntry entry)
        {
            if (entry == null) return;

            EventKind kind;
            switch (entry.Category)
            {
                case FlightLogEntryCategory.CraftDamage: kind = EventKind.PartDamage; break;
                case FlightLogEntryCategory.Vizzy: kind = EventKind.VizzyMessage; break;
                default: kind = EventKind.Log; break;
            }

            EventLog.Record(kind, entry.Text,
                new JsonWriter(160).BeginObject()
                    .Str("category", entry.Category.ToString())
                    .Num("logId", entry.Id)
                    .EndObject().ToString());
        }

        private static void OnUnityLog(string condition, string stackTrace, LogType type)
        {
            if (type == LogType.Exception || type == LogType.Error)
            {
                EventLog.Record(EventKind.Exception, condition);
                return;
            }

            // Дев-консольный вывод Vizzy приходит сюда же обычным Debug.Log.
            // TODO(проверить): формат префикса выяснить эмпирически; пока помечаем
            // как обычный лог, чтобы не выдавать посторонние строки за вывод программы.
        }
    }
}
