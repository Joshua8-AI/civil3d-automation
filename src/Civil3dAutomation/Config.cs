using System;
using System.Collections.Generic;
using System.IO;

namespace Civil3dAutomation
{
    /// <summary>
    /// Key=value settings read from "c3d.paths.txt" sitting next to the assembly.
    ///
    /// Why a file and not environment variables: AutoLISP's (setenv) does NOT reach
    /// .NET's Environment, so anything passed that way silently arrives null.
    /// </summary>
    public static class Config
    {
        static Dictionary<string, string> _cfg;

        public static string Get(string key, string fallback = null)
        {
            if (_cfg == null)
            {
                _cfg = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                try
                {
                    var dir = Path.GetDirectoryName(typeof(Config).Assembly.Location);
                    var f = Path.Combine(dir, "c3d.paths.txt");
                    if (File.Exists(f))
                        foreach (var line in File.ReadAllLines(f))
                        {
                            if (line.StartsWith("#")) continue;
                            var i = line.IndexOf('=');
                            if (i > 0) _cfg[line.Substring(0, i).Trim()] = line.Substring(i + 1).Trim();
                        }
                }
                catch { }
            }
            string v;
            return (_cfg.TryGetValue(key, out v) && !string.IsNullOrWhiteSpace(v)) ? v : fallback;
        }

        public static string OutDir { get { return Get("out", Path.GetTempPath()); } }

        /// <summary>SendCommand gives no return value, so results go to a file the caller polls.</summary>
        public static StreamWriter OpenLog(string name)
        {
            return new StreamWriter(Path.Combine(OutDir, name), false);
        }
    }
}
