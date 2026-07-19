using System.Text;
using JunoBridge.Core;
using JunoBridge.Json;

namespace JunoBridge.Net
{
    internal sealed class BridgeResponse
    {
        public int StatusCode = 200;
        public string ContentType = "application/json; charset=utf-8";
        public byte[] Body = new byte[0];
        public string RetryAfter;

        public static BridgeResponse Json(string json, int statusCode = 200)
        {
            return new BridgeResponse
            {
                StatusCode = statusCode,
                ContentType = "application/json; charset=utf-8",
                Body = Encoding.UTF8.GetBytes(json)
            };
        }

        public static BridgeResponse Binary(string contentType, byte[] payload, int statusCode = 200)
        {
            return new BridgeResponse
            {
                StatusCode = statusCode,
                ContentType = contentType,
                Body = payload ?? new byte[0]
            };
        }

        /// Успешный конверт: { ok, apiVersion, gameTime, data: <фрагмент> }.
        public static BridgeResponse Ok(string dataJson, int statusCode = 200)
        {
            var w = new JsonWriter(dataJson != null ? dataJson.Length + 128 : 256);
            w.BeginObject()
             .Bool("ok", true)
             .Num("apiVersion", JunoBridgeMod.ApiVersion)
             .Num("gameTime", Clock.GameTime)
             .Raw("data", dataJson ?? "{}")
             .EndObject();
            return Json(w.ToString(), statusCode);
        }

        public static BridgeResponse Error(int statusCode, string code, string message, string detailJson = null)
        {
            var w = new JsonWriter(256);
            w.BeginObject()
             .Bool("ok", false)
             .Num("apiVersion", JunoBridgeMod.ApiVersion)
             .Num("gameTime", Clock.GameTime)
             .BeginObject("error")
                 .Str("code", code)
                 .Str("message", message)
                 .Raw("detail", detailJson ?? "{}")
             .EndObject()
             .EndObject();
            return Json(w.ToString(), statusCode);
        }
    }
}
