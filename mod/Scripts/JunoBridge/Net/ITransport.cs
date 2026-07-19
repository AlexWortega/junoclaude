using System;

namespace JunoBridge.Net
{
    /// Транспорт отделён от маршрутизации, чтобы падение HttpListener под Mono
    /// не требовало переписывать обработчики — достаточно другой реализации.
    internal interface ITransport
    {
        bool IsRunning { get; }

        void Start(string host, int port, Func<BridgeRequest, BridgeResponse> handler);

        void Stop();
    }
}
