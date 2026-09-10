using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

[assembly: CommandClass(typeof(Civil3dAutomation.SurveySetupCommands))]

namespace Civil3dAutomation
{
    /// <summary>One feature code: layer, marker, label, and the raw descriptions it matches.</summary>
    public class FeatureCode
    {
        public string Layer;        // e.g. "C-SURV-PT62"
        public string Format;       // full description written by the key, e.g. "Sanitary Manhole"
        public string[] Keys;       // description key code properties, in match order
        public string Block;        // block name to use as the marker, or null
        public string CustomMarker; // CustomMarkerType name when Block is null
        public string Superimpose;  // CustomMarkerSuperimposeType (None/Square/Circle/SquareCircle)
        public short Color;
        public string LabelStyle;
        public string PointStyle;
    }

    public class SurveySetupCommands
    {
        static StreamWriter L;
        static void Log(string s) { L.WriteLine(s); L.Flush(); }

        // ------------------------------------------------------------------ example table
        // Illustrative only. Replace with your own survey coding standard.
        //
        // ORDERING MATTERS: description keys match in list order, so a broad key placed
        // early will shadow a narrow one. A pattern like "TOP_*" intended for creek banks
        // will also swallow "TOP_PIPE" sanitary points -- prefer the narrower "TOP_CK*".
        // Likewise "TR*" for trees also matches "TRAV_PT".
        static readonly FeatureCode[] Example =
        {
            new FeatureCode {
                Layer = "C-SURV-PT62", Format = "Sanitary Manhole",
                Keys = new[] { "MANHOLE*", "MH*" },
                Block = "srv062", Color = 200, LabelStyle = "Point# and Raw Description",
                PointStyle = "Sanitary Manhole" },
            new FeatureCode {
                Layer = "C-SURV-PT12", Format = "Ground Shot",
                Keys = new[] { "GRND_SHOT*", "GS*" },
                CustomMarker = "CustomMarkerPlus", Color = 8,
                LabelStyle = "Point# and Elevation", PointStyle = "Ground Shot" },
        };

        // Field codes differ between imperial and metric drawings (Uft vs Um), so read
        // them off the template's own styles rather than hard-coding them.
        const string FALLBACK_NUM = "<[Point Number(Sn)]>";
        const string FALLBACK_RAW = "<[Raw Description(CP)]>";

        [CommandMethod("C3DSURVEYSETUP")]
        public void Setup()
        {
            var db = Application.DocumentManager.MdiActiveDocument.Database;
            L = Config.OpenLog("c3dsurvey.out");
            try
            {
                var cdoc = CivilDocument.GetCivilDocument(db);
                MakeLayers(db, Example);
                ImportBlocks(db);
                var labels = MakeLabelStyles(db, cdoc);
                var styles = MakePointStyles(db, cdoc, Example);
                MakeKeySet(db, styles, labels, Example);
                Log("done");
            }
            catch (System.Exception ex) { Log("FATAL " + ex.Message); Log(ex.StackTrace); }
            finally { L.Flush(); L.Close(); }
        }

