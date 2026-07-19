using System;
// Not "using System.Diagnostics": it pulls in System.Diagnostics.EventLog,
// which collides with JunoBridge.Core.EventLog.
using Diag = System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using JunoBridge.Core;
using ModApi;

namespace JunoBridge.Net
{
    /// Binding to 127.0.0.1 keeps remote callers out, but not other local processes and not
    /// a page in the user's browser. A token in a 0600 file is the same trick Jupyter uses,
    /// and the MCP server gets it for free.
    internal static class Auth
    {
        public const string TokenFileName = "junobridge.token";
        public const string InfoFileName = "junobridge.json";

        private static string _token;
        private static byte[] _tokenBytes;

        public static string Token
        {
            get { return _token; }
        }

        public static string TokenPath
        {
            get { return Path.Combine(DataDirectory, TokenFileName); }
        }

        public static string InfoPath
        {
            get { return Path.Combine(DataDirectory, InfoFileName); }
        }

        private static string DataDirectory
        {
            get
            {
                string path = ModApi.Common.Game.PersistentDataPath;
                return string.IsNullOrEmpty(path) ? UnityEngine.Application.persistentDataPath : path;
            }
        }

        /// The token is regenerated on every game launch so that a leaked file does not grant
        /// access to the next session.
        public static void Initialize(int port)
        {
            var raw = new byte[32];
            using (var rng = RandomNumberGenerator.Create())
                rng.GetBytes(raw);

            _token = ToHex(raw);
            _tokenBytes = Encoding.ASCII.GetBytes(_token);

            WriteRestricted(TokenPath, _token);

            var info = new Json.JsonWriter(160);
            info.BeginObject()
                .Num("port", port)
                .Num("apiVersion", JunoBridgeMod.ApiVersion)
                .Str("modVersion", JunoBridgeMod.ModVersion)
                .Num("pid", Diag.Process.GetCurrentProcess().Id)
                .Str("tokenFile", TokenPath)
                .EndObject();
            WriteRestricted(InfoPath, info.ToString());
        }

        public static bool Verify(BridgeRequest request)
        {
            if (_tokenBytes == null) return false;

            string presented = null;

            string header = request.Header("Authorization");
            if (!string.IsNullOrEmpty(header) && header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                presented = header.Substring(7).Trim();

            if (string.IsNullOrEmpty(presented))
                presented = request.Q("token");

            if (string.IsNullOrEmpty(presented)) return false;

            return FixedTimeEquals(_tokenBytes, Encoding.ASCII.GetBytes(presented));
        }

        /// DNS rebinding: a page in a browser can send requests to localhost. There are no CORS
        /// headers at all, and requests carrying an Origin are rejected explicitly.
        public static bool LooksLikeBrowser(BridgeRequest request)
        {
            return !string.IsNullOrEmpty(request.Header("Origin"));
        }

        private static bool FixedTimeEquals(byte[] a, byte[] b)
        {
            // CryptographicOperations.FixedTimeEquals may be absent in this Mono.
            int diff = a.Length ^ b.Length;
            for (int i = 0; i < a.Length && i < b.Length; i++)
                diff |= a[i] ^ b[i];
            return diff == 0;
        }

        private static void WriteRestricted(string path, string contents)
        {
            File.WriteAllText(path, contents, new UTF8Encoding(false));

            if (Path.DirectorySeparatorChar != '\\')
            {
                try
                {
                    var psi = new Diag.ProcessStartInfo("/bin/chmod", "600 \"" + path + "\"")
                    {
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                    using (var p = Diag.Process.Start(psi))
                        if (p != null) p.WaitForExit(2000);
                }
                catch (Exception ex)
                {
                    EventLog.Record(EventKind.Exception, "chmod 600 failed for " + path + ": " + ex.Message);
                }
            }
        }

        private static string ToHex(byte[] bytes)
        {
            var sb = new StringBuilder(bytes.Length * 2);
            for (int i = 0; i < bytes.Length; i++)
                sb.Append(bytes[i].ToString("x2", System.Globalization.CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }
}
