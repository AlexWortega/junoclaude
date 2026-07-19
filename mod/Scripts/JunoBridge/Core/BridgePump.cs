using System;
using System.Collections;
using JunoBridge.Net;
using ModApi;
using ModApi.GameLoop;
using ModApi.GameLoop.Interfaces;
using UnityEngine;

namespace JunoBridge.Core
{
    /// The queue pump is registered both in the game loops and in the Update of a
    /// DontDestroyOnLoad object — otherwise /status and /events would go silent in the menu
    /// and during scene transitions. The game hooks are needed separately for ordering
    /// relative to physics: a throttle hold must reach CraftControls before the next
    /// FixedUpdate.
    internal sealed class BridgePump : MonoBehaviour,
        IGameLoopItem,
        IFlightUpdate,
        IFlightUpdatePaused,
        IFlightPreFixedUpdate,
        IDesignerUpdate
    {
        private static BridgePump _instance;
        private static bool _pumpedThisFrame;

        public bool StartMethodCalled { get; set; }

        public static void EnsureExists()
        {
            if (_instance != null) return;

            var go = new GameObject("JunoBridgePump");
            UnityEngine.Object.DontDestroyOnLoad(go);
            _instance = go.AddComponent<BridgePump>();
        }

        /// Registers with the active scene's loop. Call after every scene change:
        /// flight and designer have their own registries.
        public static void RegisterWithSceneLoops()
        {
            if (_instance == null) return;

            try
            {
                var game = GameContext.Game;
                if (game == null || game.SceneManager == null) return;

                // TODO(verify): the types of IFlightScene.GameLoop / IDesigner.GameLoop are not
                // spelled out in the XML docs; assumed to be IFlightGameLoop / IDesignerGameLoop
                // with Register().
                if (game.SceneManager.InFlightScene && game.FlightScene != null)
                    game.FlightScene.GameLoop.Register(_instance);

                if (game.SceneManager.InDesignerScene && game.Designer != null)
                    game.Designer.GameLoop.Register(_instance);
            }
            catch (Exception ex)
            {
                // Update() keeps working either way — only the exact ordering is lost.
                EventLog.Record(EventKind.Exception, "RegisterWithSceneLoops failed: " + ex);
            }
        }

        private void Awake()
        {
            StartCoroutine(EndOfFramePump());
        }

        private void Update()
        {
            Clock.Tick();
            PumpOnce();
        }

        private void LateUpdate()
        {
            // LateUpdate on a DontDestroyOnLoad object always runs, so the flag cannot get stuck.
            _pumpedThisFrame = false;
        }

        private void OnApplicationQuit()
        {
            try { BridgeServer.Instance.Stop(); }
            catch (Exception) { }
            MainThreadDispatcher.Drain();
        }

        public void FlightUpdate(in FlightFrameData frame)
        {
            PumpOnce();
        }

        public void FlightUpdatePaused(in FlightFrameData frame)
        {
            PumpOnce();
        }

        public void FlightPreFixedUpdate(in FlightFrameData frame)
        {
            try { ControlOverrides.Apply(); }
            catch (Exception ex) { EventLog.Record(EventKind.Exception, "ControlOverrides.Apply: " + ex); }
        }

        public void DesignerUpdate(in DesignerFrameData frame)
        {
            PumpOnce();
        }

        /// A separate queue: frame capture on Metal yields a black or torn image if taken
        /// anywhere other than after rendering.
        private IEnumerator EndOfFramePump()
        {
            var wait = new WaitForEndOfFrame();
            while (true)
            {
                yield return wait;
                try { MainThreadDispatcher.PumpEndOfFrame(); }
                catch (Exception ex) { EventLog.Record(EventKind.Exception, "EndOfFramePump: " + ex); }
            }
        }

        private static void PumpOnce()
        {
            if (_pumpedThisFrame) return;
            _pumpedThisFrame = true;
            MainThreadDispatcher.Pump();
        }
    }
}
