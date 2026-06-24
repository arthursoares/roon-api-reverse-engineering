using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Collections.Generic;
using System.Text.Json;

class Oracle {
    static MetadataLoadContext Mlc(string mb) {
        var byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string tpa = (string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES");
        foreach (var p in tpa.Split(Path.PathSeparator))
            byName[Path.GetFileNameWithoutExtension(p)] = p;
        foreach (var p in Directory.GetFiles(mb, "*.dll")) {
            var n = Path.GetFileNameWithoutExtension(p);
            if (!byName.ContainsKey(n)) byName[n] = p;
        }
        return new MetadataLoadContext(new PathAssemblyResolver(byName.Values));
    }

    static readonly Dictionary<string,string> Kw = new(StringComparer.Ordinal) {
        {"System.Boolean","bool"},{"System.Int32","int"},{"System.Int64","long"},
        {"System.Double","double"},{"System.Single","float"},{"System.String","string"},
        {"System.Char","char"},{"System.Object","object"},{"System.Void","void"},
        {"System.Int16","short"},{"System.UInt32","uint"},{"System.UInt64","ulong"},
    };
    static string TypeName(Type t) {
        if (t.IsGenericParameter) return t.Name;
        if (t.IsArray) return TypeName(t.GetElementType()) + "[]";
        if (t.IsGenericType && t.GetGenericTypeDefinition().FullName == "System.Nullable`1")
            return TypeName(t.GetGenericArguments()[0]) + "?";
        if (t.IsGenericType) {
            var def = t.GetGenericTypeDefinition().FullName;
            int tick = def.IndexOf('`'); if (tick >= 0) def = def.Substring(0, tick);
            var args = string.Join(", ", t.GetGenericArguments().Select(TypeName));
            return $"{def}<{args}>";
        }
        var fn = t.FullName ?? t.Name;
        return Kw.TryGetValue(fn, out var k) ? k : fn;
    }

    static bool IsSooid(Type t) => (t.FullName ?? "").EndsWith("Sooid");

    // PropertyType enum int (must match src/proto/objects.ts).
    // Int0 Long1 Bool2 Guid3 Sooid4 Double5 Float6 Char7 DateTime8 Enum9
    // Nullable*=base+10 (10..19). String20 ByteArray21 Message22 Object23 LengthPrefixed24
    static int PropTypeOf(Type t) {
        if (t.IsGenericType && t.GetGenericTypeDefinition().FullName == "System.Nullable`1") {
            int b = PropTypeOf(t.GetGenericArguments()[0]);
            return b <= 9 ? b + 10 : b;
        }
        if (t.IsEnum) return 9;
        switch (t.FullName) {
            case "System.Int32": return 0;
            case "System.Int64": return 1;
            case "System.Boolean": return 2;
            case "System.Guid": return 3;
            case "System.Double": return 5;
            case "System.Single": return 6;
            case "System.Char": return 7;
            case "System.DateTime": return 8;
            case "System.String": return 20;
        }
        if (IsSooid(t)) return 4;
        if (t.IsArray && t.GetElementType().FullName == "System.Byte") return 21;
        if (t.GetInterfaces().Any(i => i.Name == "IMessage")) return 22;
        return 23; // objects, collections, custom value types (refine via capture if needed)
    }

    // Argument kind for codegen arg-building.
    static string ParamKind(Type t, Dictionary<string,string> kinds) {
        if (t.Name.StartsWith("ResultCallback") || t.Name.StartsWith("ResultPromise")) return "callback";
        if (t.IsGenericType && t.GetGenericTypeDefinition().FullName == "System.Nullable`1")
            return ParamKind(t.GetGenericArguments()[0], kinds) + "?";
        if (IsSooid(t)) return "sooid";
        if (t.IsEnum) return "enum";
        switch (t.FullName) {
            case "System.Int32": return "prim:int";
            case "System.Int64": return "prim:long";
            case "System.Boolean": return "prim:bool";
            case "System.Double": return "prim:double";
            case "System.Single": return "prim:float";
            case "System.String": return "prim:string";
            case "System.Char": return "prim:char";
        }
        if (t.IsArray && t.GetElementType().FullName == "System.Byte") return "bytes";
        if (t.IsGenericType) {
            var d = t.GetGenericTypeDefinition().Name;
            if (d.StartsWith("IEnumerable") || d.StartsWith("IList") || d.StartsWith("ICollection")
                || d.StartsWith("IReadOnlyList") || d.StartsWith("List")) {
                var el = t.GetGenericArguments()[0];
                var ek = kinds.TryGetValue(el.FullName ?? "", out var k) ? k : "";
                return ek == "byref" ? "reflist" : "primlist";
            }
        }
        if (t.FullName != null && kinds.TryGetValue(t.FullName, out var kind))
            return kind == "byref" ? "ref" : kind == "byval" ? "struct" : kind; // enum handled above
        return "ref"; // unknown -> treat as object reference
    }

    static int Main(string[] args) {
        string mb = "/Applications/Roon.app/Contents/MonoBundle";
        using var mlc = Mlc(mb);
        var api = mlc.LoadFromAssemblyPath(Path.Combine(mb, "Roon.Broker.Api.dll"));
        Type[] types;
        try { types = api.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }

        // Classify every API type first (codegen needs it for params + struct detection).
        var kinds = new Dictionary<string, string>();
        foreach (var t in types.Where(t => t != null && t.Namespace == "Sooloos.Broker.Api")) {
            string kind = null;
            if (t.IsEnum) kind = "enum";
            else if (t.GetCustomAttributesData().Any(a => a.AttributeType.Name == "ByValAttribute")) kind = "byval";
            else if (t.IsInterface) kind = "byref";
            if (kind != null && t.FullName != null) kinds[t.FullName] = kind;
        }

        var services = new List<object>();
        var enums = new List<object>();
        var structs = new Dictionary<string, object>(); // fullName -> { members:[{name,propType}] }
        int methodCount = 0;

        foreach (var t in types.Where(t => t != null)) {
            if (t.IsEnum) {
                enums.Add(new {
                    name = t.FullName,
                    underlying = "int",
                    values = Enum.GetNames(t).Zip(
                        t.GetFields(BindingFlags.Public|BindingFlags.Static).Select(f => Convert.ToInt64(f.GetRawConstantValue())),
                        (n, v) => new { name = n, value = v })
                });
                continue;
            }
            // by-val struct member schema (for sending populated structs)
            if (t.FullName != null && kinds.TryGetValue(t.FullName, out var tk) && tk == "byval") {
                var members = t.GetProperties()
                    .Where(p => p.CanRead)
                    .Select(p => new { name = p.Name, propType = PropTypeOf(p.PropertyType), type = TypeName(p.PropertyType) })
                    .ToList();
                structs[t.FullName] = new { members };
            }
            if (t.IsInterface && t.Namespace == "Sooloos.Broker.Api") {
                var methods = new List<object>();
                var allMethods = t.GetMethods().Concat(t.GetInterfaces().SelectMany(i => i.GetMethods()));
                var seenSig = new HashSet<string>();
                foreach (var m in allMethods) {
                    var ps = m.GetParameters();
                    var hasCb = ps.Any(p => p.ParameterType.Name.StartsWith("ResultCallback"));
                    var sig = $"{t.FullName}::{m.Name}({string.Join(", ", ps.Select(p => TypeName(p.ParameterType)))})";
                    if (!seenSig.Add(sig)) continue;
                    methods.Add(new {
                        name = m.Name,
                        signature = sig,
                        @params = ps.Select(p => new {
                            name = p.Name,
                            type = TypeName(p.ParameterType),
                            kind = ParamKind(p.ParameterType, kinds),
                        }),
                        expectsResponse = hasCb,
                    });
                    methodCount++;
                }
                if (methods.Count > 0)
                    services.Add(new { name = t.Name, fullName = t.FullName, methods });
            }
        }

        var outp = new {
            source = "Roon.Broker.Api.dll via MetadataLoadContext (authoritative)",
            serviceCount = services.Count,
            methodCount,
            enumCount = enums.Count,
            typeKindCount = kinds.Count,
            structCount = structs.Count,
            services, enums,
            typeKinds = kinds,
            structs,
        };
        var json = JsonSerializer.Serialize(outp, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText("../src/catalog/catalog.authoritative.json", json);
        Console.WriteLine($"services={services.Count} methods={methodCount} enums={enums.Count} structs={structs.Count}");
        return 0;
    }
}
