using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

/// Сборка .sr2-mod из командной строки.
///
/// Mod Builder задуман как окно редактора, но вся работа делается методами
/// Initialize/UpdateAndScanAssemblies/CompleteAndSaveMod; окно лишь собирает
/// параметры и рисует кнопки. Дёргаем их рефлексией — иначе каждая итерация
/// по моду упирается в ручной клик в GUI.
public static class JunoBridgeBuild
{
    private const BindingFlags ALL = BindingFlags.Public | BindingFlags.NonPublic
                                   | BindingFlags.Instance | BindingFlags.Static;

    private const string ModName = "JunoBridge";
    private const string ModAuthor = "JunoBridge";
    private const string ModDescription =
        "HTTP bridge exposing Juno: New Origins telemetry and controls to external tools.";
    private const int VersionMajor = 0;
    private const int VersionMinor = 1;
    private const string TargetPlatform = "MacOS";

    private static readonly StringBuilder Report = new StringBuilder();
    private static Type _windowType;
    private static object _window;

    private static void W(string s) { Report.AppendLine(s); }

    public static void Build()
    {
        try
        {
            // Debug.Log в batchmode тонет среди стеков Unity, поэтому отчёт — в файл.
            W("Unity " + Application.unityVersion);
            if (!Setup()) { Flush(); return; }
            if (!Configure()) { Flush(); return; }
            Save();
        }
        catch (Exception ex) { W("ИСКЛЮЧЕНИЕ ВЕРХНЕГО УРОВНЯ: " + ex); }
        Flush();
    }

    private static bool Setup()
    {
        var asm = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => a.GetName().Name == "ModApi.Editor");
        if (asm == null) { W("ОШИБКА: сборка ModApi.Editor не загружена"); return false; }

        _windowType = asm.GetType("ModApi.Editor.ModBuilderWindow");
        if (_windowType == null) { W("ОШИБКА: тип ModBuilderWindow не найден"); return false; }

        var getWindow = typeof(EditorWindow).GetMethods(ALL)
            .First(m => m.Name == "GetWindow" && m.IsGenericMethod && m.GetParameters().Length == 0);
        _window = getWindow.MakeGenericMethod(_windowType).Invoke(null, null);
        if (_window == null) { W("ОШИБКА: окно не создалось"); return false; }
        W("окно: ok");

        if (!Call("Initialize")) return false;
        W("Initialize: ok");

