using System.Threading;

namespace JunoBridge.Core
{
    /// Во время смены сцены главный поток может не прокачивать очередь несколько секунд,
    /// а объектный граф наполовину разобран. Поэтому запрос отбивается ещё на HTTP-потоке,
    /// до постановки в очередь.
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
            // Событий завершения может прийти больше, чем начал; ниже нуля не опускаемся.
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
