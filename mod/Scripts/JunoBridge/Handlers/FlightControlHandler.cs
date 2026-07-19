using System.Collections.Generic;
using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;

namespace JunoBridge.Handlers
{
    internal static class FlightControlHandler
    {
        private static readonly string[] Axes =
        {
            "throttle", "pitch", "yaw", "roll", "brake",
            "translateForward", "translateRight", "translateUp",
            "slider1", "slider2", "slider3", "slider4"
        };

        public static BridgeResponse SetInput(BridgeRequest request)
        {
            var node = GameContext.PlayerCraftNode;
            if (node == null) return Errors.NotInFlight();

            var controls = node.Controls;
            if (controls == null) return Errors.NoCommandPod();

            JsonValue body;
            if (!JsonLite.TryParse(request.Body, out body) || body.Kind != JsonKind.Object)
                return Errors.BadBody("Expected a JSON object.");

            // TODO(verify): CraftControls.TargetHeading is a Quaterniond?, not an angle.
            // The docs gave no way to build a correct quaternion from a heading (in which
            // frame of reference, against which reference vector), so the axis is disabled
            // outright: silently writing a "plausible" quaternion would steer the craft blindly.
            if (body.Has("targetHeading"))
                return BridgeResponse.Error(501, "not_supported",
                    "targetHeading is not supported: the game exposes it as an orientation quaternion, not a scalar heading.");

            string mode = body.Has("mode") ? body["mode"].AsString("set") : "set";

            if (mode == "clear")
            {
                ControlOverrides.ReleaseAll();
                return BridgeResponse.Ok(Applied(new List<string>(), mode));
            }

            double pulseSeconds = body.Has("pulseMs") ? body["pulseMs"].AsDouble(250.0) / 1000.0 : 0.25;
            var applied = new List<string>();

            for (int i = 0; i < Axes.Length; i++)
            {
                string name = Axes[i];
                if (!body.Has(name)) continue;

                ControlAxis axis;
                if (!ControlOverrides.TryParseAxis(name, out axis)) continue;

                var value = body[name];
                if (value.IsNull)
                {
                    ControlOverrides.Release(axis);
                    continue;
                }

                float scalar = (float)value.AsDouble(0.0);
                ControlOverrides.Write(controls, axis, scalar);

                if (mode == "hold") ControlOverrides.Hold(axis, scalar);
                else if (mode == "pulse") ControlOverrides.Pulse(axis, scalar, pulseSeconds);

                applied.Add(name);
            }

            var groups = body["activationGroups"];
            if (groups != null && groups.Kind == JsonKind.Object)
                foreach (var pair in groups.Members)
                {
                    int group;
                    if (!int.TryParse(pair.Key, System.Globalization.NumberStyles.Integer,
                                      System.Globalization.CultureInfo.InvariantCulture, out group))
                        continue;
                    controls.SetActivationGroup(group, pair.Value.AsBool());
                    applied.Add("activationGroup" + group);
                }

            return BridgeResponse.Ok(Applied(applied, mode));
        }

        public static BridgeResponse ActivateStage()
        {
            var pod = GameContext.ActiveCommandPod;
            if (pod == null)
                return GameContext.InFlight ? Errors.NoCommandPod() : Errors.NotInFlight();

            int before = pod.CurrentStage;
            pod.ActivateStage();

            var w = new JsonWriter(128);
            w.BeginObject()
             .Num("stageBefore", before)
             .Num("currentStage", pod.CurrentStage)
             .Num("numStages", pod.NumStages)
             .EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse SetActivationGroup(BridgeRequest request)
        {
            var node = GameContext.PlayerCraftNode;
            if (node == null) return Errors.NotInFlight();

            var controls = node.Controls;
            if (controls == null) return Errors.NoCommandPod();

            JsonValue body;
            if (!JsonLite.TryParse(request.Body, out body) || body.Kind != JsonKind.Object)
                return Errors.BadBody("Expected a JSON object.");

            if (!body.Has("group")) return Errors.BadBody("Field 'group' is required.");
            int group = body["group"].AsInt(-1);
            if (group < 1) return Errors.BadBody("Field 'group' must be a positive integer.");

            bool toggle = body.Has("toggle") && body["toggle"].AsBool();
            if (toggle) controls.ToggleActivationGroup(group);
            else controls.SetActivationGroup(group, body.Has("state") && body["state"].AsBool());

            var w = new JsonWriter(96);
            w.BeginObject()
             .Num("group", group)
             .Bool("state", controls.GetActivationGroup(group))
             .EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse SetTimeWarp(BridgeRequest request)
        {
            var flight = GameContext.Flight;
            if (flight == null || flight.TimeManager == null) return Errors.NotInFlight();
            var time = flight.TimeManager;

            JsonValue body;
            if (!JsonLite.TryParse(request.Body, out body) || body.Kind != JsonKind.Object)
                return Errors.BadBody("Expected a JSON object.");

            if (body.Has("paused"))
                time.RequestPauseChange(body["paused"].AsBool(), false);

            if (body.Has("modeIndex"))
            {
                int index = body["modeIndex"].AsInt(0);
                string reason;
                if (!time.CanSetTimeMultiplierMode(index, out reason))
                    return BridgeResponse.Error(409, "timewarp_refused", reason ?? "Time warp mode is not available.");
                time.SetMode(index, false);
            }
            else if (body.Has("delta"))
            {
                int delta = body["delta"].AsInt(0);
                for (int i = 0; i < System.Math.Abs(delta); i++)
                {
                    if (delta > 0) time.IncreaseTimeMultiplier();
                    else time.DecreaseTimeMultiplier();
                }
            }

            var w = new JsonWriter(160);
            w.BeginObject()
             .Num("modeIndex", time.ModeIndex)
             .Num("timeMultiplier", time.CurrentMode == null ? 1.0 : time.CurrentMode.TimeMultiplier)
             .Str("modeName", time.CurrentMode == null ? null : time.CurrentMode.Name)
             .Bool("paused", time.Paused)
             .EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        private static string Applied(List<string> applied, string mode)
        {
            var w = new JsonWriter(256);
            w.BeginObject().Str("mode", mode).BeginArray("applied");
            for (int i = 0; i < applied.Count; i++) w.Str(applied[i]);
            w.EndArray();

            w.BeginArray("overridesHeld");
            var held = ControlOverrides.HeldAxes();
            for (int i = 0; i < held.Count; i++) w.Str(ControlOverrides.Name(held[i]));
            w.EndArray();

            w.EndObject();
            return w.ToString();
        }
    }
}
