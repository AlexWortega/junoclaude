using System;
using System.Xml.Linq;
using JunoBridge.Json;
using JunoBridge.Net;

namespace JunoBridge.Handlers
{
    /// Работа с сохранёнными чертежами. craftId здесь — идентификатор дизайна
    /// (он же основа имени файла в UserData/CraftDesigns), именно его ждёт
    /// FlightSceneLoadParameters.NewCraft.
    internal static class CraftFileHandler
    {
        public static BridgeResponse List()
        {
            var designs = Designs();
            if (designs == null) return Unavailable();

            var w = new JsonWriter(2048);
            w.BeginObject().BeginArray("craftIds");

            foreach (var id in designs.GetCraftDesignIds(true))
                w.Str(id);

            w.EndArray()
             .Str("rootFolder", designs.RootFolderPath)
             .EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse Save(BridgeRequest request)
        {
            var designs = Designs();
            if (designs == null) return Unavailable();

            JsonValue body;
            if (!JsonLite.TryParse(request.Body, out body) || body.Kind != JsonKind.Object)
                return Errors.BadBody("Expected a JSON object.");

            string craftId = body.Has("craftId") ? body["craftId"].AsString() : null;
            if (string.IsNullOrEmpty(craftId) && body.Has("name")) craftId = body["name"].AsString();
            if (string.IsNullOrEmpty(craftId)) return Errors.BadBody("Field 'craftId' (or 'name') is required.");

            string xmlText = body.Has("xml") ? body["xml"].AsString() : null;
            if (string.IsNullOrEmpty(xmlText)) return Errors.BadBody("Field 'xml' is required.");

            XElement element;
            try
            {
                element = XElement.Parse(xmlText);
            }
            catch (Exception ex)
            {
                return BridgeResponse.Error(400, "invalid_xml", ex.Message);
            }

            designs.SaveCraft(craftId, element);

            var w = new JsonWriter(256);
            w.BeginObject()
             .Str("craftId", craftId)
             .Str("file", designs.GetCraftFile(craftId))
             .EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        private static Assets.Scripts.CraftDesigns Designs()
        {
            var game = Assets.Scripts.Game.Instance;
            return game == null ? null : game.CraftDesigns;
        }

        private static BridgeResponse Unavailable()
        {
            return BridgeResponse.Error(503, "craft_designs_unavailable", "The craft design store is not available yet.");
        }
    }
}
