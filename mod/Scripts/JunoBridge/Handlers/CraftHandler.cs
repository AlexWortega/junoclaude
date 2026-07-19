using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;
using JunoBridge.Serialization;

namespace JunoBridge.Handlers
{
    internal static class CraftHandler
    {
        public static BridgeResponse GetActive()
        {
            var craft = GameContext.PlayerCraftScript;
            if (craft == null) return Errors.NoCraft();

            var node = craft.CraftNode;
            var data = craft.Data;
            var pod = craft.ActiveCommandPod ?? craft.PrimaryCommandPod;

            var w = new JsonWriter(768);
            w.BeginObject()
             .Str("name", data == null ? null : data.Name)
             .Num("nodeId", node == null ? -1 : node.NodeId)
             .Num("price", data == null ? 0.0 : data.Price)
             .Num("mass", craft.Mass)
             .Num("partCount", CountParts(data))
             .Num("currentStage", pod == null ? -1 : pod.CurrentStage)
             .Num("numStages", pod == null ? 0 : pod.NumStages)
             // CenterOfMass — Transform, ориентированный по пилотской оси командного модуля.
             .Vec("centerOfMass", craft.CenterOfMass.position)
             .EndObject();

            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse GetAll()
        {
            var flight = GameContext.Flight;
            if (flight == null || flight.FlightState == null) return Errors.NotInFlight();

            var w = new JsonWriter(2048);
            w.BeginObject().BeginArray("craftNodes");

            foreach (var node in flight.FlightState.CraftNodes)
            {
                if (node == null) continue;
                CraftSerializer.WriteNodeSummary(w, node);
            }

            w.EndArray().EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse GetParts()
        {
            var craft = GameContext.PlayerCraftScript;
            if (craft == null || craft.Data == null || craft.Data.Assembly == null) return Errors.NoCraft();

            var w = new JsonWriter(8192);
            w.BeginObject().BeginArray("parts");

            foreach (var part in craft.Data.Assembly.Parts)
            {
                if (part == null) continue;
                CraftSerializer.WritePart(w, part, false);
            }

            w.EndArray().EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse GetPart(int partId)
        {
            var part = GameContext.FindPart(partId);
            if (part == null) return Errors.UnknownPart(partId);

            var w = new JsonWriter(1024);
            w.BeginObject().Raw("part", PartJson(part)).EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse GetStages()
        {
            var craft = GameContext.PlayerCraftScript;
            if (craft == null || craft.Data == null || craft.Data.Assembly == null) return Errors.NoCraft();

            var pod = craft.ActiveCommandPod ?? craft.PrimaryCommandPod;

            var w = new JsonWriter(2048);
            w.BeginObject()
             .Num("currentStage", pod == null ? -1 : pod.CurrentStage)
             .Num("numStages", pod == null ? 0 : pod.NumStages)
             .BeginArray("parts");

            foreach (var part in craft.Data.Assembly.Parts)
            {
                if (part == null) continue;
                w.BeginObject()
                 .Num("partId", part.Id)
                 .Str("name", part.Name)
                 .Num("activationStage", part.ActivationStage)
                 .Num("activationGroup", part.ActivationGroup)
                 .Bool("activated", part.Activated)
                 .EndObject();
            }

            w.EndArray().EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        /// Тип коллекции Parts в документации не раскрыт — считаем через IEnumerable,
        /// чтобы не зависеть от наличия Count.
        private static int CountParts(ModApi.Craft.CraftData data)
        {
            if (data == null || data.Assembly == null || data.Assembly.Parts == null) return 0;
            int count = 0;
            foreach (var part in data.Assembly.Parts) { if (part != null) count++; }
            return count;
        }

        private static string PartJson(ModApi.Craft.Parts.PartData part)
        {
            var w = new JsonWriter(1024);
            CraftSerializer.WritePart(w, part, true);
            return w.ToString();
        }
    }
}
