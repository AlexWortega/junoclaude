using System;
using System.Collections.Generic;

namespace JunoBridge.Core
{
    internal enum EventKind
    {
        Staging,
        Explosion,
        PartDamage,
        PartDisconnected,
        CraftDestroyed,
        SoiChange,
        SceneLoaded,
        CraftChanged,
        CraftStructureChanged,
        VizzyMessage,
        VizzyError,
        Exception,
        Log,
        JobCompleted
    }

    internal struct BridgeEvent
    {
        public long Seq;
        public double GameTime;
        public double RealTime;
        public EventKind Kind;
        public string Message;
        public string DetailJson;
    }

    internal static class EventLog
    {
        private const int Capacity = 512; // степень двойки — маска вместо деления
        private static readonly BridgeEvent[] _buffer = new BridgeEvent[Capacity];
        private static readonly object _gate = new object();
        private static long _seq;

        /// Безопасно из любого потока.
        public static void Record(EventKind kind, string message, string detailJson = null)
        {
            lock (_gate)
            {
                _buffer[(int)(_seq & (Capacity - 1))] = new BridgeEvent
                {
                    Seq = _seq,
                    GameTime = Clock.GameTime,
                    RealTime = Clock.RealTime,
                    Kind = kind,
                    Message = message ?? string.Empty,
                    DetailJson = detailJson
                };
                _seq++;
            }
        }

        public static long LatestSeq
        {
            get { lock (_gate) return _seq; }
        }

        /// Возвращает события с Seq >= since. dropped > 0 означает, что клиент отстал
        /// и должен перечитать полное состояние, а не достраивать своё.
        public static List<BridgeEvent> Since(long since, int limit, out long dropped, out long newest)
        {
            var result = new List<BridgeEvent>();
            lock (_gate)
            {
                newest = _seq;
                long oldest = Math.Max(0, _seq - Capacity);
                dropped = since < oldest ? oldest - since : 0;

                long start = Math.Max(since, oldest);
                for (long s = start; s < _seq && result.Count < limit; s++)
                    result.Add(_buffer[(int)(s & (Capacity - 1))]);
            }
            return result;
        }

        public static string KindName(EventKind kind)
        {
            switch (kind)
            {
                case EventKind.Staging: return "staging";
                case EventKind.Explosion: return "explosion";
                case EventKind.PartDamage: return "part_damage";
                case EventKind.PartDisconnected: return "part_disconnected";
                case EventKind.CraftDestroyed: return "craft_destroyed";
                case EventKind.SoiChange: return "soi_change";
                case EventKind.SceneLoaded: return "scene_loaded";
                case EventKind.CraftChanged: return "craft_changed";
                case EventKind.CraftStructureChanged: return "craft_structure_changed";
                case EventKind.VizzyMessage: return "vizzy_message";
                case EventKind.VizzyError: return "vizzy_error";
                case EventKind.Exception: return "exception";
                case EventKind.JobCompleted: return "job_completed";
                default: return "log";
            }
        }
    }
}