        static void MakeLayers(Database db, FeatureCode[] table)
        {
            Log("--- layers ---");
            using (var tr = db.TransactionManager.StartTransaction())
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForWrite);
                foreach (var f in table)
                {
                    if (lt.Has(f.Layer)) { Log("  exists " + f.Layer); continue; }
                    var ltr = new LayerTableRecord
                    {
                        Name = f.Layer,
                        Color = Color.FromColorIndex(ColorMethod.ByAci, f.Color)
                    };
                    lt.Add(ltr);
                    tr.AddNewlyCreatedDBObject(ltr, true);
                    Log("  + " + f.Layer);
                }
                tr.Commit();
            }
        }

        /// <summary>
        /// Import every DWG in a folder as a block definition, in one pass.
        /// ReadDwgFile into a side Database then Insert() defines the block WITHOUT
        /// placing a reference - far quicker than inserting each file by hand.
        /// </summary>
        static void ImportBlocks(Database db)
        {
            Log("--- blocks ---");
            var dir = Config.Get("symbols");
            if (dir == null || !Directory.Exists(dir)) { Log("  (no 'symbols' dir configured)"); return; }
            int n = 0;
            foreach (var file in Directory.GetFiles(dir, "*.dwg").OrderBy(x => x))
            {
                var name = Path.GetFileNameWithoutExtension(file);
                try
                {
                    using (var src = new Database(false, true))
                    {
                        src.ReadDwgFile(file, FileOpenMode.OpenForReadAndAllShare, true, null);
                        db.Insert(name, src, false);
                        n++;
                    }
                }
                catch (System.Exception ex) { Log("  !! " + name + ": " + ex.Message); }
            }
            Log("  imported " + n + " block definitions");
        }

        static string FieldFrom(Transaction tr, LabelStyleCollection coll, string styleName, string fallback)
        {
            foreach (ObjectId id in coll)
            {
                var ls = (LabelStyle)tr.GetObject(id, OpenMode.ForRead);
                if (ls.Name != styleName) continue;
                foreach (ObjectId cid in ls.GetComponents(LabelStyleComponentType.Text))
                {
                    var c = tr.GetObject(cid, OpenMode.ForRead) as LabelStyleTextComponent;
                    if (c != null) return c.Text.Contents.Value;
                }
            }
            return fallback;
        }

        static Dictionary<string, ObjectId> MakeLabelStyles(Database db, CivilDocument cdoc)
        {
            Log("--- label styles ---");
            var coll = cdoc.Styles.LabelStyles.PointLabelStyles.LabelStyles;
            var map = new Dictionary<string, ObjectId>();
            string fNum, fElev, fRaw = FALLBACK_RAW;
            double stockH = 0;

            using (var tr = db.TransactionManager.StartTransaction())
            {
                foreach (ObjectId id in coll)
                {
                    var s = (LabelStyle)tr.GetObject(id, OpenMode.ForRead);
                    if (!map.ContainsKey(s.Name)) map[s.Name] = id;
                }
                fNum = FieldFrom(tr, coll, "Point Number Only", FALLBACK_NUM);
                fElev = FieldFrom(tr, coll, "Elevation Only", null);
                foreach (ObjectId id in coll)
                {
                    var s = (LabelStyle)tr.GetObject(id, OpenMode.ForRead);
                    if (s.Name != "Elevation Only") continue;
                    foreach (ObjectId cid in s.GetComponents(LabelStyleComponentType.Text))
                    {
                        var c = tr.GetObject(cid, OpenMode.ForRead) as LabelStyleTextComponent;
                        if (c != null) stockH = c.Text.Height.Value;
                    }
                }
                tr.Commit();
            }
            Log("  number field : " + fNum);
            Log("  elev   field : " + fElev);
            Log("  stock height : " + stockH + "   (units are DRAWING units: feet in a ft drawing)");

            // NOTE the separator. Civil 3D field codes contain '|', e.g.
            // <[Point Elevation(Uft|P2|RN|AP|Sn|OF)]>, so splitting on '|' truncates the
            // field and the label renders as literal text. Use something else.
            const string SEP = "::";
            var want = new Dictionary<string, string[]>
            {
                { "Symbol Only",                new string[0] },
                { "Point# and Elevation",       new[]{ "Point Number" + SEP + fNum, "Point Elev" + SEP + fElev } },
                { "Raw Description Only",       new[]{ "Raw Description" + SEP + fRaw } },
                { "Point# and Raw Description", new[]{ "Point Number" + SEP + fNum, "Raw Description" + SEP + fRaw } },
            };

            foreach (var kv in want)
            {
                if (kv.Value.Any(v => v.EndsWith(SEP) || v.Split(new[] { SEP }, StringSplitOptions.None)[1] == null))
                { Log("  !! skipping " + kv.Key + " (missing field code)"); continue; }
                try
                {
                    bool isNew = !map.ContainsKey(kv.Key);
                    var id = isNew ? coll.Add(kv.Key) : map[kv.Key];
                    using (var tr = db.TransactionManager.StartTransaction())
                    {
                        var ls = (LabelStyle)tr.GetObject(id, OpenMode.ForWrite);
                        var names = new List<string>();
                        foreach (ObjectId cid in ls.GetComponents(LabelStyleComponentType.Text))
                        {
                            var c = tr.GetObject(cid, OpenMode.ForRead) as LabelStyleComponent;
                            if (c != null) names.Add(c.Name);
                        }
                        foreach (var nm in names) { try { ls.RemoveComponent(nm); } catch { } }

                        int slot = 0;
                        foreach (var spec in kv.Value)
                        {
                            var parts = spec.Split(new[] { SEP }, StringSplitOptions.None);
                            var cid = ls.AddComponent(parts[0], LabelStyleComponentType.Text);
                            var comp = (LabelStyleTextComponent)tr.GetObject(cid, OpenMode.ForWrite);
                            comp.Text.Contents.Value = parts[1];
                            if (stockH > 0) comp.Text.Height.Value = stockH;
                            // Components share one anchor by default, so without offsets
                            // every line of a multi-part label overprints the previous one.
                            comp.Text.XOffset.Value = (stockH > 0 ? stockH : 1.0) * 1.5;
                            comp.Text.YOffset.Value = (stockH > 0 ? stockH : 1.0) * (1.4 - 1.2 * slot);
                            slot++;
                        }
                        tr.Commit();
                    }
                    map[kv.Key] = id;
                    Log("  " + (isNew ? "+ " : "~ ") + kv.Key);
                }
                catch (System.Exception ex) { Log("  !! " + kv.Key + ": " + ex.Message); }
            }
            return map;
        }

        static Dictionary<string, ObjectId> MakePointStyles(
            Database db, CivilDocument cdoc, FeatureCode[] table)
        {
            Log("--- point styles ---");
            var coll = cdoc.Styles.PointStyles;
            var map = new Dictionary<string, ObjectId>();
            using (var tr = db.TransactionManager.StartTransaction())
            {
                foreach (ObjectId id in coll)
                {
                    var s = (PointStyle)tr.GetObject(id, OpenMode.ForRead);
                    if (!map.ContainsKey(s.Name)) map[s.Name] = id;
                }
                tr.Commit();
            }

            foreach (var f in table)
            {
                if (string.IsNullOrEmpty(f.PointStyle)) continue;
                try
                {
                    // Get-or-create then ALWAYS re-apply: a style whose creation succeeded
                    // but whose marker assignment threw would otherwise be skipped forever.
                    bool isNew = !map.ContainsKey(f.PointStyle);
                    var id = isNew ? coll.Add(f.PointStyle) : map[f.PointStyle];
                    using (var tr = db.TransactionManager.StartTransaction())
                    {
                        var ps = (PointStyle)tr.GetObject(id, OpenMode.ForWrite);
                        if (!string.IsNullOrEmpty(f.Block))
                        {
                            ps.MarkerType = PointMarkerDisplayType.UseSymbolForMarker;
                            ps.MarkerSymbolName = f.Block;   // must already be a block in this drawing
                        }
                        else if (!string.IsNullOrEmpty(f.CustomMarker))
                        {
                            ps.MarkerType = PointMarkerDisplayType.UseCustomMarker;
                            ps.CustomMarkerStyle =
                                (CustomMarkerType)Enum.Parse(typeof(CustomMarkerType), f.CustomMarker);
                            if (!string.IsNullOrEmpty(f.Superimpose))
                                ps.CustomMarkerSuperimposeStyle =
                                    (CustomMarkerSuperimposeType)Enum.Parse(
                                        typeof(CustomMarkerSuperimposeType), f.Superimpose);
                        }
                        tr.Commit();
                    }
                    map[f.PointStyle] = id;
                    Log("  " + (isNew ? "+ " : "~ ") + f.PointStyle);
                }
                catch (System.Exception ex) { Log("  !! " + f.PointStyle + ": " + ex.Message); }
            }
            return map;
        }

        static void MakeKeySet(Database db, Dictionary<string, ObjectId> styles,
                               Dictionary<string, ObjectId> labels, FeatureCode[] table)
        {
            Log("--- description key set ---");
            var setName = Config.Get("keyset", "SURVEY");
            // NOTE: static accessor taking a Database. It is NOT a property on CivilDocument.
            var sets = PointDescriptionKeySetCollection.GetPointDescriptionKeySets(db);

            ObjectId setId = ObjectId.Null;
            using (var tr = db.TransactionManager.StartTransaction())
            {
                foreach (ObjectId id in sets)
                    if (((PointDescriptionKeySet)tr.GetObject(id, OpenMode.ForRead)).Name == setName) setId = id;
                tr.Commit();
            }
            if (setId.IsNull) { setId = sets.Add(setName); Log("  + keyset " + setName); }

            using (var tr = db.TransactionManager.StartTransaction())
            {
                var ks = (PointDescriptionKeySet)tr.GetObject(setId, OpenMode.ForWrite);
                var have = new Dictionary<string, ObjectId>(StringComparer.OrdinalIgnoreCase);
                foreach (ObjectId kid in ks.GetPointDescriptionKeyIds())
                {
                    var k0 = (PointDescriptionKey)tr.GetObject(kid, OpenMode.ForRead);
                    if (!have.ContainsKey(k0.Code)) have[k0.Code] = kid;
                }
                foreach (var f in table)
                    foreach (var code in f.Keys)
                    {
                        try
                        {
                            var kid = have.ContainsKey(code) ? have[code] : ks.Add(code);
                            var k = (PointDescriptionKey)tr.GetObject(kid, OpenMode.ForWrite);
                            k.Format = f.Format;
                            k.ApplyLayerId = true;
                            k.LayerId = LayerId(db, f.Layer);
                            if (f.PointStyle != null && styles.ContainsKey(f.PointStyle))
                            { k.ApplyStyleId = true; k.StyleId = styles[f.PointStyle]; }
                            if (f.LabelStyle != null && labels.ContainsKey(f.LabelStyle))
                            { k.ApplyLabelStyleId = true; k.LabelStyleId = labels[f.LabelStyle]; }
                            Log("  + " + code + " -> " + f.Format + " / " + f.Layer);
                        }
                        catch (System.Exception ex) { Log("  !! " + code + ": " + ex.Message); }
                    }
                tr.Commit();
            }

            // SearchOrder decides which key set wins when several could match.
            try
            {
                var order = new ObjectIdCollection { setId };
                foreach (ObjectId id in sets) if (id != setId) order.Add(id);
                sets.SearchOrder = order;
                Log("  '" + setName + "' placed first in search order");
            }
            catch (System.Exception ex) { Log("  !! search order: " + ex.Message); }
        }

        static ObjectId LayerId(Database db, string name)
        {
            using (var tr = db.TransactionManager.StartTransaction())
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var id = lt.Has(name) ? lt[name] : ObjectId.Null;
                tr.Commit();
                return id;
            }
        }
    }
}
