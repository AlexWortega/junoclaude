using System;
using System.Threading;
using ModApi;

namespace JunoBridge.Core
{
    /// Кэш времени. EventLog.Record вызывается в том числе с HTTP-потоков, а
    /// UnityEngine.Time и Game.Instance читать вне главного потока нельзя —
    /// поэтому значения снимаются раз в кадр из Tick() и дальше только читаются.
    internal static class Clock
    {
        private static volatile float _realTime;
        private static long _gameTimeBits;

        public static double RealTime
        {
            get { return _realTime; }
        }

        public static double GameTime
        {
            get { return BitConverter.Int64BitsToDouble(Interlocked.Read(ref _gameTimeBits)); }
        }

        /// Только главный поток.
        public static void Tick()
        {
            _realTime = UnityEngine.Time.realtimeSinceStartup;

            double gameTime = 0.0;
            try
            {
                var game = Game.Instance;
                if (game != null && game.SceneManager != null && game.SceneManager.InFlightScene)
                {
                    var flight = game.FlightScene;
                    if (flight != null && flight.FlightState != null)
                        gameTime = flight.FlightState.Time;
                }
            }
            catch
            {
                gameTime = 0.0;
            }

            Interlocked.Exchange(ref _gameTimeBits, BitConverter.DoubleToInt64Bits(gameTime));
        }
    }
}
