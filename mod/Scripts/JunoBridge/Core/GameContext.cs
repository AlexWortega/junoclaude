using System;
using ModApi;
using ModApi.Craft;
using ModApi.Craft.Parts;
using ModApi.Flight;
using ModApi.Scenes;

namespace JunoBridge.Core
{
    /// Single access point to the game objects. Main thread only.
    internal static class GameContext
    {
        /// ModApi.Game is internal: it is mirrored in the Common namespace specifically for
        /// mods ("Modders and other code must use 'Common' namespace" — the type's doc).
        /// The single entry point to IGame in the whole bridge.
        public static IGame Game
        {
            get { return ModApi.Common.Game.Instance; }
        }

        public static ISceneManager Scenes
        {
            get { var g = Game; return g == null ? null : g.SceneManager; }
        }

        public static bool InFlight
        {
            get { var s = Scenes; return s != null && s.InFlightScene; }
        }

        public static bool InDesigner
        {
            get { var s = Scenes; return s != null && s.InDesignerScene; }
        }

        public static IFlightScene Flight
        {
            get { return InFlight ? Game.FlightScene : null; }
        }

        public static ICraftNode PlayerCraftNode
        {
            get { var f = Flight; return f == null ? null : f.CraftNode; }
        }

        public static ICraftScript PlayerCraftScript
        {
            get
            {
                var node = PlayerCraftNode;
                if (node != null && node.CraftScript != null) return node.CraftScript;
                var designer = InDesigner ? Game.Designer : null;
                return designer == null ? null : designer.CraftScript;
            }
        }

        public static ICommandPod ActiveCommandPod
        {
            get
            {
                var craft = PlayerCraftScript;
                if (craft == null) return null;
                return craft.ActiveCommandPod ?? craft.PrimaryCommandPod;
            }
        }

        public static string SceneName
        {
            get
            {
                if (SceneGate.Transitioning) return "transitioning";
                var s = Scenes;
                if (s == null) return "unknown";
                if (s.InFlightScene) return "flight";
                if (s.InDesignerScene) return "designer";
                if (s.InMenuScene) return "menu";
                if (s.InPlanetStudioScene) return "planetstudio";
                if (s.InTechTreeScene) return "techtree";
                return s.CurrentScene ?? "unknown";
            }
        }

        public static bool Paused
        {
            get
            {
                var f = Flight;
                return f != null && f.TimeManager != null && f.TimeManager.Paused;
            }
        }

        public static double TimeMultiplier
        {
            get
            {
                var f = Flight;
                if (f == null || f.TimeManager == null || f.TimeManager.CurrentMode == null) return 1.0;
                return f.TimeManager.CurrentMode.TimeMultiplier;
            }
        }

        /// Resolves a part by its PartData.Id in the active craft (flight or designer).
        public static PartData FindPart(int partId)
        {
            var craft = PlayerCraftScript;
            if (craft == null || craft.Data == null || craft.Data.Assembly == null) return null;
            return craft.Data.Assembly.GetPartById(partId);
        }
    }
}
