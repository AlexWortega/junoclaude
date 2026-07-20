using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;
using JunoBridge.Serialization;

namespace JunoBridge.Handlers
{
    internal static class WorldHandler
    {
        public static BridgeResponse GetLaunchLocations()
        {
            var game = GameContext.Game;
            if (game == null || game.GameState == null)
                return BridgeResponse.Error(503, "game_state_unavailable", "No active game state.");

            var state = game.GameState;
            var selected = state.SelectedLaunchLocation;

            var w = new JsonWriter(2048);
            w.BeginObject()
             .Str("selected", selected == null ? null : selected.Name)
             .BeginArray("locations");

            if (state.LaunchLocations != null)
                foreach (var location in state.LaunchLocations)
                {
                    if (location == null) continue;
                    w.BeginObject()
                     .Str("name", location.Name)
                     .Str("planet", location.PlanetName)
                     .Str("description", location.Description)
                     .Str("type", location.LocationType.ToString())
                     .Num("latitude", location.Latitude)
                     .Num("longitude", location.Longitude)
                     .Num("altitudeAgl", location.AltitudeAboveGroundLevel)
                     .Quat("heading", location.Heading)
                     .Num("launchCostPerKg", location.LaunchCostPerKG)
                     .Num("maxCraftMass", location.MaxCraftMass)
                     .Num("maxCraftHeight", location.MaxCraftHeight)
                     .Num("maxCraftDiameter", location.MaxCraftDiameter)
                     .Bool("userCreated", location.UserCreated)
                     .EndObject();
                }

            w.EndArray().EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse GetPlanets()
        {
            var flight = GameContext.Flight;
            if (flight == null || flight.FlightState == null) return Errors.NotInFlight();

            var root = flight.FlightState.RootNode;

            var w = new JsonWriter(2048);
            w.BeginObject().BeginArray("planets");
            WritePlanetTree(w, root as ModApi.Flight.Sim.IPlanetNode);
            w.EndArray().EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        /// <summary>
        /// Writes a body and everything needed to plan a transfer to it.
        ///
        /// Name and sphere of influence alone are not enough: a transfer needs
        /// the target's radius, its position, and its orbit around the parent,
        /// and none of that can be recovered on the client side — a craft's own
        /// telemetry locates the craft, not the moon it is aiming at.
        ///
        /// Positions are planet-centred inertial, the same frame the craft's
        /// `position.pci` uses, so a phase angle is the angle between the two.
        /// </summary>
        private static void WritePlanetTree(JsonWriter w, ModApi.Flight.Sim.IPlanetNode planet)
        {
            if (planet == null) return;

            w.BeginObject()
             .Str("name", planet.Name)
             .Str("parent", planet.Parent == null ? null : planet.Parent.Name)
             .Num("sphereOfInfluence", planet.SphereOfInfluence)
             .Num("rotationAngle", planet.RotationAngle)
             .Bool("terrainLoaded", planet.IsTerrainDataLoaded)
             .Vec("position", planet.Position)
             .Vec("solarPosition", planet.SolarPosition);

            var data = planet.PlanetData;
            if (data != null)
            {
                // Radius and mass are the two that matter and the two that
                // exist: IPlanetData carries no Gravity, and IPlanetAtmosphereData
                // no AtmosphereHeight. The gravitational parameter follows from
                // the mass once G is calibrated against Droo, whose μ is already
                // measured at 1.593e13 from surface gravity and radius.
                w.Num("radius", data.Radius)
                 .Num("mass", data.Mass);

                var atmosphere = data.AtmosphereData;
                if (atmosphere != null)
                    w.Bool("hasAtmosphere", atmosphere.HasPhysicsAtmosphere);
            }

            OrbitSerializer.Write(w, "orbit", planet.Orbit, planet);

            w.EndObject();

            if (planet.ChildPlanets == null) return;
            foreach (var child in planet.ChildPlanets)
                WritePlanetTree(w, child);
        }
    }
}
