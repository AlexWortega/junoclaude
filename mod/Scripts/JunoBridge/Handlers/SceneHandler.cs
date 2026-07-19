using System;
using System.Linq;
using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;
using ModApi.Scenes.Parameters;

namespace JunoBridge.Handlers
{
    /// Смена сцены не ждётся синхронно: пока идёт загрузка, главный поток перестаёт
    /// прокачивать очередь, и любой ждущий HTTP-поток гарантированно упрётся в таймаут.
    /// Поэтому 202 + jobId, а завершение приходит по SceneTransitionCompleted.
    internal static class SceneHandler
    {
        private const int EnqueueTimeoutMs = 3000;

        public static BridgeResponse Load(BridgeRequest request)
        {
            JsonValue body;
            if (!JsonLite.TryParse(request.Body, out body) || body.Kind != JsonKind.Object)
                return Errors.BadBody("Expected a JSON object.");

            string scene = body.Has("scene") ? body["scene"].AsString() : null;
            if (string.IsNullOrEmpty(scene)) return Errors.BadBody("Field 'scene' is required.");

            var job = JobRegistry.Create("scene");

            var queued = MainThreadDispatcher.Invoke("/scene/load", () =>
            {
                var scenes = GameContext.Scenes;
                if (scenes == null) return BridgeResponse.Error(503, "scenes_unavailable", "Scene manager is not ready.");

                switch (scene)
                {
                    case "menu": scenes.LoadMenu(new MenuSceneLoadParameters()); break;
                    case "designer": scenes.LoadDesigner(); break;
                    case "planetstudio": scenes.LoadPlanetStudio(); break;
                    case "techtree": scenes.LoadTechTree(); break;
                    default:
                        return BridgeResponse.Error(400, "unknown_scene",
                            "Scene must be one of: menu, designer, planetstudio, techtree.");
                }

                job.State = JobState.Running;
                return BridgeResponse.Ok(JobRegistry.ToJson(job), 202);
            }, EnqueueTimeoutMs);

            if (queued.StatusCode != 202)
                JobRegistry.Complete(job, false, "Scene load was not accepted.");

            return queued;
        }

        public static BridgeResponse Launch(BridgeRequest request)
        {
            JsonValue body;
            if (!JsonLite.TryParse(request.Body, out body) || body.Kind != JsonKind.Object)
                return Errors.BadBody("Expected a JSON object.");

            bool fromDesigner = body.Has("fromDesigner") && body["fromDesigner"].AsBool();
            string craftId = body.Has("craftId") ? body["craftId"].AsString() : null;

            if (!fromDesigner && string.IsNullOrEmpty(craftId))
                return Errors.BadBody("Provide either 'craftId' or 'fromDesigner': true.");

            string locationName = body.Has("launchLocation") ? body["launchLocation"].AsString() : null;
            string nodeName = body.Has("craftNodeName") ? body["craftNodeName"].AsString() : craftId;
            long launchCost = body.Has("launchCost") ? (long)body["launchCost"].AsDouble(0.0) : 0L;

            var job = JobRegistry.Create("launch");

            var queued = MainThreadDispatcher.Invoke("/flight/launch", () =>
            {
                var game = GameContext.Game;
                if (game == null) return BridgeResponse.Error(503, "game_unavailable", "Game is not ready.");

                if (fromDesigner)
                {
                    if (!GameContext.InDesigner)
                        return BridgeResponse.Error(409, "wrong_scene", "'fromDesigner' requires the designer scene.");
                    game.Designer.BeginFlight();
                    job.State = JobState.Running;
                    return BridgeResponse.Ok(JobRegistry.ToJson(job), 202);
                }

                var state = game.GameState;
                if (state == null) return BridgeResponse.Error(503, "game_state_unavailable", "No active game state.");

                var location = state.SelectedLaunchLocation;
                if (!string.IsNullOrEmpty(locationName) && state.LaunchLocations != null)
                    location = state.LaunchLocations.FirstOrDefault(l => l != null && l.Name == locationName) ?? location;

                if (location == null)
                    return BridgeResponse.Error(400, "unknown_launch_location",
                        "No launch location named '" + locationName + "' and no selected default.");

                var parameters = FlightSceneLoadParameters.NewCraft(craftId, nodeName ?? craftId, location, launchCost);
                game.SceneManager.LoadFlight(parameters);

                job.State = JobState.Running;
                return BridgeResponse.Ok(JobRegistry.ToJson(job), 202);
            }, EnqueueTimeoutMs);

            if (queued.StatusCode != 202)
                JobRegistry.Complete(job, false, "Launch was not accepted.");

            return queued;
        }
    }
}
