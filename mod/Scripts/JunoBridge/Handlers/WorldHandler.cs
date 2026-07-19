using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;

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

        private static void WritePlanetTree(JsonWriter w, ModApi.Flight.Sim.IPlanetNode planet)
        {
            if (planet == null) return;

            w.BeginObject()
             .Str("name", planet.Name)
             .Num("sphereOfInfluence", planet.SphereOfInfluence)
             .Num("rotationAngle", planet.RotationAngle)
             .Bool("terrainLoaded", planet.IsTerrainDataLoaded)
             .EndObject();

            if (planet.ChildPlanets == null) return;
            foreach (var child in planet.ChildPlanets)
                WritePlanetTree(w, child);
        }
    }
}
