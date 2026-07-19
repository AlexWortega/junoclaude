using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using JunoBridge.Core;

namespace JunoBridge.Net
{
    internal sealed class HttpListenerTransport : ITransport
    {
        private HttpListener _listener;
        private Thread _acceptThread;
        private Func<BridgeRequest, BridgeResponse> _handler;
        private volatile bool _running;

        public bool IsRunning
        {
            get { return _running; }
        }

        public void Start(string host, int port, Func<BridgeRequest, BridgeResponse> handler)
        {
            if (_running) return;

            _handler = handler;
            _listener = new HttpListener();
            _listener.Prefixes.Add("http://" + host + ":" + port + "/");
            _listener.Start();
            _running = true;

            _acceptThread = new Thread(AcceptLoop);
            _acceptThread.IsBackground = true;
            _acceptThread.Name = "JunoBridge.Accept";
            _acceptThread.Start();
        }

        public void Stop()
        {
            if (!_running) return;
            _running = false;

            try { if (_listener != null) _listener.Stop(); }
            catch (Exception) { }
            try { if (_listener != null) _listener.Close(); }
            catch (Exception) { }
            _listener = null;
        }

        private void AcceptLoop()
        {
            while (_running)
            {
                HttpListenerContext context;
                try
                {
                    context = _listener.GetContext();
                }
                catch (Exception)
                {
                    // Закрытие слушателя приводит сюда же — это штатный выход.
                    if (!_running) return;
                    Thread.Sleep(50);
                    continue;
                }

                ThreadPool.QueueUserWorkItem(ServeContext, context);
            }
        }

        private void ServeContext(object state)
        {
            var context = (HttpListenerContext)state;
            BridgeResponse response;

            try
            {
                response = _handler(ReadRequest(context.Request));
            }
            catch (Exception ex)
            {
                EventLog.Record(EventKind.Exception, "transport: " + ex);
                response = BridgeResponse.Error(500, "transport_exception", ex.GetType().Name + ": " + ex.Message);
            }

            try
            {
                WriteResponse(context.Response, response);
            }
            catch (Exception)
            {
                // Клиент мог отвалиться до записи ответа — это не наша проблема.
            }
            finally
            {
                try { context.Response.Close(); }
                catch (Exception) { }
            }
        }

        private static BridgeRequest ReadRequest(HttpListenerRequest raw)
        {
            var request = new BridgeRequest();
            request.Method = raw.HttpMethod ?? "GET";
            request.SetPath(raw.Url == null ? "/" : raw.Url.AbsolutePath);

            foreach (string name in raw.Headers.AllKeys)
            {
                if (name == null) continue;
                request.Headers[name] = raw.Headers[name];
            }

            var query = raw.QueryString;
            foreach (string key in query.AllKeys)
            {
                if (key == null) continue;
                request.Query[key] = query[key];
            }

            if (raw.HasEntityBody)
            {
                using (var reader = new StreamReader(raw.InputStream, raw.ContentEncoding ?? Encoding.UTF8))
                    request.Body = reader.ReadToEnd();
            }

            return request;
        }

        private static void WriteResponse(HttpListenerResponse raw, BridgeResponse response)
        {
            raw.StatusCode = response.StatusCode;
            raw.ContentType = response.ContentType;
            raw.Headers["Cache-Control"] = "no-store";
            if (!string.IsNullOrEmpty(response.RetryAfter))
                raw.Headers["Retry-After"] = response.RetryAfter;

            raw.ContentLength64 = response.Body.Length;
            if (response.Body.Length > 0)
                raw.OutputStream.Write(response.Body, 0, response.Body.Length);
        }
    }
}
