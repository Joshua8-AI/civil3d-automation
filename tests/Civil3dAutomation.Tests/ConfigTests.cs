using Civil3dAutomation;

namespace Civil3dAutomation.Tests
{
    public class ConfigParseTests
    {
        [Fact]
        public void IndentedHashCommentIsSkipped()
        {
            var d = Config.Parse(new[] { "   # out=C:\\wrong", "out=C:\\right" });
            Assert.Single(d);
            Assert.Equal("C:\\right", d["out"]);
        }

        [Fact]
        public void SemicolonCommentIsSkipped()
        {
            var d = Config.Parse(new[] { "; template=nope", "template=C:\\t.dwt" });
            Assert.Single(d);
            Assert.Equal("C:\\t.dwt", d["template"]);
        }

        [Fact]
        public void BlankAndWhitespaceOnlyLinesAreSkipped()
        {
            var d = Config.Parse(new[] { "", "   ", "\t", "out=x" });
            Assert.Single(d);
        }

        [Fact]
        public void KeyLookupIsCaseInsensitive()
        {
            var d = Config.Parse(new[] { "Api_Type=PointStyle" });
            Assert.Equal("PointStyle", d["api_type"]);
            Assert.Equal("PointStyle", d["API_TYPE"]);
        }

        [Fact]
        public void KeyAndValueAreTrimmed()
        {
            var d = Config.Parse(new[] { "  out   =   C:\\Temp\\c3d   " });
            Assert.True(d.ContainsKey("out"));
            Assert.Equal("C:\\Temp\\c3d", d["out"]);
        }

        [Fact]
        public void SplitsOnFirstEqualsSoValueMayContainEquals()
        {
            var d = Config.Parse(new[] { "conn=Server=localhost;Db=a=b" });
            Assert.Equal("Server=localhost;Db=a=b", d["conn"]);
        }

        [Fact]
        public void LinesWithoutEqualsOrWithEmptyKeyAreIgnored()
        {
            var d = Config.Parse(new[] { "novalue", "=orphan", "ok=1" });
            Assert.Single(d);
            Assert.Equal("1", d["ok"]);
        }

        [Fact]
        public void LaterDuplicateKeyWins()
        {
            var d = Config.Parse(new[] { "out=first", "OUT=second" });
            Assert.Single(d);
            Assert.Equal("second", d["out"]);
        }
    }
}
