using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace JunoBridge.Json
{
    internal enum JsonKind
    {
        Null,
        Bool,
        Number,
        String,
        Array,
        Object
    }

    /// Минимальный рекурсивный парсер. Тела запросов моста плоские и небольшие,
    /// поэтому дерево из словарей дешевле, чем тянуть внешнюю библиотеку.
    internal sealed class JsonValue
    {
        public JsonKind Kind;
        public bool BoolValue;
        public double NumberValue;
        public string StringValue;
        public List<JsonValue> Items;
        public Dictionary<string, JsonValue> Members;

        public static readonly JsonValue Null = new JsonValue { Kind = JsonKind.Null };

        public bool IsNull
        {
            get { return Kind == JsonKind.Null; }
        }

        public JsonValue this[string key]
        {
            get
            {
                JsonValue v;
                if (Kind == JsonKind.Object && Members != null && Members.TryGetValue(key, out v))
                    return v;
                return null;
            }
        }

        public bool Has(string key)
        {
            return Kind == JsonKind.Object && Members != null && Members.ContainsKey(key);
        }

        public string AsString(string fallback = null)
        {
            if (Kind == JsonKind.String) return StringValue;
            if (Kind == JsonKind.Number) return NumberValue.ToString("R", CultureInfo.InvariantCulture);
            if (Kind == JsonKind.Bool) return BoolValue ? "true" : "false";
            return fallback;
        }

        public double AsDouble(double fallback = 0.0)
        {
            if (Kind == JsonKind.Number) return NumberValue;
            if (Kind == JsonKind.String)
            {
                double d;
                if (double.TryParse(StringValue, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
            }
            return fallback;
        }

        public int AsInt(int fallback = 0)
        {
            if (Kind == JsonKind.Number) return (int)Math.Round(NumberValue);
            if (Kind == JsonKind.String)
            {
                int i;
                if (int.TryParse(StringValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out i)) return i;
            }
            return fallback;
        }

        public bool AsBool(bool fallback = false)
        {
            if (Kind == JsonKind.Bool) return BoolValue;
            if (Kind == JsonKind.Number) return Math.Abs(NumberValue) > double.Epsilon;
            if (Kind == JsonKind.String) return string.Equals(StringValue, "true", StringComparison.OrdinalIgnoreCase);
            return fallback;
        }
    }

    internal static class JsonLite
    {
        public static JsonValue Parse(string text)
        {
            if (string.IsNullOrEmpty(text)) return JsonValue.Null;
            int pos = 0;
            var value = ParseValue(text, ref pos);
            SkipWhitespace(text, ref pos);
            if (pos != text.Length)
                throw new FormatException("Trailing content at offset " + pos + ".");
            return value;
        }

        public static bool TryParse(string text, out JsonValue value)
        {
            try
            {
                value = Parse(text);
                return true;
            }
            catch (Exception)
            {
                value = JsonValue.Null;
                return false;
            }
        }

        private static JsonValue ParseValue(string s, ref int pos)
        {
            SkipWhitespace(s, ref pos);
            if (pos >= s.Length) throw new FormatException("Unexpected end of input.");

            char c = s[pos];
            switch (c)
            {
                case '{': return ParseObject(s, ref pos);
                case '[': return ParseArray(s, ref pos);
                case '"': return new JsonValue { Kind = JsonKind.String, StringValue = ParseString(s, ref pos) };
                case 't': Expect(s, ref pos, "true"); return new JsonValue { Kind = JsonKind.Bool, BoolValue = true };
                case 'f': Expect(s, ref pos, "false"); return new JsonValue { Kind = JsonKind.Bool, BoolValue = false };
                case 'n': Expect(s, ref pos, "null"); return JsonValue.Null;
                default: return ParseNumber(s, ref pos);
            }
        }

        private static JsonValue ParseObject(string s, ref int pos)
        {
            pos++; // '{'
            var result = new JsonValue { Kind = JsonKind.Object, Members = new Dictionary<string, JsonValue>(StringComparer.Ordinal) };
            SkipWhitespace(s, ref pos);
            if (pos < s.Length && s[pos] == '}') { pos++; return result; }

            while (true)
            {
                SkipWhitespace(s, ref pos);
                if (pos >= s.Length || s[pos] != '"') throw new FormatException("Expected object key at offset " + pos + ".");
                string key = ParseString(s, ref pos);
                SkipWhitespace(s, ref pos);
                if (pos >= s.Length || s[pos] != ':') throw new FormatException("Expected ':' at offset " + pos + ".");
                pos++;
                result.Members[key] = ParseValue(s, ref pos);
                SkipWhitespace(s, ref pos);
                if (pos >= s.Length) throw new FormatException("Unterminated object.");
                if (s[pos] == ',') { pos++; continue; }
                if (s[pos] == '}') { pos++; return result; }
                throw new FormatException("Expected ',' or '}' at offset " + pos + ".");
            }
        }

        private static JsonValue ParseArray(string s, ref int pos)
        {
            pos++; // '['
            var result = new JsonValue { Kind = JsonKind.Array, Items = new List<JsonValue>() };
            SkipWhitespace(s, ref pos);
            if (pos < s.Length && s[pos] == ']') { pos++; return result; }

            while (true)
            {
                result.Items.Add(ParseValue(s, ref pos));
                SkipWhitespace(s, ref pos);
                if (pos >= s.Length) throw new FormatException("Unterminated array.");
                if (s[pos] == ',') { pos++; continue; }
                if (s[pos] == ']') { pos++; return result; }
                throw new FormatException("Expected ',' or ']' at offset " + pos + ".");
            }
        }

        private static string ParseString(string s, ref int pos)
        {
            pos++; // '"'
            var sb = new StringBuilder();
            while (pos < s.Length)
            {
                char c = s[pos++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }

                if (pos >= s.Length) break;
                char e = s[pos++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (pos + 4 > s.Length) throw new FormatException("Truncated \\u escape.");
                        sb.Append((char)ushort.Parse(s.Substring(pos, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        pos += 4;
                        break;
                    default: throw new FormatException("Unknown escape '\\" + e + "'.");
                }
            }
            throw new FormatException("Unterminated string.");
        }

        private static JsonValue ParseNumber(string s, ref int pos)
        {
            int start = pos;
            if (pos < s.Length && (s[pos] == '-' || s[pos] == '+')) pos++;
            while (pos < s.Length)
            {
                char c = s[pos];
                if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') pos++;
                else break;
            }

            double value;
            if (!double.TryParse(s.Substring(start, pos - start), NumberStyles.Float, CultureInfo.InvariantCulture, out value))
                throw new FormatException("Invalid number at offset " + start + ".");
            return new JsonValue { Kind = JsonKind.Number, NumberValue = value };
        }

        private static void Expect(string s, ref int pos, string literal)
        {
            if (pos + literal.Length > s.Length || string.CompareOrdinal(s, pos, literal, 0, literal.Length) != 0)
                throw new FormatException("Expected '" + literal + "' at offset " + pos + ".");
            pos += literal.Length;
        }

        private static void SkipWhitespace(string s, ref int pos)
        {
            while (pos < s.Length)
            {
                char c = s[pos];
                if (c == ' ' || c == '\t' || c == '\r' || c == '\n') pos++;
                else break;
            }
        }
    }
}
