using System;
using JunoBridge.Json;
using ModApi.Flight.Sim;

namespace JunoBridge.Serialization
{
    internal static class OrbitSerializer
    {
        private const double RadToDeg = 180.0 / Math.PI;

        public static void Write(JsonWriter w, string key, IOrbit orbit, IOrbitNode node)
        {
            w.BeginObject(key);

            if (orbit == null || !orbit.IsValid)
            {
                // На стартовом столе орбита вырождена. Числовые поля опускаются целиком:
                // NaN не является валидным JSON и уронил бы парсер на стороне MCP.
                w.Bool("valid", false).EndObject();
                return;
            }

            w.Bool("valid", true)
             .Str("type", orbit.OrbitType.ToString())
             .Num("semiMajorAxis", orbit.SemiMajorAxis)
             .Num("semiMinorAxis", orbit.SemiMinorAxis)
             .Num("eccentricity", orbit.Eccentricity)
             .Num("inclination", orbit.Inclination * RadToDeg)
             .Num("longitudeOfAscendingNode", orbit.RightAscensionOfAscendingNode * RadToDeg)
             // TODO(проверить): PeriapsisAngle задокументирован как "periapsis angle";
             // подтвердить, что это аргумент перицентра, а не долгота перицентра.
             .Num("periapsisAngle", orbit.PeriapsisAngle * RadToDeg)
             .Num("trueAnomaly", orbit.TrueAnomaly * RadToDeg)
             .Num("meanAnomaly", orbit.MeanAnomaly * RadToDeg)
             .Num("eccentricAnomaly", orbit.EccentricAnomaly * RadToDeg)
             .Num("periapsis", orbit.Periapsis)
             .Num("apoapsis", orbit.Apoapsis)
             .Num("periapsisDistance", orbit.PeriapsisDistance)
             .Num("apoapsisDistance", orbit.ApoapsisDistance)
             .Num("period", orbit.Period)
             .Num("meanMotion", orbit.MeanMotion)
             .Bool("prograde", orbit.IsPrograde)
             .Num("timeToApoapsis", orbit.GetTimeToApoapsis())
             .Num("timeToPeriapsis", orbit.GetTimeToPeriapsis())
             .Num("timePastPeriapsis", orbit.GetTimePastPeriapsis());

            if (node != null)
                w.Num("sphereOfInfluence", node.SphereOfInfluence);

            w.EndObject();
        }
    }
}
