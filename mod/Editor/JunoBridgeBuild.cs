using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

/// Builds the .sr2-mod from the command line.
///
/// Mod Builder is meant to be an editor window, but all the work is done by the
/// Initialize/UpdateAndScanAssemblies/CompleteAndSaveMod methods; the window only
/// collects parameters and draws buttons. We poke them via reflection — otherwise
/// every mod iteration is gated on a manual click in the GUI.
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
            // Debug.Log in batchmode drowns among Unity stack traces, so the report goes to a file.
            W("Unity " + Application.unityVersion);
            if (!Setup()) { Flush(); return; }
            if (!Configure()) { Flush(); return; }
            Save();
        }
        catch (Exception ex) { W("TOP-LEVEL EXCEPTION: " + ex); }
        Flush();
    }

    private static bool Setup()
    {
        var asm = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => a.GetName().Name == "ModApi.Editor");
        if (asm == null) { W("ERROR: the ModApi.Editor assembly is not loaded"); return false; }

        _windowType = asm.GetType("ModApi.Editor.ModBuilderWindow");
        if (_windowType == null) { W("ERROR: the ModBuilderWindow type was not found"); return false; }

        var getWindow = typeof(EditorWindow).GetMethods(ALL)
            .First(m => m.Name == "GetWindow" && m.IsGenericMethod && m.GetParameters().Length == 0);
        _window = getWindow.MakeGenericMethod(_windowType).Invoke(null, null);
        if (_window == null) { W("ERROR: the window was not created"); return false; }
        W("window: ok");

        if (!Call("Initialize")) return false;
        W("Initialize: ok");

        // RequiredUnityVersion is checked in OnGUI and disables the Save button; in batchmode
        // OnGUI is never called, so we check it ourselves — otherwise we get a mod built
        // against the wrong runtime.
        var required = Field("RequiredUnityVersion").GetValue(_window) as string;
        bool wrong = (bool)Field("_wrongUnityVersion").GetValue(_window);
        W("RequiredUnityVersion=" + required + " _wrongUnityVersion=" + wrong);
        if (wrong)
        {
            W("ERROR: the Unity version does not match the one ModTools requires. Build aborted.");
            return false;
        }
        return true;
    }

    private static bool Configure()
    {
        var data = Prop("Data").GetValue(_window, null);
        if (data == null) { W("ERROR: Data == null after Initialize"); return false; }
        W("Data: " + data.GetType().FullName);

        // _modInWork is normally set through StartCreatingMod, but that recreates the default
        // assets and scripts — in batchmode this drags a recompile into the middle of the build.
        // ModData.asset already exists in the project, so we set the flag directly.
        var inWork = Field("_modInWork");
        W("_modInWork was " + inWork.GetValue(_window));
        inWork.SetValue(_window, true);

        var dt = data.GetType();
        bool ok = SetField(dt, data, "_name", ModName)
                & SetField(dt, data, "_author", ModAuthor)
                & SetField(dt, data, "_description", ModDescription)
                // ModData stores only major/minor — there is no patch component of the version here.
                & SetField(dt, data, "_versionMajor", VersionMajor)
                & SetField(dt, data, "_versionMinor", VersionMinor);
        // An empty name makes CompleteAndSaveMod fail in ValidateModName silently, without an exception.
        if (!ok) { W("ERROR: not all ModData fields could be set."); return false; }

        EditorUtility.SetDirty((UnityEngine.Object)data);
        AssetDatabase.SaveAssets();

        // SerializedObject keeps its own copy of the fields; without Update it would overwrite
        // the values we just wrote on the very first ApplyModifiedProperties.
        var so = Prop("SerializedData").GetValue(_window, null) as SerializedObject;
        if (so != null) { so.Update(); W("SerializedData.Update: ok"); }

        // The same checks CompleteAndSaveMod runs before the dialog. Internally they report
        // through DisplayDialog (which is cancelled in batchmode), but the return value is
        // honest — that is what we judge by. In the original, ValidateSteamInfo sits under
        // `if (targetPlatform == Steam)` and so does not apply to other platforms: empty
        // Steam fields must not fail a local build.
        var checks = TargetPlatform == "Steam"
            ? new[] { "ValidateModName", "ValidateAuthorName", "ValidateVersionNumber", "ValidateSteamInfo" }
            : new[] { "ValidateModName", "ValidateAuthorName", "ValidateVersionNumber" };

        foreach (var check in checks)
        {
            var m = FindOn(dt, check);
            if (m == null) { W("  WARNING: check " + check + " does not exist"); continue; }
            var args = m.GetParameters().Length == 1 ? new object[] { false } : null;
            bool passed = (bool)m.Invoke(data, args);
            W("  " + check + ": " + (passed ? "ok" : "FAILED"));
            if (!passed) { W("ERROR: ModData validation did not pass."); return false; }
        }

        if (!Call("UpdateAndScanAssemblies")) return false;
        var assemblies = Prop("Assemblies", dt).GetValue(data, null) as IEnumerable;
        int n = 0;
        foreach (var a in assemblies) { W("  assembly: " + a); n++; }
        W("UpdateAndScanAssemblies: ok, found " + n);
        if (n == 0)
        {
            W("ERROR: no assemblies found — the mod would come out empty.");
            return false;
        }
        return true;
    }

    /// CompleteAndSaveMod cannot be called as a whole: the second thing it does is open
    /// EditorUtility.SaveFilePanel for the target path, and in batchmode the dialog is
    /// cancelled and the method silently returns having built nothing. So we replay its
    /// body, supplying the path directly. The order of the steps was read off the IL of
    /// the method itself (ikdasm on Jundroo.ModTools.Editor.dll), not guessed.
    private static void Save()
    {
        var platformType = AppDomain.CurrentDomain.GetAssemblies()
            .First(a => a.GetName().Name == "Jundroo.ModTools.Core")
            .GetType("Jundroo.ModTools.Core.ModTargetPlatform");
        object platform = Enum.Parse(platformType, TargetPlatform);

        var getExt = Method("GetModFileExtension", 1);
        string ext = (string)getExt.Invoke(_window, new object[] { platform });
        W("extension: ." + ext);

        string dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Library/Application Support/com.jundroo.SimpleRockets2/Mods");
        Directory.CreateDirectory(dir);
        Field("_currentSaveDirectory").SetValue(_window, dir);

        string targetPath = Path.Combine(dir, ModName + "." + ext);
        W("target file: " + targetPath);

        if (!Call("OnCompleteAndSaveStarted")) return;
        Field("_buildId").SetValue(_window, Guid.NewGuid());

        // The platform → BuildTarget mapping is taken from the switch in CompleteAndSaveMod.
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
            W("BuildAssetBundles THREW: " + e.GetType().Name + ": " + e.Message);
            W(e.StackTrace);
            return;
        }
        if (!bundled) { W("ERROR: BuildAssetBundles returned false."); return; }
        W("BuildAssetBundles: ok → " + bundlePath);

        try
        {
            Method("SaveMod", 3).Invoke(_window, new object[] { bundlePath, targetPath, platform });
            W("SaveMod: ok");
        }
        catch (Exception ex)
        {
            var e = ex.InnerException ?? ex;
            W("SaveMod THREW: " + e.GetType().Name + ": " + e.Message);
            W(e.StackTrace);
            return;
        }

        // A *-info file holding the mod name is placed next to the mod. The game takes its
        // extension from the Standalone platform regardless of the target — as in the original.
        string infoExt = (string)getExt.Invoke(_window,
            new object[] { Enum.Parse(platformType, "Standalone") }) + "-info";
        string infoPath = targetPath.Remove(targetPath.LastIndexOf('.') + 1) + infoExt;
        File.WriteAllText(infoPath, ModName);
        W("info file: " + infoPath);

        // The only reliable sign of success is the file on disk: validations inside ModTools
        // report through DisplayDialog, which in batchmode is simply cancelled.
        foreach (var f in Directory.GetFiles(dir))
            W("in directory: " + Path.GetFileName(f) + "  " + new FileInfo(f).Length + " bytes");

        var built = Directory.GetFiles(dir, "*." + ext);
        if (built.Length == 0) W("FAILED: ." + ext + " was not created.");
        else W("SUCCESS: " + built[0] + " (" + new FileInfo(built[0]).Length + " bytes)");
    }

    // --- reflection ---

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

    /// Overloads are distinguished by argument count: SaveProjectAssemblies and
    /// UpdateAndScanAssemblies each have same-named variants with different arity.
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
        if (m == null) { W("ERROR: method " + name + "() not found"); return false; }
        try { m.Invoke(_window, null); return true; }
        catch (Exception ex)
        {
            var e = ex.InnerException ?? ex;
            W(name + " THREW: " + e.GetType().Name + ": " + e.Message);
            W(e.StackTrace);
            return false;
        }
    }

    /// ModData's fields are declared in ModDataBase, and GetField does not look into base
    /// types for private fields — so we walk the hierarchy by hand.
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
        W("  ERROR: field " + name + " exists neither in " + t.Name + " nor in its base types");
        return false;
    }

    private static void Flush()
    {
        File.WriteAllText("/tmp/junobridge-build.txt", Report.ToString());
    }
}