        // RequiredUnityVersion сверяется в OnGUI и гасит кнопку Save; в batchmode
        // OnGUI не зовётся, так что проверяем сами — иначе получим мод под чужой рантайм.
        var required = Field("RequiredUnityVersion").GetValue(_window) as string;
        bool wrong = (bool)Field("_wrongUnityVersion").GetValue(_window);
        W("RequiredUnityVersion=" + required + " _wrongUnityVersion=" + wrong);
        if (wrong)
        {
            W("ОШИБКА: версия Unity не совпадает с требуемой ModTools. Сборка прервана.");
            return false;
        }
        return true;
    }

    private static bool Configure()
    {
        var data = Prop("Data").GetValue(_window, null);
        if (data == null) { W("ОШИБКА: Data == null после Initialize"); return false; }
        W("Data: " + data.GetType().FullName);

        // _modInWork взводится через StartCreatingMod, но тот пересоздаёт дефолтные
        // ассеты и скрипты — в batchmode это тянет перекомпиляцию посреди сборки.
        // ModData.asset в проекте уже есть, поэтому ставим флаг напрямую.
        var inWork = Field("_modInWork");
        W("_modInWork было " + inWork.GetValue(_window));
        inWork.SetValue(_window, true);

        var dt = data.GetType();
        bool ok = SetField(dt, data, "_name", ModName)
                & SetField(dt, data, "_author", ModAuthor)
                & SetField(dt, data, "_description", ModDescription)
                // ModData хранит только major/minor — patch-компонента версии здесь нет.
                & SetField(dt, data, "_versionMajor", VersionMajor)
                & SetField(dt, data, "_versionMinor", VersionMinor);
        // Пустое имя роняет CompleteAndSaveMod в ValidateModName молча, без исключения.
        if (!ok) { W("ОШИБКА: не все поля ModData удалось выставить."); return false; }

        EditorUtility.SetDirty((UnityEngine.Object)data);
        AssetDatabase.SaveAssets();

        // SerializedObject держит собственную копию полей; без Update он затрёт
        // только что записанные значения при первом же ApplyModifiedProperties.
        var so = Prop("SerializedData").GetValue(_window, null) as SerializedObject;
        if (so != null) { so.Update(); W("SerializedData.Update: ok"); }

        // Те же проверки, что CompleteAndSaveMod делает перед диалогом. Внутри они
        // рапортуют через DisplayDialog (в batchmode он отменяется), но возвращаемое
        // значение честное — по нему и судим. ValidateSteamInfo в оригинале висит под
        // `if (targetPlatform == Steam)`, поэтому для остальных платформ не применяется:
        // пустые Steam-поля не должны валить локальную сборку.
        var checks = TargetPlatform == "Steam"
            ? new[] { "ValidateModName", "ValidateAuthorName", "ValidateVersionNumber", "ValidateSteamInfo" }
            : new[] { "ValidateModName", "ValidateAuthorName", "ValidateVersionNumber" };

        foreach (var check in checks)
        {
            var m = FindOn(dt, check);
            if (m == null) { W("  ПРЕДУПРЕЖДЕНИЕ: проверки " + check + " нет"); continue; }
            var args = m.GetParameters().Length == 1 ? new object[] { false } : null;
            bool passed = (bool)m.Invoke(data, args);
            W("  " + check + ": " + (passed ? "ok" : "ПРОВАЛ"));
            if (!passed) { W("ОШИБКА: валидация ModData не пройдена."); return false; }
        }

        if (!Call("UpdateAndScanAssemblies")) return false;
        var assemblies = Prop("Assemblies", dt).GetValue(data, null) as IEnumerable;
        int n = 0;
        foreach (var a in assemblies) { W("  сборка: " + a); n++; }
        W("UpdateAndScanAssemblies: ok, найдено " + n);
        if (n == 0)
        {
            W("ОШИБКА: ни одной сборки не найдено — мод вышел бы пустым.");
            return false;
        }
        return true;
    }

    /// CompleteAndSaveMod целиком вызвать нельзя: вторым делом он открывает
    /// EditorUtility.SaveFilePanel за целевым путём, а в batchmode диалог
    /// отменяется и метод молча выходит, ничего не собрав. Поэтому повторяем его
    /// тело, подставляя путь напрямую. Порядок шагов снят с IL самого метода
    /// (ikdasm по Jundroo.ModTools.Editor.dll), а не угадан.
    private static void Save()
    {
        var platformType = AppDomain.CurrentDomain.GetAssemblies()
            .First(a => a.GetName().Name == "Jundroo.ModTools.Core")
            .GetType("Jundroo.ModTools.Core.ModTargetPlatform");
        object platform = Enum.Parse(platformType, TargetPlatform);

        var getExt = Method("GetModFileExtension", 1);
        string ext = (string)getExt.Invoke(_window, new object[] { platform });
        W("расширение: ." + ext);

        string dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Library/Application Support/com.jundroo.SimpleRockets2/Mods");
        Directory.CreateDirectory(dir);
        Field("_currentSaveDirectory").SetValue(_window, dir);

        string targetPath = Path.Combine(dir, ModName + "." + ext);
        W("целевой файл: " + targetPath);

        if (!Call("OnCompleteAndSaveStarted")) return;
        Field("_buildId").SetValue(_window, Guid.NewGuid());

        // Соответствие платформа → BuildTarget взято из switch в CompleteAndSaveMod.
        BuildTarget[] targets;
        switch (TargetPlatform)
        {
            case "Windows": targets = new[] { BuildTarget.StandaloneWindows64 }; break;
            case "MacOS": targets = new[] { BuildTarget.StandaloneOSX }; break;
            case "Linux": targets = new[] { BuildTarget.StandaloneLinux64 }; break;
            case "Android": targets = new[] { BuildTarget.Android }; break;
            default: targets = new[] { BuildTarget.StandaloneWindows64, BuildTarget.StandaloneOSX }; break;
        }
        W("BuildTarget: " + string.Join(", ", targets.Select(t => t.ToString()).ToArray()));

        string bundlePath = Path.Combine("ModAssetBundles", ModName + "." + ext);
        bool bundled;
        try
        {
            bundled = (bool)Method("BuildAssetBundles", 3)
                .Invoke(_window, new object[] { bundlePath, targets, false });
        }
        catch (Exception ex)
        {
            var e = ex.InnerException ?? ex;
            W("BuildAssetBundles УПАЛ: " + e.GetType().Name + ": " + e.Message);
            W(e.StackTrace);
            return;
        }
        if (!bundled) { W("ОШИБКА: BuildAssetBundles вернул false."); return; }
        W("BuildAssetBundles: ok → " + bundlePath);

        try
        {
            Method("SaveMod", 3).Invoke(_window, new object[] { bundlePath, targetPath, platform });
            W("SaveMod: ok");
        }
        catch (Exception ex)
        {
            var e = ex.InnerException ?? ex;
            W("SaveMod УПАЛ: " + e.GetType().Name + ": " + e.Message);
            W(e.StackTrace);
            return;
        }

        // Рядом с модом кладётся *-info с именем мода. Расширение для него игра
        // берёт от платформы Standalone независимо от целевой — так в оригинале.
        string infoExt = (string)getExt.Invoke(_window,
            new object[] { Enum.Parse(platformType, "Standalone") }) + "-info";
        string infoPath = targetPath.Remove(targetPath.LastIndexOf('.') + 1) + infoExt;
        File.WriteAllText(infoPath, ModName);
        W("info-файл: " + infoPath);

        // Единственный надёжный признак успеха — файл на диске: валидации внутри
        // ModTools выходят через DisplayDialog, который в batchmode просто отменяется.
        foreach (var f in Directory.GetFiles(dir))
            W("в каталоге: " + Path.GetFileName(f) + "  " + new FileInfo(f).Length + " байт");

        var built = Directory.GetFiles(dir, "*." + ext);
        if (built.Length == 0) W("ПРОВАЛ: ." + ext + " не создан.");
        else W("УСПЕХ: " + built[0] + " (" + new FileInfo(built[0]).Length + " байт)");
    }

    // --- рефлексия ---

    private static FieldInfo Field(string name)
    {
        for (var t = _windowType; t != null; t = t.BaseType)
        {
            var f = t.GetField(name, ALL);
            if (f != null) return f;
        }
        throw new MissingFieldException(_windowType.Name + "." + name);
    }

    private static PropertyInfo Prop(string name, Type from = null)
    {
        for (var t = from ?? _windowType; t != null; t = t.BaseType)
        {
            var p = t.GetProperty(name, ALL);
            if (p != null) return p;
        }
        throw new MissingMemberException((from ?? _windowType).Name + "." + name);
    }

    /// Перегрузки различаем по числу аргументов: у SaveProjectAssemblies и
    /// UpdateAndScanAssemblies есть одноимённые варианты с разной арностью.
    private static MethodInfo Method(string name, int argc)
    {
        for (var t = _windowType; t != null; t = t.BaseType)
        {
            var m = t.GetMethods(ALL).FirstOrDefault(
                x => x.Name == name && x.DeclaringType == t && x.GetParameters().Length == argc);
            if (m != null) return m;
        }
        throw new MissingMethodException(_windowType.Name + "." + name + "/" + argc);
    }

    private static MethodInfo FindOn(Type type, string name)
    {
        for (var t = type; t != null; t = t.BaseType)
        {
            var m = t.GetMethods(ALL).FirstOrDefault(x => x.Name == name && x.DeclaringType == t);
            if (m != null) return m;
        }
        return null;
    }

    private static bool Call(string name)
    {
        MethodInfo m = null;
        for (var t = _windowType; t != null && m == null; t = t.BaseType)
            m = t.GetMethods(ALL).FirstOrDefault(
                x => x.Name == name && x.DeclaringType == t && x.GetParameters().Length == 0);
        if (m == null) { W("ОШИБКА: метод " + name + "() не найден"); return false; }
        try { m.Invoke(_window, null); return true; }
        catch (Exception ex)
        {
            var e = ex.InnerException ?? ex;
            W(name + " УПАЛ: " + e.GetType().Name + ": " + e.Message);
            W(e.StackTrace);
            return false;
        }
    }

    /// Поля ModData объявлены в ModDataBase, а GetField не заглядывает в базовые
    /// типы за приватными полями — обходим иерархию руками.
    private static bool SetField(Type t, object target, string name, object value)
    {
        for (var cur = t; cur != null; cur = cur.BaseType)
        {
            var f = cur.GetField(name, ALL);
            if (f == null) continue;
            f.SetValue(target, value);
            W("  " + name + " = " + value);
            return true;
        }
        W("  ОШИБКА: поля " + name + " нет ни в " + t.Name + ", ни в базовых типах");
        return false;
    }

    private static void Flush()
    {
        File.WriteAllText("/tmp/junobridge-build.txt", Report.ToString());
    }
}
