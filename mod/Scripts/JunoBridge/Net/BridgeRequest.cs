using System;
using System.Collections.Generic;

namespace JunoBridge.Net
{
    internal sealed class BridgeRequest
    {
        public string Method = "GET";
        public string Path = "/";
        public string Body = string.Empty;

        public readonly Dictionary<string, string> Query =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public readonly Dictionary<string, string> Headers =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        /// Сегменты пути без пустых элементов: "/vizzy/12" -> ["vizzy", "12"].
        public string[] Segments = new string[0];

        public string Header(string name)
        {
            string value;
            return Headers.TryGetValue(name, out value) ? value : null;
        }

        public string Q(string name, string fallback = null)
        {
            string value;
            return Query.TryGetValue(name, out value) ? value : fallback;
        }

        public int QInt(string name, int fallback)
        {
            string raw;
            int parsed;
            if (Query.TryGetValue(name, out raw) &&
                int.TryParse(raw, System.Globalization.NumberStyles.Integer,
                             System.Globalization.CultureInfo.InvariantCulture, out parsed))
                return parsed;
            return fallback;
        }

        public long QLong(string name, long fallback)
        {
            string raw;
            long parsed;
            if (Query.TryGetValue(name, out raw) &&
                long.TryParse(raw, System.Globalization.NumberStyles.Integer,
                              System.Globalization.CultureInfo.InvariantCulture, out parsed))
                return parsed;
            return fallback;
        }

        public void SetPath(string rawPath)
        {
            Path = string.IsNullOrEmpty(rawPath) ? "/" : rawPath;
            Segments = Path.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
        }
    }
}
