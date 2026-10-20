using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace QuizForge.Desktop
{
    // Validate the original bytes, before System.Uri can normalize escapes,
    // slashes, host names or duplicate query parameters.
    internal sealed class HubImportRequest
    {
        internal string Uri, PackId, Revision;
        internal string Key { get { return "hub:" + PackId + ":" + Revision; } }
        // Parse() permits only literal ASCII characters which need no JSON
        // escaping. JavaScriptSerializer would escape '&' as \u0026.
        internal string Command { get { return "{\"command\":\"hub-import\",\"uri\":\"" + Parse(Uri).Uri + "\"}"; } }
        internal static HubImportRequest Parse(string value)
        {
            const string prefix = "quizforge://hub/import?";
            if (value == null || value.Length > 1024 || !value.StartsWith(prefix, StringComparison.Ordinal)
                || !Regex.IsMatch(value, @"\A[a-z0-9:/?=&-]+\z")) throw Invalid();
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string pair in value.Substring(prefix.Length).Split('&'))
            {
                string[] parts = pair.Split('=');
                if (parts.Length != 2 || fields.ContainsKey(parts[0])) throw Invalid();
                fields.Add(parts[0], parts[1]);
            }
            string version, pack, revision; long number;
            if (fields.Count != 3 || !fields.TryGetValue("v", out version) || version != "1"
                || !fields.TryGetValue("pack", out pack) || !Regex.IsMatch(pack, @"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z")
                || !fields.TryGetValue("revision", out revision) || !Regex.IsMatch(revision, @"\A[1-9][0-9]{0,15}\z")
                || !long.TryParse(revision, NumberStyles.None, CultureInfo.InvariantCulture, out number) || number > 9007199254740991L) throw Invalid();
            return new HubImportRequest { Uri = value, PackId = pack, Revision = revision };
        }
        private static ArgumentException Invalid() { return new ArgumentException("Hub 导入链接无效，请回到题库网站重新点击下载到本地。"); }

        internal static HubImportRequest FromCommand(string value)
        {
            if (value == null || value.Length > 2048) return null;
            // Only two literal fields; reject duplicate fields and JSON escapes
            // instead of letting a dictionary silently discard a duplicate.
            var match = Regex.Match(value, "\\A\\{\\s*\"command\"\\s*:\\s*\"hub-import\"\\s*,\\s*\"uri\"\\s*:\\s*\"([^\"\\\\]*)\"\\s*\\}\\z");
            if (!match.Success) match = Regex.Match(value, "\\A\\{\\s*\"uri\"\\s*:\\s*\"([^\"\\\\]*)\"\\s*,\\s*\"command\"\\s*:\\s*\"hub-import\"\\s*\\}\\z");
            if (!match.Success) return null;
            try { return Parse(match.Groups[1].Value); } catch (ArgumentException) { return null; }
        }
    }
}
