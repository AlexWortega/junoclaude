using System;
using System.Collections;
using JunoBridge.Net;
using ModApi;
using ModApi.GameLoop;
using ModApi.GameLoop.Interfaces;
using UnityEngine;

namespace JunoBridge.Core
{
    /// Прокачка очереди зарегистрирована и в игровых циклах, и в собственном Update
    /// объекта DontDestroyOnLoad — иначе /status и /events молчали бы в меню и на переходах.
    /// Игровые хуки нужны отдельно ради порядка относительно физики: удержание тяги
    /// должно попасть в CraftControls до ближайшего FixedUpdate.
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

        /// Регистрация в цикле активной сцены. Вызывать после каждой смены сцены:
        /// у полёта и конструктора собственные реестры.
        public static void RegisterWithSceneLoops()
        {
            if (_instance == null) return;

            try
            {
                var game = Game.Instance;
                if (game == null || game.SceneManager == null) return;

                // TODO(проверить): типы IFlightScene.GameLoop / IDesigner.GameLoop в XML-доках
                // не раскрыты; предполагается IFlightGameLoop / IDesignerGameLoop с Register().
                if (game.SceneManager.InFlightScene && game.FlightScene != null)
                    game.FlightScene.GameLoop.Register(_instance);

                if (game.SceneManager.InDesignerScene && game.Designer != null)
                    game.Designer.GameLoop.Register(_instance);
            }
            catch (Exception ex)
            {
                // Update() продолжит работать в любом случае — теряется лишь точный порядок.
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
            // LateUpdate у DontDestroyOnLoad-объекта выполняется всегда, поэтому флаг не залипнет.
            _pumpedThisFrame = false;
        }

        private void OnApplicationQuit()
        {
            try { BridgeServer.Instance.Stop(); }
            catch (Exception) { }
            MainThreadDispatcher.Drain();
        }

        public void FlightUpdate(ref FlightFrameData frame)
        {
            PumpOnce();
        }

        public void FlightUpdatePaused(ref FlightFrameData frame)
        {
            PumpOnce();
        }

        public void FlightPreFixedUpdate(ref FlightFrameData frame)
        {
            try { ControlOverrides.Apply(); }
            catch (Exception ex) { EventLog.Record(EventKind.Exception, "ControlOverrides.Apply: " + ex); }
        }

        public void DesignerUpdate(ref DesignerFrameData frame)
        {
            PumpOnce();
        }

        /// Отдельная очередь: захват кадра на Metal даёт чёрную или рваную картинку,
        /// если снимать его не после отрисовки.
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
