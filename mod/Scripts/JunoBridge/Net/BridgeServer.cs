using System;
using JunoBridge.Core;

namespace JunoBridge.Net
{
    internal sealed class BridgeServer
    {
        public const string Host = "127.0.0.1";
        public const int Port = 7842;

        private static readonly BridgeServer _instance = new BridgeServer();

        private ITransport _transport;

        private BridgeServer()
        {
        }

        public static BridgeServer Instance
        {
            get { return _instance; }
        }

        public bool IsRunning
        {
            get { return _transport != null && _transport.IsRunning; }
        }

        public void Start()
        {
            if (IsRunning) return;

            Auth.Initialize(Port);

            _transport = new HttpListenerTransport();
            _transport.Start(Host, Port, Router.Dispatch);

            EventLog.Record(EventKind.Log, "Bridge listening on http://" + Host + ":" + Port +
                                           " (token: " + Auth.TokenPath + ")");
        }

        public void Stop()
        {
            if (_transport == null) return;
            try { _transport.Stop(); }
            catch (Exception ex) { EventLog.Record(EventKind.Exception, "BridgeServer.Stop: " + ex); }
            _transport = null;
        }
    }
}
