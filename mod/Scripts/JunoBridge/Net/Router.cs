using System;
using JunoBridge.Core;
using JunoBridge.Handlers;
using JunoBridge.Json;

namespace JunoBridge.Net
{
    internal static class Router
    {
        private const int ReadTimeoutMs = 1500;
        private const int WriteTimeoutMs = 3000;
        private const int ScreenshotTimeoutMs = 5000;

        public static BridgeResponse Dispatch(BridgeRequest request)
        {
            if (Auth.LooksLikeBrowser(request))
                return BridgeResponse.Error(403, "origin_rejected",
                    "Requests carrying an Origin header are refused; the bridge is not a browser API.");

            if (!Auth.Verify(request))
                return BridgeResponse.Error(401, "unauthorized",
                    "Missing or invalid bearer token. Read it from " + Auth.TokenPath + ".");

            // Во время перехода сцен главный поток может молчать несколько секунд,
            // поэтому отбиваем здесь, на HTTP-потоке, не ставя работу в очередь.
            if (SceneGate.Transitioning && !IsAlwaysAvailable(request))
            {
                var busy = BridgeResponse.Error(503, "scene_transitioning", "A scene transition is in progress.");
                busy.RetryAfter = "1";
                return busy;
            }

            try
            {
                return Route(request);
            }
            catch (Exception ex)
            {
                EventLog.Record(EventKind.Exception, "router: " + ex);
                return BridgeResponse.Error(500, "router_exception", ex.GetType().Name + ": " + ex.Message);
            }
        }

        private static bool IsAlwaysAvailable(BridgeRequest request)
        {
            if (request.Segments.Length == 0) return true;
            switch (request.Segments[0])
            {
                case "status":
                case "events":
                case "jobs":
                    return true;
                default:
                    return false;
            }
        }

        private static BridgeResponse Route(BridgeRequest request)
        {
            var seg = request.Segments;
            string method = request.Method.ToUpperInvariant();

            if (seg.Length == 0)
                return BridgeResponse.Ok(new JsonWriter(96).BeginObject()
                    .Str("service", "JunoBridge").Str("version", JunoBridgeMod.ModVersion).EndObject().ToString());

            switch (seg[0])
            {
                case "status":
                    if (method != "GET") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/status", StatusHandler.Get, ReadTimeoutMs);

                case "events":
                    if (method != "GET") return MethodNotAllowed();
                    // Кольцевой буфер защищён своим замком и не трогает Unity — очередь не нужна.
                    return EventsHandler.Get(request);

                case "jobs":
                    if (method != "GET") return MethodNotAllowed();
                    if (seg.Length < 2) return NotFound(request);
                    return JobsHandler.Get(seg[1]);

                case "telemetry":
                    if (method != "GET") return MethodNotAllowed();
                    if (seg.Length >= 2 && seg[1] == "lite")
                        return MainThreadDispatcher.Invoke("/telemetry/lite", TelemetryHandler.GetLite, ReadTimeoutMs);
                    return MainThreadDispatcher.Invoke("/telemetry", TelemetryHandler.GetFull, ReadTimeoutMs);

                case "craft":
                    return RouteCraft(request, method, seg);

                case "parts":
                    if (method != "GET") return MethodNotAllowed();
                    if (seg.Length < 2) return NotFound(request);
                    return WithPartId(seg[1], id =>
                        MainThreadDispatcher.Invoke("/parts/{id}", () => CraftHandler.GetPart(id), ReadTimeoutMs));

                case "stages":
                    if (method != "GET") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/stages", CraftHandler.GetStages, ReadTimeoutMs);

                case "flight":
                    return RouteFlight(request, method, seg);

                case "scene":
                    if (method != "POST" || seg.Length < 2 || seg[1] != "load") return NotFound(request);
                    return SceneHandler.Load(request);

                case "vizzy":
                    if (seg.Length < 2) return NotFound(request);
                    return WithPartId(seg[1], id =>
                    {
                        if (method == "GET")
                            return MainThreadDispatcher.Invoke("/vizzy/{id}", () => VizzyHandler.Get(id), ReadTimeoutMs);
                        if (method == "PUT")
                            return MainThreadDispatcher.Invoke("/vizzy/{id}", () => VizzyHandler.Put(id, request), WriteTimeoutMs);
                        return MethodNotAllowed();
                    });

                case "screenshot":
                    if (method != "GET") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/screenshot",
                        () => ScreenshotHandler.Capture(request), ScreenshotTimeoutMs, true);

                case "planets":
                    if (method != "GET") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/planets", WorldHandler.GetPlanets, ReadTimeoutMs);

                case "launch-locations":
                    if (method != "GET") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/launch-locations", WorldHandler.GetLaunchLocations, ReadTimeoutMs);

                default:
                    return NotFound(request);
            }
        }

        private static BridgeResponse RouteCraft(BridgeRequest request, string method, string[] seg)
        {
            if (seg.Length == 1)
            {
                if (method != "GET") return MethodNotAllowed();
                return MainThreadDispatcher.Invoke("/craft", CraftHandler.GetActive, ReadTimeoutMs);
            }

            switch (seg[1])
            {
                case "all":
                    if (method != "GET") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/craft/all", CraftHandler.GetAll, ReadTimeoutMs);

                case "parts":
                    if (method != "GET") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/craft/parts", CraftHandler.GetParts, ReadTimeoutMs);

                case "list":
                    if (method != "GET") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/craft/list", CraftFileHandler.List, ReadTimeoutMs);

                case "save":
                    if (method != "POST") return MethodNotAllowed();
                    return MainThreadDispatcher.Invoke("/craft/save", () => CraftFileHandler.Save(request), WriteTimeoutMs);

                default:
                    return NotFound(request);
            }
        }

        private static BridgeResponse RouteFlight(BridgeRequest request, string method, string[] seg)
        {
            if (seg.Length < 2 || method != "POST") return NotFound(request);

            switch (seg[1])
            {
                case "input":
                    return MainThreadDispatcher.Invoke("/flight/input",
                        () => FlightControlHandler.SetInput(request), WriteTimeoutMs);

                case "stage":
                    return MainThreadDispatcher.Invoke("/flight/stage",
                        FlightControlHandler.ActivateStage, WriteTimeoutMs);

                case "activation-group":
                    return MainThreadDispatcher.Invoke("/flight/activation-group",
                        () => FlightControlHandler.SetActivationGroup(request), WriteTimeoutMs);

                case "timewarp":
                    return MainThreadDispatcher.Invoke("/flight/timewarp",
                        () => FlightControlHandler.SetTimeWarp(request), WriteTimeoutMs);

                case "launch":
                    return SceneHandler.Launch(request);

                default:
                    return NotFound(request);
            }
        }

        private static BridgeResponse WithPartId(string raw, Func<int, BridgeResponse> action)
        {
            int partId;
            if (!int.TryParse(raw, System.Globalization.NumberStyles.Integer,
                              System.Globalization.CultureInfo.InvariantCulture, out partId))
                return BridgeResponse.Error(400, "invalid_part_id", "Part id '" + raw + "' is not an integer.");
            return action(partId);
        }

        private static BridgeResponse MethodNotAllowed()
        {
            return BridgeResponse.Error(405, "method_not_allowed", "This path does not accept that HTTP method.");
        }

        private static BridgeResponse NotFound(BridgeRequest request)
        {
            return BridgeResponse.Error(404, "unknown_route", "No handler for " + request.Method + " " + request.Path + ".");
        }
    }
}
