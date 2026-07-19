using System.Threading;

namespace JunoBridge.Core
{
    /// During a scene change the main thread may stop pumping the queue for several seconds,
    /// and the object graph is half torn down. So the request is rejected on the HTTP thread,
    /// before it is even enqueued.
    internal static class SceneGate
    {
        private static int _transitionDepth;

        public static bool Transitioning
        {
            get { return Volatile.Read(ref _transitionDepth) > 0; }
        }

        public static void Enter()
        {
            Interlocked.Increment(ref _transitionDepth);
        }

        public static void Exit()
        {
            // More completion events may arrive than start events; never go below zero.
            int current;
            do
            {
                current = Volatile.Read(ref _transitionDepth);
                if (current <= 0) return;
            }
            while (Interlocked.CompareExchange(ref _transitionDepth, current - 1, current) != current);
        }

        public static void Reset()
        {
            Interlocked.Exchange(ref _transitionDepth, 0);
        }
    }
}
