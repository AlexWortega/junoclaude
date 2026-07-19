using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;

namespace JunoBridge.Handlers
{
    internal static class Errors
    {
        public static BridgeResponse NotInFlight()
        {
            return BridgeResponse.Error(409, "wrong_scene", "This endpoint requires the flight scene.",
                new JsonWriter(64).BeginObject().Str("scene", GameContext.SceneName).EndObject().ToString());
        }

        public static BridgeResponse NoCraft()
        {
            return BridgeResponse.Error(409, "no_craft", "There is no active craft.",
                new JsonWriter(64).BeginObject().Str("scene", GameContext.SceneName).EndObject().ToString());
        }

        public static BridgeResponse NoCommandPod()
        {
            return BridgeResponse.Error(409, "no_command_pod", "The active craft has no command pod to command.");
        }

        public static BridgeResponse BadBody(string message)
        {
            return BridgeResponse.Error(400, "invalid_body", message);
        }

        public static BridgeResponse UnknownPart(int partId)
        {
            return BridgeResponse.Error(404, "unknown_part", "No part with id " + partId + " on the active craft.");
        }
    }
}
