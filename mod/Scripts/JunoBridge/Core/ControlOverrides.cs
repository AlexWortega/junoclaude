using System.Collections.Generic;
using ModApi.Craft;

namespace JunoBridge.Core
{
    internal enum ControlAxis
    {
        Throttle,
        Pitch,
        Yaw,
        Roll,
        Brake,
        TranslateForward,
        TranslateRight,
        TranslateUp,
        Slider1,
        Slider2,
        Slider3,
        Slider4
        // TargetHeading здесь намеренно нет: CraftControls.TargetHeading имеет тип
        // Quaterniond? (ориентация), а весь этот конвейер — скалярный float.
        // Ось отключена явно, см. отказ not_supported в FlightControlHandler.
    }

    /// Однократная запись в CraftControls живёт один кадр: собственный ввод игры
    /// перезапишет её на следующем. Удержание переставляет значения каждый
    /// FlightPreFixedUpdate, до явной отмены.
    internal static class ControlOverrides
    {
        private static readonly Dictionary<ControlAxis, float> _held = new Dictionary<ControlAxis, float>();
        private static readonly Dictionary<ControlAxis, double> _pulseUntil = new Dictionary<ControlAxis, double>();

        public static void Hold(ControlAxis axis, float value)
        {
            lock (_held)
            {
                _held[axis] = value;
                _pulseUntil.Remove(axis);
            }
        }

        public static void Pulse(ControlAxis axis, float value, double durationSeconds)
        {
            lock (_held)
            {
                _held[axis] = value;
                _pulseUntil[axis] = Clock.RealTime + durationSeconds;
            }
        }

        public static void Release(ControlAxis axis)
        {
            lock (_held)
            {
                _held.Remove(axis);
                _pulseUntil.Remove(axis);
            }
        }

        public static void ReleaseAll()
        {
            lock (_held)
            {
                _held.Clear();
                _pulseUntil.Clear();
            }
        }

        public static List<ControlAxis> HeldAxes()
        {
            lock (_held) return new List<ControlAxis>(_held.Keys);
        }

        /// Главный поток, перед физикой.
        public static void Apply()
        {
            var craft = GameContext.PlayerCraftNode;
            if (craft == null) return;
            var controls = craft.Controls;
            if (controls == null) return;

            List<ControlAxis> expired = null;

            lock (_held)
            {
                if (_held.Count == 0) return;

                double now = Clock.RealTime;
                foreach (var pair in _held)
                {
                    double until;
                    if (_pulseUntil.TryGetValue(pair.Key, out until) && now >= until)
                    {
                        (expired = expired ?? new List<ControlAxis>()).Add(pair.Key);
                        continue;
                    }
                    Write(controls, pair.Key, pair.Value);
                }

                if (expired != null)
                    foreach (var axis in expired)
                    {
                        _held.Remove(axis);
                        _pulseUntil.Remove(axis);
                    }
            }
        }

        public static void Write(CraftControls controls, ControlAxis axis, float value)
        {
            switch (axis)
            {
                case ControlAxis.Throttle: controls.Throttle = value; break;
                case ControlAxis.Pitch: controls.Pitch = value; break;
                case ControlAxis.Yaw: controls.Yaw = value; break;
                case ControlAxis.Roll: controls.Roll = value; break;
                case ControlAxis.Brake: controls.Brake = value; break;
                case ControlAxis.TranslateForward: controls.TranslateForward = value; break;
                case ControlAxis.TranslateRight: controls.TranslateRight = value; break;
                case ControlAxis.TranslateUp: controls.TranslateUp = value; break;
                case ControlAxis.Slider1: controls.Slider1 = value; break;
                case ControlAxis.Slider2: controls.Slider2 = value; break;
                case ControlAxis.Slider3: controls.Slider3 = value; break;
                case ControlAxis.Slider4: controls.Slider4 = value; break;
            }
        }

        public static string Name(ControlAxis axis)
        {
            switch (axis)
            {
                case ControlAxis.Throttle: return "throttle";
                case ControlAxis.Pitch: return "pitch";
                case ControlAxis.Yaw: return "yaw";
                case ControlAxis.Roll: return "roll";
                case ControlAxis.Brake: return "brake";
                case ControlAxis.TranslateForward: return "translateForward";
                case ControlAxis.TranslateRight: return "translateRight";
                case ControlAxis.TranslateUp: return "translateUp";
                case ControlAxis.Slider1: return "slider1";
                case ControlAxis.Slider2: return "slider2";
                case ControlAxis.Slider3: return "slider3";
                default: return "slider4";
            }
        }

        public static bool TryParseAxis(string name, out ControlAxis axis)
        {
            switch (name)
            {
                case "throttle": axis = ControlAxis.Throttle; return true;
                case "pitch": axis = ControlAxis.Pitch; return true;
                case "yaw": axis = ControlAxis.Yaw; return true;
                case "roll": axis = ControlAxis.Roll; return true;
                case "brake": axis = ControlAxis.Brake; return true;
                case "translateForward": axis = ControlAxis.TranslateForward; return true;
                case "translateRight": axis = ControlAxis.TranslateRight; return true;
                case "translateUp": axis = ControlAxis.TranslateUp; return true;
                case "slider1": axis = ControlAxis.Slider1; return true;
                case "slider2": axis = ControlAxis.Slider2; return true;
                case "slider3": axis = ControlAxis.Slider3; return true;
                case "slider4": axis = ControlAxis.Slider4; return true;
                default: axis = ControlAxis.Throttle; return false;
            }
        }
    }
}
