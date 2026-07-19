using System;
using JunoBridge.Core;
using JunoBridge.Net;
using ModApi.Mods;

namespace JunoBridge
{
    public class JunoBridgeMod : GameMod
    {
        public const int ApiVersion = 1;
        public const string ModVersion = "0.1.0";

        private static JunoBridgeMod _instance;

        private JunoBridgeMod()
        {
        }

        public static JunoBridgeMod Instance
        {
            get { return _instance = _instance ?? GetModInstance<JunoBridgeMod>(); }
        }

        protected override void OnModInitialized()
        {
            base.OnModInitialized();

            try
            {
                BridgePump.EnsureExists();
                EventSubscriptions.AttachGlobal();
                BridgeServer.Instance.Start();
                EventLog.Record(EventKind.Log, "JunoBridge " + ModVersion + " initialized.");
            }
            catch (Exception ex)
            {
                // Мод не должен ронять загрузку игры: логируем и остаёмся неактивными.
                EventLog.Record(EventKind.Exception, "OnModInitialized failed: " + ex);
                UnityEngine.Debug.LogError("[JunoBridge] OnModInitialized failed: " + ex);
            }
        }

        protected override void OnModLoaded()
        {
            base.OnModLoaded();
        }
    }
}
