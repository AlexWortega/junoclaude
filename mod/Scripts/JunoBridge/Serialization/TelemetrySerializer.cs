using System;
using System.Collections.Generic;
using JunoBridge.Core;
using JunoBridge.Json;
using ModApi.Craft;
using ModApi.Craft.Parts;
using ModApi.Flight.Sim;

namespace JunoBridge.Serialization
{
    /// Сериализуем заведомо избыточно: лишние 40 полей стоят микросекунды,
    /// а добавление одного поля позже стоит пересборки Unity и перезапуска игры.
    internal static class TelemetrySerializer
    {
        private const double RadToDeg = 180.0 / Math.PI;

        public static string Full(ICraftNode node)
        {
            var craft = node.CraftScript;
            var data = craft == null ? null : craft.FlightData;

            var w = new JsonWriter(4096);
            w.BeginObject();

            WriteIdentity(w, node);

            if (data == null)
            {
                w.Bool("flightDataAvailable", false).EndObject();
                return w.ToString();
            }

            WritePosition(w, node);
            WriteAttitude(w, data);
            WriteVelocity(w, data);
            WriteDynamics(w, craft, data);
            WriteMass(w, data);
            WritePropulsion(w, data);
            WriteState(w, node, craft, data);
            // ICraftFlightData.Orbit — это ICraftOrbitData (урезанная сводка на 8 полей).
            // Полные элементы орбиты живут в IOrbitNode.Orbit.
            var orbitNode = node as IOrbitNode;
            OrbitSerializer.Write(w, "orbit", orbitNode == null ? null : orbitNode.Orbit, orbitNode);
            WriteControls(w, node);

            w.EndObject();
            return w.ToString();
        }

        public static string Lite(ICraftNode node)
        {
            var craft = node.CraftScript;
            var data = craft == null ? null : craft.FlightData;

            var w = new JsonWriter(512);
            w.BeginObject()
             .Num("nodeId", node.NodeId)
             .Bool("paused", GameContext.Paused)
             .Num("timeMultiplier", GameContext.TimeMultiplier)
             .Num("altitudeAsl", node.Altitude)
             .Num("altitudeAgl", node.AltitudeAgl)
             .Quat("heading", node.Heading);

            if (data != null)
            {
                w.Num("pitch", data.Pitch)
                 .Num("bank", data.BankAngle)
                 .Num("surfaceSpeed", data.SurfaceVelocityMagnitude)
                 .Num("verticalSpeed", data.VerticalSurfaceVelocity)
                 .Num("orbitalSpeed", data.VelocityMagnitude)
                 .Num("mass", data.CurrentMass)
                 .Num("thrust", data.CurrentEngineThrust)
                 .Num("machNumber", data.MachNumber)
                 .Num("remainingFuelInStage", data.RemainingFuelInStage);
            }

            var controls = node.Controls;
            if (controls != null) w.Num("throttle", controls.Throttle);

            w.EndObject();
            return w.ToString();
        }

        private static void WriteIdentity(JsonWriter w, ICraftNode node)
        {
            w.Num("nodeId", node.NodeId)
             .Str("name", node.Name)
             .Bool("isPlayer", node.IsPlayer)
             .Bool("paused", GameContext.Paused)
             .Num("timeMultiplier", GameContext.TimeMultiplier)
             .Bool("physicsEnabled", node.CraftScript != null && node.CraftScript.IsPhysicsEnabled)
             .Bool("canWarp", node.CanWarp);
        }

        private static void WritePosition(JsonWriter w, ICraftNode node)
        {
            var parent = node.Parent as IOrbitNode;

            w.BeginObject("position")
             .Str("planet", parent == null ? null : parent.Name)
             // LatLon приходит в радианах; наружу отдаём градусы — LLM плохо рассуждают в радианах.
             .Num("latitude", node.LatLon.x * RadToDeg)
             .Num("longitude", node.LatLon.y * RadToDeg)
             .Num("altitudeAsl", node.Altitude)
             .Num("altitudeAgl", node.AltitudeAgl)
             .Num("altitudeTerrain", node.AltitudeAboveTerrain)
             .Vec("pci", node.Position)
             .Vec("solar", node.SolarPosition)
             .Num("waterDepth", node.WaterDepth)
             .EndObject();
        }

        private static void WriteAttitude(JsonWriter w, ICraftFlightData data)
        {
            w.BeginObject("attitude")
             .Num("pitch", data.Pitch)
             .Num("heading", data.Heading)
             .Num("bank", data.BankAngle)
             .Num("angleOfAttack", data.AngleOfAttack)
             .Num("sideSlip", data.SideSlip)
             .Vec("forward", data.CraftForward)
             .Vec("up", data.CraftUp)
             .Vec("right", data.CraftRight)
             .Vec("north", data.North)
             .Vec("east", data.East)
             .EndObject();
        }

