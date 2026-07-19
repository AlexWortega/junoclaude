using System.Collections.Generic;
using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;

namespace JunoBridge.Handlers
{
    internal static class EventsHandler
    {
        private const int DefaultLimit = 128;
        private const int MaxLimit = 512;

        public static BridgeResponse Get(BridgeRequest request)
        {
            long since = request.QLong("since", 0);
            int limit = request.QInt("limit", DefaultLimit);
            if (limit < 1) limit = 1;
            if (limit > MaxLimit) limit = MaxLimit;

            long dropped, newest;
            List<BridgeEvent> events = EventLog.Since(since, limit, out dropped, out newest);

            var w = new JsonWriter(1024);
            w.BeginObject().BeginArray("events");

            for (int i = 0; i < events.Count; i++)
            {
                var e = events[i];
                w.BeginObject()
                 .Num("seq", e.Seq)
                 .Num("gameTime", e.GameTime)
                 .Num("realTime", e.RealTime)
                 .Str("kind", EventLog.KindName(e.Kind))
                 .Str("message", e.Message)
                 .Raw("detail", e.DetailJson ?? "null")
                 .EndObject();
            }

            w.EndArray()
             .Num("nextSeq", events.Count > 0 ? events[events.Count - 1].Seq + 1 : System.Math.Max(since, newest))
             // dropped > 0 значит, что клиент отстал от кольца: продолжать историю нельзя,
             // нужно перечитать полное состояние.
             .Num("dropped", dropped)
             .Num("latestSeq", newest)
             .EndObject();

            return BridgeResponse.Ok(w.ToString());
        }
    }
}
