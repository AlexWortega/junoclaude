using System;
using System.Threading;
using ModApi;

namespace JunoBridge.Core
{
    /// Time cache. EventLog.Record is called from HTTP threads too, and UnityEngine.Time
    /// and Game.Instance must not be read off the main thread — so the values are sampled
    /// once per frame in Tick() and only read afterwards.
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

        /// Main thread only.
        public static void Tick()
        {
            _realTime = UnityEngine.Time.realtimeSinceStartup;

            double gameTime = 0.0;
            try
            {
                var game = GameContext.Game;
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
