using System;
using JunoBridge.Json;
using ModApi.Craft;
using ModApi.Craft.Parts;

namespace JunoBridge.Serialization
{
    internal static class CraftSerializer
    {
        public static void WriteNodeSummary(JsonWriter w, ICraftNode node)
        {
            w.BeginObject()
             .Num("nodeId", node.NodeId)
             .Str("name", node.Name)
             .Bool("isPlayer", node.IsPlayer)
             .Bool("hasCommandPod", node.HasCommandPod)
             .Bool("allowPlayerControl", node.AllowPlayerControl)
             .Num("partCount", node.CraftPartCount)
             .Num("mass", node.CraftMass)
             .Num("altitudeAsl", node.Altitude)
             .Num("altitudeAgl", node.AltitudeAgl)
             .Num("heading", node.Heading)
             .EndObject();
        }

        public static void WritePart(JsonWriter w, PartData part, bool includeModifiers)
        {
            w.BeginObject()
             .Num("partId", part.Id)
             .Str("name", part.Name)
             .Str("partType", part.PartType == null ? null : part.PartType.Id)
             .Str("partTypeName", part.PartType == null ? null : part.PartType.Name)
             .Num("activationStage", part.ActivationStage)
             .Num("activationGroup", part.ActivationGroup)
             .Bool("activated", part.Activated)
             .Bool("enabled", part.Enabled)
             .Bool("destroyed", part.IsDestroyed)
             .Bool("isRootPart", part.IsRootPart)
             .Num("mass", part.Mass)
             .Num("damage", part.Damage)
             .Num("price", part.Price)
             .Num("groupId", part.GroupId)
             .Vec("position", part.Position);

            if (includeModifiers)
            {
                w.BeginArray("modifiers");
                if (part.Modifiers != null)
                    foreach (var modifier in part.Modifiers)
                    {
                        if (modifier == null) continue;
                        w.BeginObject()
                         .Str("clrType", modifier.GetType().Name)
                         .Str("typeId", modifier.TypeId)
                         .Str("id", modifier.Id)
                         .Str("name", modifier.Name)
                         .Num("mass", modifier.Mass)
                         .EndObject();
                    }
                w.EndArray();
            }

            w.EndObject();
        }
    }
}
