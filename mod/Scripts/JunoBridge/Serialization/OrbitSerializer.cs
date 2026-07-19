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
                // On the launch pad the orbit is degenerate. The numeric fields are omitted
                // entirely: NaN is not valid JSON and would break the parser on the MCP side.
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
             // TODO(verify): PeriapsisAngle is documented as "periapsis angle"; confirm that
             // it is the argument of periapsis and not the longitude of periapsis.
             .Num("periapsisAngle", orbit.PeriapsisAngle * RadToDeg)
             .Num("trueAnomaly", orbit.TrueAnomaly * RadToDeg)
             .Num("meanAnomaly", orbit.MeanAnomaly * RadToDeg)
             .Num("eccentricAnomaly", orbit.EccentricAnomaly * RadToDeg)
             // IOrbit.Periapsis/Apoapsis are the apsides' position vectors, not distances;
             // the scalars are below as *Distance. Named with a Vector suffix to avoid confusion.
             .Vec("periapsisVector", orbit.Periapsis)
             .Vec("apoapsisVector", orbit.Apoapsis)
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
