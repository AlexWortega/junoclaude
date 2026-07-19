using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;

namespace JunoBridge.Handlers
{
    internal static class StatusHandler
    {
        private static readonly string[] Capabilities =
        {
            "telemetry", "telemetry.lite", "events", "input", "input.hold", "staging",
            "activation-groups", "timewarp", "craft.read", "craft.parts", "craft.save",
            "craft.list", "craft.launch", "scene.load", "vizzy.read", "vizzy.write",
            "screenshot", "planets", "launch-locations", "jobs"
        };

        /// The one endpoint that must always answer: the MCP server uses it to tell
        /// "bridge alive, but wrong scene" from "bridge dead".
        public static BridgeResponse Get()
        {
            var game = GameContext.Game;
            var node = GameContext.PlayerCraftNode;

            var w = new JsonWriter(1024);
            w.BeginObject()
             .BeginObject("mod")
                 .Str("name", "JunoBridge")
                 .Str("version", JunoBridgeMod.ModVersion)
             .EndObject()
             .BeginObject("game")
                 .Str("version", game == null || game.Version == null ? null : game.Version.ToString())
                 .Str("unity", UnityEngine.Application.unityVersion)
             .EndObject()
             .Str("scene", GameContext.SceneName)
             .Bool("transitioning", SceneGate.Transitioning)
             .Bool("paused", GameContext.Paused)
             .Num("timeMultiplier", GameContext.TimeMultiplier)
             .Bool("hasCraft", node != null)
             .Num("craftNodeId", node == null ? -1 : node.NodeId)
             .Bool("supportsCodeExecution", game != null && game.ModManager != null && game.ModManager.SupportsCodeExecution)
             // A cheap change detector: the MCP server polls /status and only goes to
             // /events when the counter has moved.
             .Num("eventSeq", EventLog.LatestSeq)
             .Num("pendingJobs", MainThreadDispatcher.PendingCount);

            w.BeginArray("capabilities");
            for (int i = 0; i < Capabilities.Length; i++)
                w.Str(Capabilities[i]);
            w.EndArray();

            w.EndObject();
            return BridgeResponse.Ok(w.ToString());
        }
    }
}
