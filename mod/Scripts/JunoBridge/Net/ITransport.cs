using System;

namespace JunoBridge.Net
{
    /// The transport is separated from routing so that HttpListener failing under Mono does
    /// not require rewriting the handlers — a different implementation is enough.
    internal interface ITransport
    {
        bool IsRunning { get; }

        void Start(string host, int port, Func<BridgeRequest, BridgeResponse> handler);

        void Stop();
    }
}
