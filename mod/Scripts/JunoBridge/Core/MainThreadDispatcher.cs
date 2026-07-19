using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading.Tasks;
using JunoBridge.Net;

namespace JunoBridge.Core
{
    internal sealed class MainThreadJob
    {
        public Func<BridgeResponse> Work;
        public TaskCompletionSource<BridgeResponse> Completion;
        public string Route;
        public bool NeedsEndOfFrame;
    }

    internal static class MainThreadDispatcher
    {
        private const int MaxJobsPerFrame = 16;
        private const double MaxMillisPerFrame = 4.0;
        private const int MaxQueueDepth = 128;

        private static readonly ConcurrentQueue<MainThreadJob> _queue = new ConcurrentQueue<MainThreadJob>();
        private static readonly ConcurrentQueue<MainThreadJob> _endOfFrameQueue = new ConcurrentQueue<MainThreadJob>();

        private static volatile bool _draining;

        public static int PendingCount
        {
            get { return _queue.Count + _endOfFrameQueue.Count; }
        }

        /// Вызывается с HTTP-потока и блокирует именно его, не главный.
        /// Никогда не вызывать изнутри работы, уже исполняемой на главном потоке —
        /// это мгновенный самодедлок.
        public static BridgeResponse Invoke(string route, Func<BridgeResponse> work, int timeoutMs, bool needsEndOfFrame = false)
        {
            if (_draining)
                return BridgeResponse.Error(503, "shutting_down", "Game is quitting.");

            if (PendingCount > MaxQueueDepth)
                return BridgeResponse.Error(503, "overloaded", "Main-thread queue saturated.");

            var job = new MainThreadJob
            {
                Work = work,
                Completion = new TaskCompletionSource<BridgeResponse>(TaskCreationOptions.RunContinuationsAsynchronously),
                Route = route,
                NeedsEndOfFrame = needsEndOfFrame
            };

            if (needsEndOfFrame) _endOfFrameQueue.Enqueue(job);
            else _queue.Enqueue(job);

            if (job.Completion.Task.Wait(timeoutMs))
                return job.Completion.Task.Result;

            // Отказываемся ждать. Последующий TrySetResult с главного потока — no-op:
            // нечего диспозить и нечего испортить. Ради этого здесь TCS, а не ManualResetEventSlim.
            job.Completion.TrySetCanceled();
            return BridgeResponse.Error(504, "main_thread_timeout",
                "Main thread did not service the request within " + timeoutMs +
                "ms (game may be loading a scene, minimised, or hitched).");
        }

        /// Каждый кадр, главный поток.
        public static void Pump()
        {
            PumpQueue(_queue);
        }

        /// Конец кадра, главный поток. Скриншоты требуют завершённой отрисовки.
        public static void PumpEndOfFrame()
        {
            PumpQueue(_endOfFrameQueue);
        }

        /// На выходе из игры: снимаем всех ожидающих, чтобы HTTP-потоки не висели до таймаута.
        public static void Drain()
        {
            _draining = true;
            MainThreadJob job;
            while (_queue.TryDequeue(out job))
                job.Completion.TrySetResult(BridgeResponse.Error(503, "shutting_down", "Game is quitting."));
            while (_endOfFrameQueue.TryDequeue(out job))
                job.Completion.TrySetResult(BridgeResponse.Error(503, "shutting_down", "Game is quitting."));
        }

        private static void PumpQueue(ConcurrentQueue<MainThreadJob> queue)
        {
            var sw = Stopwatch.StartNew();
            int handled = 0;
            MainThreadJob job;

            while (handled < MaxJobsPerFrame
                   && sw.Elapsed.TotalMilliseconds < MaxMillisPerFrame
                   && queue.TryDequeue(out job))
            {
                handled++;

                if (job.Completion.Task.IsCompleted) continue;

                BridgeResponse result;
                try
                {
                    result = job.Work();
                }
                catch (Exception ex)
                {
                    EventLog.Record(EventKind.Exception, "route=" + job.Route + " " + ex);
                    result = BridgeResponse.Error(500, "handler_exception", ex.GetType().Name + ": " + ex.Message);
                }

                job.Completion.TrySetResult(result);
            }
        }
    }
}
