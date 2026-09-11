using System;
using System.IO;
using System.Linq;
using System.Reflection;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices.Styles;

[assembly: CommandClass(typeof(Civil3dAutomation.InspectCommands))]

namespace Civil3dAutomation
{
    /// <summary>
    /// Read-only reconnaissance. Run these first: they tell you what the drawing actually
    /// contains and what the API actually exposes, which beats guessing from docs.
    /// </summary>
    public class InspectCommands
    {
        /// <summary>What styles, label styles, blocks and layers does this drawing have?</summary>
        [CommandMethod("C3DINFO")]
        public void Info()
        {
            var db = Application.DocumentManager.MdiActiveDocument.Database;
            using (var sw = Config.OpenLog("c3dinfo.out"))
            {
                try
                {
                    var cdoc = CivilDocument.GetCivilDocument(db);
                    using (var tr = db.TransactionManager.StartTransaction())
                    {
                        var ps = cdoc.Styles.PointStyles;
                        sw.WriteLine("=== POINT STYLES (" + ps.Count + ") ===");
                        foreach (ObjectId id in ps)
                            sw.WriteLine("  " + ((PointStyle)tr.GetObject(id, OpenMode.ForRead)).Name);

                        var ls = cdoc.Styles.LabelStyles.PointLabelStyles.LabelStyles;
                        sw.WriteLine("=== POINT LABEL STYLES (" + ls.Count + ") ===");
                        foreach (ObjectId id in ls)
                        {
                            var s = (LabelStyle)tr.GetObject(id, OpenMode.ForRead);
                            sw.WriteLine("  " + s.Name);
                            // The field-code syntax is not documented anywhere obvious.
                            // Read it off the styles the template already ships with.
                            foreach (ObjectId cid in s.GetComponents(LabelStyleComponentType.Text))
                            {
                                var c = tr.GetObject(cid, OpenMode.ForRead) as LabelStyleTextComponent;
                                if (c != null)
                                    sw.WriteLine("      [" + c.Name + "] h=" + c.Text.Height.Value +
                                                 "  = " + c.Text.Contents.Value);
                            }
                        }

                        var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                        int nl = 0; foreach (ObjectId id in lt) nl++;
                        sw.WriteLine("=== LAYERS: " + nl + " ===");

                        var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                        int nb = 0;
                        foreach (ObjectId id in bt)
                        {
                            var b = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                            if (!b.IsLayout && !b.IsAnonymous) nb++;
                        }
                        sw.WriteLine("=== NAMED BLOCKS: " + nb + " ===");
                        tr.Commit();
                    }
                }
                catch (System.Exception ex) { sw.WriteLine("ERROR " + ex.Message); sw.WriteLine(ex.StackTrace); }
                // The harness polls the log for this sentinel. It must appear on the error
                // path too, or a failed command looks exactly like a hung one until timeout.
                finally { sw.WriteLine("done"); }
            }
        }

        /// <summary>Reflect over an API type so you stop guessing member names.</summary>
        [CommandMethod("C3DAPI")]
        public void Api()
        {
            using (var sw = Config.OpenLog("c3dapi.out"))
            {
                try
                {
                    var typeName = Config.Get("api_type", "Autodesk.Civil.DatabaseServices.Styles.PointStyle");
                    var asm = typeof(PointStyle).Assembly;
                    var t = asm.GetTypes().FirstOrDefault(x => x.FullName == typeName || x.Name == typeName);
                    sw.WriteLine("=== " + typeName + " ===");
                    if (t == null) { sw.WriteLine("(not found)"); return; }

                    foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance).OrderBy(x => x.Name))
                    {
                        string extra = "";
                        try { if (p.PropertyType.IsEnum) extra = " = " + string.Join(",", Enum.GetNames(p.PropertyType)); }
                        catch { }
                        sw.WriteLine("  P " + p.Name + " : " + p.PropertyType.Name + extra);
                    }
                    foreach (var m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static)
                                       .Where(x => !x.IsSpecialName && x.DeclaringType == t).OrderBy(x => x.Name))
                        sw.WriteLine("  M " + (m.IsStatic ? "static " : "") + m.Name + "(" +
                            string.Join(",", m.GetParameters().Select(z => z.ParameterType.Name)) + ")");
                }
                catch (System.Exception ex) { sw.WriteLine("ERROR " + ex.Message); }
                finally { sw.WriteLine("done"); }
            }
        }
    }
}
