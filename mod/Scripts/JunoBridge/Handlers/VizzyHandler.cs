using System;
using System.Xml.Linq;
using Assets.Scripts.Craft.Parts.Modifiers;
using JunoBridge.Core;
using JunoBridge.Json;
using JunoBridge.Net;
using ModApi.Craft.Program;

namespace JunoBridge.Handlers
{
    internal static class VizzyHandler
    {
        public static BridgeResponse Get(int partId)
        {
            var part = GameContext.FindPart(partId);
            if (part == null) return Errors.UnknownPart(partId);

            var program = part.GetModifier<FlightProgramData>();
            if (program == null)
                return BridgeResponse.Error(409, "no_flight_program", "Part " + partId + " has no flight program modifier.");

            var xml = program.FlightProgramXml;
            string text = xml == null ? null : xml.ToString();

            var w = new JsonWriter(text == null ? 256 : text.Length + 256);
            w.BeginObject()
             .Num("partId", partId)
             .Str("partName", part.Name)
             .Str("xml", text)
             .Num("sizeBytes", text == null ? 0 : System.Text.Encoding.UTF8.GetByteCount(text))
             .Bool("outputToDevConsole", program.OutputToDevConsole)
             .EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        public static BridgeResponse Put(int partId, BridgeRequest request)
        {
            // In flight the program is already compiled into a running process, and writing
            // FlightProgramXml will not replace it. Authoring is a designer operation.
            if (!GameContext.InDesigner)
                return BridgeResponse.Error(409, "requires_designer",
                    "Vizzy programs can only be written in the designer; launch afterwards.");

            var part = GameContext.FindPart(partId);
            if (part == null) return Errors.UnknownPart(partId);

            var program = part.GetModifier<FlightProgramData>();
            if (program == null)
                return BridgeResponse.Error(409, "no_flight_program", "Part " + partId + " has no flight program modifier.");

            JsonValue body;
            if (!JsonLite.TryParse(request.Body, out body) || body.Kind != JsonKind.Object)
                return Errors.BadBody("Expected a JSON object.");

            string xmlText = body.Has("xml") ? body["xml"].AsString() : null;
            if (string.IsNullOrEmpty(xmlText)) return Errors.BadBody("Field 'xml' is required.");

            XElement element;
            try
            {
                element = XElement.Parse(xmlText);
            }
            catch (Exception ex)
            {
                return BridgeResponse.Error(400, "invalid_xml", ex.Message);
            }

            // Run it through the stock deserializer before writing: better to refuse here than
            // to put garbage into the craft and blow up at load time.
            string programError;
            if (!TryValidateProgram(element, out programError))
                return BridgeResponse.Error(400, "invalid_program", programError);

            program.FlightProgramXml = element;

            try
            {
                var designer = GameContext.Game.Designer;
                if (designer != null && designer.CraftScript != null)
                    designer.CraftScript.RaiseDesignerCraftStructureChangedEvent();
            }
            catch (Exception ex)
            {
                EventLog.Record(EventKind.Exception, "designer refresh after vizzy write: " + ex);
            }

            var w = new JsonWriter(160);
            w.BeginObject()
             .Num("partId", partId)
             .Num("sizeBytes", System.Text.Encoding.UTF8.GetByteCount(xmlText))
             .Bool("written", true)
             .EndObject();
            return BridgeResponse.Ok(w.ToString());
        }

        /// Via reflection: the XML docs do not say whether DeserializeFlightProgram is static
        /// or an instance method, and a miss here is a compile error for the whole mod.
        /// TODO(verify): determine the call shape and replace this with a direct call.
        private static bool TryValidateProgram(XElement element, out string error)
        {
            error = null;
            try
            {
                var type = typeof(ProgramSerializer);
                var method = type.GetMethod("DeserializeFlightProgram",
                    System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static |
                    System.Reflection.BindingFlags.Instance,
                    null, new[] { typeof(XElement) }, null);

                if (method == null)
                {
                    EventLog.Record(EventKind.Log, "Vizzy program validation skipped: serializer entry point not found.");
                    return true;
                }

                object target = method.IsStatic ? null : Activator.CreateInstance(type);
                method.Invoke(target, new object[] { element });
                return true;
            }
            catch (System.Reflection.TargetInvocationException ex)
            {
                var inner = ex.InnerException ?? ex;
                error = inner.GetType().Name + ": " + inner.Message;
                return false;
            }
            catch (Exception ex)
            {
                // We could not even reach the validator — not a reason to reject the program.
                EventLog.Record(EventKind.Exception, "Vizzy program validation unavailable: " + ex.Message);
                return true;
            }
        }
    }
}
