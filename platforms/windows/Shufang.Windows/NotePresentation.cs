using System.Text.RegularExpressions;

namespace Shufang.Windows;

public sealed record NoteInline(string Kind, string Text);
public sealed record NoteBlock(string Kind, IReadOnlyList<NoteInline> Inlines);

/// <summary>Presentation-only Markdown subset. All content becomes native text,
/// never HTML or executable URLs. Wiki targets are resolved by the host.</summary>
public static class NotePresentation
{
    public static IReadOnlyList<NoteBlock> Parse(string markdown)
    {
        var blocks = new List<NoteBlock>();
        var code = new List<string>();
        var inCode = false;
        foreach (var line in markdown.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            if (line.StartsWith("```", StringComparison.Ordinal))
            {
                if (inCode) { blocks.Add(new("code", [new("text", string.Join("\n", code))])); code.Clear(); }
                inCode = !inCode; continue;
            }
            if (inCode) { code.Add(line); continue; }
            if (Regex.IsMatch(line.Trim(), @"^<!-- shufang-citation-id:[^\r\n]* -->$")) continue;
            var match = Regex.Match(line, @"^(#{1,3})\s+(.*)$");
            if (match.Success) { blocks.Add(new("heading" + match.Groups[1].Length, Inline(match.Groups[2].Value))); continue; }
            match = Regex.Match(line, @"^\s*(?:[-•]|\d+[.、)])\s+(.*)$");
            if (match.Success) { blocks.Add(new("list", Inline("• " + match.Groups[1].Value))); continue; }
            blocks.Add(new(line.StartsWith('>') ? "quote" : "paragraph", Inline(line.StartsWith('>') ? line[1..].TrimStart() : line)));
        }
        if (inCode) blocks.Add(new("code", [new("text", string.Join("\n", code))]));
        return blocks;
    }
    private static IReadOnlyList<NoteInline> Inline(string text)
    {
        var parts = new List<NoteInline>(); var start = 0;
        foreach (Match match in Regex.Matches(text, @"\[\[[^\]\r\n]{1,120}\]\]|\*\*[^*\r\n]+\*\*|`[^`\r\n]+`"))
        {
            if (match.Index > start) parts.Add(new("text", text[start..match.Index]));
            var value = match.Value;
            parts.Add(value.StartsWith("[[", StringComparison.Ordinal) ? new("link", value[2..^2].Trim()) : value.StartsWith("**", StringComparison.Ordinal) ? new("strong", value[2..^2]) : new("code", value[1..^1]));
            start = match.Index + match.Length;
        }
        if (start < text.Length || parts.Count == 0) parts.Add(new("text", text[start..]));
        return parts;
    }
}
