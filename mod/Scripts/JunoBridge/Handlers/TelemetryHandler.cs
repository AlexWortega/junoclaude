using JunoBridge.Core;
using JunoBridge.Net;
using JunoBridge.Serialization;

namespace JunoBridge.Handlers
{
    internal static class TelemetryHandler
    {
        public static BridgeResponse GetFull()
        {
            var node = GameContext.PlayerCraftNode;
            if (node == null) return Errors.NotInFlight();
            return BridgeResponse.Ok(TelemetrySerializer.Full(node));
        }

        public static BridgeResponse GetLite()
        {
            var node = GameContext.PlayerCraftNode;
            if (node == null) return Errors.NotInFlight();
            return BridgeResponse.Ok(TelemetrySerializer.Lite(node));
        }
    }
}
