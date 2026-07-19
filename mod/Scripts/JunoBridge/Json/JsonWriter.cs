using System;
using System.Globalization;
using System.Text;

namespace JunoBridge.Json
{
    /// Newtonsoft.Json нет в наборе ссылок ModTools, поэтому сериализатор свой.
    /// Пишем только вперёд, без промежуточного дерева объектов.
    internal sealed class JsonWriter
    {
        private readonly StringBuilder _sb;
        private bool _needComma;

        public JsonWriter() : this(1024)
        {
        }

        public JsonWriter(int capacity)
        {
            _sb = new StringBuilder(capacity);
        }

        public JsonWriter BeginObject()
        {
            Separator();
            _sb.Append('{');
            _needComma = false;
            return this;
        }

        public JsonWriter BeginObject(string key)
        {
            WriteKey(key);
            _sb.Append('{');
            _needComma = false;
            return this;
        }

        public JsonWriter EndObject()
        {
            _sb.Append('}');
            _needComma = true;
            return this;
        }

        public JsonWriter BeginArray()
        {
            Separator();
            _sb.Append('[');
            _needComma = false;
            return this;
        }

        public JsonWriter BeginArray(string key)
        {
            WriteKey(key);
            _sb.Append('[');
            _needComma = false;
            return this;
        }

        public JsonWriter EndArray()
        {
            _sb.Append(']');
            _needComma = true;
            return this;
        }

        public JsonWriter Str(string key, string value)
        {
            if (value == null) return Null(key);
            WriteKey(key);
            WriteEscaped(value);
            _needComma = true;
            return this;
        }

        public JsonWriter Str(string value)
        {
            if (value == null) return NullValue();
            Separator();
            WriteEscaped(value);
            _needComma = true;
            return this;
        }

        /// NaN и Infinity не являются валидным JSON и роняют парсер на стороне MCP,
        /// поэтому вырождаются в null.
        public JsonWriter Num(string key, double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return Null(key);
            WriteKey(key);
            _sb.Append(value.ToString("R", CultureInfo.InvariantCulture));
            _needComma = true;
            return this;
        }

        public JsonWriter Num(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return NullValue();
            Separator();
            _sb.Append(value.ToString("R", CultureInfo.InvariantCulture));
            _needComma = true;
            return this;
        }

        public JsonWriter Num(string key, float value)
        {
            return Num(key, (double)value);
        }

        public JsonWriter Num(string key, int value)
        {
            WriteKey(key);
            _sb.Append(value.ToString(CultureInfo.InvariantCulture));
            _needComma = true;
            return this;
        }

        public JsonWriter Num(int value)
        {
            Separator();
            _sb.Append(value.ToString(CultureInfo.InvariantCulture));
            _needComma = true;
            return this;
        }

        public JsonWriter Num(string key, long value)
        {
            WriteKey(key);
            _sb.Append(value.ToString(CultureInfo.InvariantCulture));
            _needComma = true;
            return this;
        }

        public JsonWriter Bool(string key, bool value)
        {
            WriteKey(key);
            _sb.Append(value ? "true" : "false");
            _needComma = true;
            return this;
        }

        public JsonWriter Bool(bool value)
        {
            Separator();
            _sb.Append(value ? "true" : "false");
            _needComma = true;
            return this;
        }

        public JsonWriter Null(string key)
        {
            WriteKey(key);
            _sb.Append("null");
            _needComma = true;
            return this;
        }

        public JsonWriter NullValue()
        {
            Separator();
            _sb.Append("null");
            _needComma = true;
            return this;
        }

        /// Вставка уже сериализованного фрагмента. Вызывающая сторона отвечает за валидность.
        public JsonWriter Raw(string key, string json)
        {
            if (string.IsNullOrEmpty(json)) return Null(key);
            WriteKey(key);
            _sb.Append(json);
            _needComma = true;
            return this;
        }

        public JsonWriter Vec(string key, UnityEngine.Vector3 v)
        {
            BeginArray(key);
            Num(v.x);
            Num(v.y);
            Num(v.z);
            return EndArray();
        }

        public JsonWriter Vec(string key, UnityEngine.Vector3d v)
        {
            BeginArray(key);
            Num(v.x);
            Num(v.y);
            Num(v.z);
            return EndArray();
        }

        public override string ToString()
        {
            return _sb.ToString();
        }

        private void WriteKey(string key)
        {
            Separator();
            WriteEscaped(key);
            _sb.Append(':');
            _needComma = false;
        }

        private void Separator()
        {
            if (_needComma) _sb.Append(',');
        }

        private void WriteEscaped(string value)
        {
            _sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': _sb.Append("\\\""); break;
                    case '\\': _sb.Append("\\\\"); break;
                    case '\b': _sb.Append("\\b"); break;
                    case '\f': _sb.Append("\\f"); break;
                    case '\n': _sb.Append("\\n"); break;
                    case '\r': _sb.Append("\\r"); break;
                    case '\t': _sb.Append("\\t"); break;
                    default:
                        // U+2028/U+2029 ломают JSON, встроенный в JS-контекст на стороне MCP.
                        if (c < ' ' || c == '\u2028' || c == '\u2029')
                            _sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else
                            _sb.Append(c);
                        break;
                }
            }
            _sb.Append('"');
        }
    }
}
