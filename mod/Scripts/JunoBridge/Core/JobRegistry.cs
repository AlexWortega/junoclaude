using System;
using System.Collections.Generic;
using System.Threading;
using JunoBridge.Json;

namespace JunoBridge.Core
{
    internal enum JobState
    {
        Pending,
        Running,
        Succeeded,
        Failed
    }

    internal sealed class BridgeJob
    {
        public string Id;
        public string Kind;
        public JobState State;
        public string Message;
        public double CreatedRealTime;
        public double CompletedRealTime;
    }

    /// Операции, меняющие сцену, нельзя ждать синхронно: на время загрузки главный поток
    /// перестаёт прокачивать очередь. Они возвращают 202 + jobId, статус опрашивается отдельно.
    internal static class JobRegistry
    {
        private const int MaxRetained = 64;

        private static readonly object _gate = new object();
        private static readonly Dictionary<string, BridgeJob> _jobs = new Dictionary<string, BridgeJob>(StringComparer.Ordinal);
        private static readonly Queue<string> _order = new Queue<string>();
        private static int _nextId;

        public static BridgeJob Create(string kind)
        {
            var job = new BridgeJob
            {
                Id = "j-" + Interlocked.Increment(ref _nextId),
                Kind = kind,
                State = JobState.Pending,
                CreatedRealTime = Clock.RealTime
            };

            lock (_gate)
            {
                _jobs[job.Id] = job;
                _order.Enqueue(job.Id);
                while (_order.Count > MaxRetained)
                    _jobs.Remove(_order.Dequeue());
            }
            return job;
        }

        public static BridgeJob Find(string id)
        {
            lock (_gate)
            {
                BridgeJob job;
                return _jobs.TryGetValue(id, out job) ? job : null;
            }
        }

        public static void Complete(BridgeJob job, bool success, string message)
        {
            if (job == null) return;
            lock (_gate)
            {
                job.State = success ? JobState.Succeeded : JobState.Failed;
                job.Message = message;
                job.CompletedRealTime = Clock.RealTime;
            }
            EventLog.Record(EventKind.JobCompleted, job.Kind + " " + job.Id + ": " + (success ? "ok" : "failed"),
                new JsonWriter(128).BeginObject().Str("jobId", job.Id).Str("kind", job.Kind)
                    .Bool("success", success).Str("message", message).EndObject().ToString());
        }

        /// Завершает все ещё не закрытые задачи данного вида — используется, когда
        /// подтверждением служит внешнее событие (например, SceneTransitionCompleted).
        public static void CompleteAllOfKind(string kind, bool success, string message)
        {
            List<BridgeJob> pending = new List<BridgeJob>();
            lock (_gate)
            {
                foreach (var job in _jobs.Values)
                    if (job.Kind == kind && (job.State == JobState.Pending || job.State == JobState.Running))
                        pending.Add(job);
            }
            foreach (var job in pending)
                Complete(job, success, message);
        }

        public static string ToJson(BridgeJob job)
        {
            var w = new JsonWriter(192);
            w.BeginObject()
             .Str("jobId", job.Id)
             .Str("kind", job.Kind)
             .Str("state", StateName(job.State))
             .Str("message", job.Message)
             .Num("createdRealTime", job.CreatedRealTime)
             .Num("completedRealTime", job.CompletedRealTime)
             .EndObject();
            return w.ToString();
        }

        private static string StateName(JobState state)
        {
            switch (state)
            {
                case JobState.Pending: return "pending";
                case JobState.Running: return "running";
                case JobState.Succeeded: return "succeeded";
                default: return "failed";
            }
        }
    }
}