        private static void WriteVelocity(JsonWriter w, ICraftFlightData data)
        {
            w.BeginObject("velocity")
             .Vec("surface", data.SurfaceVelocity)
             .Num("surfaceMagnitude", data.SurfaceVelocityMagnitude)
             .Num("vertical", data.VerticalSurfaceVelocity)
             .Num("lateral", data.LateralSurfaceVelocity)
             .Vec("orbital", data.Velocity)
             .Num("orbitalMagnitude", data.VelocityMagnitude)
             .Vec("angular", data.AngularVelocity)
             .Num("angularMagnitude", data.AngularVelocityMagnitude)
             .EndObject();
        }

        private static void WriteDynamics(JsonWriter w, ICraftScript craft, ICraftFlightData data)
        {
            var atmosphere = data.AtmosphereSample;

            w.BeginObject("dynamics")
             .Vec("acceleration", data.Acceleration)
             .Num("accelerationMagnitude", data.AccelerationMagnitude)
             .Num("gravityMagnitude", data.GravityMagnitude)
             .Vec("gravity", data.Gravity)
             .Num("dragAcceleration", data.DragAccelerationMagnitude)
             .Num("machNumber", data.MachNumber)
             .Num("reEntryIntensity", craft == null ? 0.0 : craft.ReEntryIntensity)
             .BeginObject("atmosphere")
                 .Num("pressure", atmosphere.AirPressure)
                 .Num("density", atmosphere.AirDensity)
                 .Num("temperature", atmosphere.Temperature)
                 .Num("speedOfSound", atmosphere.SpeedOfSound)
                 .Num("scaleHeight", atmosphere.ScaleHeight)
                 .Num("atmosphereHeight", atmosphere.AtmosphereHeight)
             .EndObject()
             .EndObject();
        }

        private static void WriteMass(JsonWriter w, ICraftFlightData data)
        {
            w.BeginObject("mass")
             .Num("current", data.CurrentMass)
             .Num("currentUnscaled", data.CurrentMassUnscaled)
             .Num("fuel", data.FuelMass)
             .Num("remainingFuelInStage", data.RemainingFuelInStage)
             .Num("remainingMonopropellant", data.RemainingMonopropellant)
             .Num("remainingBattery", data.RemainingBattery)
             .EndObject();
        }

        private static void WritePropulsion(JsonWriter w, ICraftFlightData data)
        {
            double mass = data.CurrentMass;
            double gravity = data.GravityMagnitude;
            double weight = mass * gravity;
            // TWR в API нет; делитель может быть нулевым в глубоком космосе.
            double twr = weight > 1e-6 ? data.MaxActiveEngineThrust / weight : 0.0;

            int engineCount = 0;
            if (data.ActiveEngines != null)
                foreach (var engine in data.ActiveEngines) { engineCount++; }

            w.BeginObject("propulsion")
             .Num("currentThrust", data.CurrentEngineThrust)
             .Num("currentThrustUnscaled", data.CurrentEngineThrustUnscaled)
             .Num("maxThrust", data.MaxActiveEngineThrust)
             .Num("maxThrustUnscaled", data.MaxActiveEngineThrustUnscaled)
             .Num("rcsThrust", data.CurrentReactionControlNozzleThrust)
             .Num("activeEngineCount", engineCount)
             .Num("twr", twr)
             .EndObject();
        }

        private static void WriteState(JsonWriter w, ICraftNode node, ICraftScript craft, ICraftFlightData data)
        {
            var pod = craft == null ? null : (craft.ActiveCommandPod ?? craft.PrimaryCommandPod);

            w.BeginObject("state")
             .Bool("grounded", data.Grounded)
             .Bool("inWater", data.InWater)
             .Bool("inContactWithPlanet", node.InContactWithPlanet)
             .Bool("inContactWithWater", node.InContactWithWater)
             .Num("partCount", node.CraftPartCount)
             .Num("currentStage", pod == null ? -1 : pod.CurrentStage)
             .Num("numStages", pod == null ? 0 : pod.NumStages);

            w.BeginArray("activationGroups");
            if (node.Controls != null)
                for (int group = 1; group <= 10; group++)
                    w.Bool(node.Controls.GetActivationGroup(group));
            w.EndArray();

            w.EndObject();
        }

        private static void WriteControls(JsonWriter w, ICraftNode node)
        {
            var controls = node.Controls;
            w.BeginObject("controls");

            if (controls != null)
            {
                w.Num("throttle", controls.Throttle)
                 .Num("pitch", controls.Pitch)
                 .Num("yaw", controls.Yaw)
                 .Num("roll", controls.Roll)
                 .Num("brake", controls.Brake)
                 .Num("translateForward", controls.TranslateForward)
                 .Num("translateRight", controls.TranslateRight)
                 .Num("translateUp", controls.TranslateUp)
                 .Num("slider1", controls.Slider1)
                 .Num("slider2", controls.Slider2)
                 .Num("slider3", controls.Slider3)
                 .Num("slider4", controls.Slider4)
                 .Quat("targetHeading", controls.TargetHeading)
                 .Bool("translationMode", controls.TranslationModeEnabled);
            }

            w.BeginArray("overridesHeld");
            List<ControlAxis> held = ControlOverrides.HeldAxes();
            for (int i = 0; i < held.Count; i++)
                w.Str(ControlOverrides.Name(held[i]));
            w.EndArray();

            w.EndObject();
        }
    }
}
