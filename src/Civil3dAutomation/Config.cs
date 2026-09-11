using System;
using System.Collections.Generic;
using System.IO;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Civil3dAutomation.Tests")]

namespace Civil3dAutomation
{
    /// <summary>
    /// Key=value settings read from "c3d.paths.txt" sitting next to the assembly.
    ///
    /// Why a file and not environment variables: AutoLISP's (setenv) does NOT reach
    /// .NET's Environment, so anything passed that way silently arrives null.
    ///
    /// This file has no Autodesk dependency on purpose: the unit tests compile it on its
    /// own against plain net10.0. Anything that needs AutoCAD types belongs in another
    /// partial-class file.
    /// </summary>
    public static partial class Config
    {
        static readonly object _lock = new object();
        static Dictionary<string, string> _cfg;
        static DateTime _loadedStamp;   // LastWriteTimeUtc of the file when _cfg was built
        static string _loadedPath;

        /// <summary>
        /// Parse key=value lines. Blank lines and lines whose first non-blank character is
        /// '#' or ';' are comments. Keys are case-insensitive; key and value are trimmed;
        /// the split is on the FIRST '=' so a value may itself contain '='.
        /// </summary>
        internal static Dictionary<string, string> Parse(IEnumerable<string> lines)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (lines == null) return d;
            foreach (var raw in lines)
            {
                if (raw == null) continue;
                var line = raw.Trim();
                if (line.Length == 0 || line[0] == '#' || line[0] == ';') continue;
                var i = line.IndexOf('=');
                if (i <= 0) continue;
                var key = line.Substring(0, i).Trim();
                if (key.Length == 0) continue;
                d[key] = line.Substring(i + 1).Trim();
            }
            return d;
        }

        static string ConfigPath()
        {
            var dir = Path.GetDirectoryName(typeof(Config).Assembly.Location);
            return Path.Combine(dir ?? "", "c3d.paths.txt");
        }

        /// <summary>
        /// Return the current settings, re-reading the file whenever its LastWriteTimeUtc
        /// has changed. AutoCAD keeps the add-in loaded for the whole session, so caching
        /// for the process lifetime meant every config edit needed an application restart.
        /// </summary>
        static Dictionary<string, string> Current()
        {
            lock (_lock)
            {
                try
                {
                    var f = ConfigPath();
                    var stamp = File.Exists(f) ? File.GetLastWriteTimeUtc(f) : DateTime.MinValue;
                    if (_cfg == null || stamp != _loadedStamp || !string.Equals(f, _loadedPath, StringComparison.OrdinalIgnoreCase))
                    {
                        _cfg = stamp == DateTime.MinValue
                            ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                            : Parse(File.ReadAllLines(f));
                        _loadedStamp = stamp;
                        _loadedPath = f;
                    }
                }
                catch
                {
                    if (_cfg == null) _cfg = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                }
                return _cfg;
            }
        }

        public static string Get(string key, string fallback = null)
        {
            string v;
            return (Current().TryGetValue(key, out v) && !string.IsNullOrWhiteSpace(v)) ? v : fallback;
        }

        public static string OutDir { get { return Get("out", Path.GetTempPath()); } }

        /// <summary>SendCommand gives no return value, so results go to a file the caller polls.</summary>
        public static StreamWriter OpenLog(string name)
        {
            return new StreamWriter(Path.Combine(OutDir, name), false);
        }
    }
}
