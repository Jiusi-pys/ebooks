using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using Shufang.CoreBridge;

namespace Shufang.Windows;

public sealed record LibraryItem(string Id, string Title, ulong Revision, JsonObject Value)
{
    public string[] PendingFields { get; init; } = [];
    public bool CanEdit => PendingFields.Length == 0;
    public static LibraryItem FromRecord(JsonElement record)
    {
        var value = JsonNode.Parse(record.GetProperty("value").GetRawText())!.AsObject();
        return new(value["id"]!.ToString(), value["title"]?.ToString() ?? value["name"]?.ToString() ?? value["text"]?.ToString() ?? value["label"]?.ToString() ?? value["id"]!.ToString(), record.GetProperty("revision").GetUInt64(), value) {
            PendingFields = record.TryGetProperty("pendingFields", out var fields) ? fields.EnumerateArray().Select(f => f.GetString()!).ToArray() : []
        };
    }
    // Adopt only reading changes. A service-side metadata change must still
    // conflict with the editor's original baseline, preserving its draft.
    public static LibraryItem? RebaseReading(LibraryItem? baseline, LibraryItem updated)
    {
        if (baseline is null || baseline.Id != updated.Id) return baseline;
        var before = baseline.Value.DeepClone().AsObject();
        var after = updated.Value.DeepClone().AsObject();
        foreach (var key in new[] { "progress", "progressByDevice", "readingSessions", "lastOpenedAt", "updatedAt", "readerMode" }) { before.Remove(key); after.Remove(key); }
        return JsonNode.DeepEquals(before, after) ? updated : baseline;
    }
}

public sealed class LibraryViewModel : INotifyPropertyChanged, IAsyncDisposable
{
    private readonly Func<LibrarySession> open;
    private LibrarySession? session;
    private readonly SemaphoreSlim gate = new(1, 1);
    private bool disposed, busy;
    private string status = "正在打开工作区", kind = "books", query = "";
    private int refreshGeneration;
    public bool Reviewing { get; set; }
    public string? ReviewStudySet { get; set; }
    public LibraryViewModel(Func<LibrarySession> open) => this.open = open;
    public ObservableCollection<LibraryItem> Items { get; } = new();
    public string Kind => kind;
    public string Status { get => status; private set { status = value; Notify(); } }
    public bool Ready => session is not null && !busy && !disposed;
    public event PropertyChangedEventHandler? PropertyChanged;
    private void Notify([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public async Task InitializeAsync()
    {
        await gate.WaitAsync();
        try { session = await Task.Run(open); Status = "本地工作区已打开"; }
        catch (Exception error) { Status = error.Message; }
        finally { gate.Release(); Notify(nameof(Ready)); }
        if (session is not null) await RefreshAsync();
    }
    public async Task SelectKindAsync(string value) { kind = value; query = ""; await RefreshAsync(); }
    public async Task SearchAsync(string value) { query = value; await RefreshAsync(); }
    public async Task RefreshAsync()
    {
        var generation = ++refreshGeneration;
        var rows = Reviewing ? await CommandAsync("reviewQueue", new { studySet = ReviewStudySet }) : await CommandAsync("list", new { kind });
        if (rows is null || generation != refreshGeneration) return;
        Items.Clear();
        foreach (var row in rows.Value.EnumerateArray())
        {
            var value = JsonNode.Parse(row.GetProperty("value").GetRawText())!.AsObject();
            var title = value["title"]?.ToString() ?? value["name"]?.ToString() ?? value["text"]?.ToString() ?? value["label"]?.ToString() ?? value["id"]!.ToString();
            if (!string.IsNullOrWhiteSpace(query) && !Matches(value, query)) continue;
            if (Reviewing) title = $"卡片 {Items.Count + 1} · {value["chapterTitle"]?.ToString() ?? "书摘"}";
            Items.Add(LibraryItem.FromRecord(row) with { Title = title });
        }
    }
    private static bool Matches(JsonNode? node, string query) => node switch
    {
        JsonObject fields => fields.Any(field => Matches(field.Value, query)),
        JsonArray items => items.Any(item => Matches(item, query)),
        JsonValue value => value.ToString().Contains(query, StringComparison.OrdinalIgnoreCase),
        _ => false,
    };
    public async Task<JsonElement?> CommandAsync(string action, object? args = null)
    {
        await gate.WaitAsync();
        if (disposed || session is null) { gate.Release(); return null; }
        busy = true; Notify(nameof(Ready));
        try { var result = await Task.Run(() => session.Command(action, args)); Status = "就绪"; return result; }
        catch (Exception error) { Status = error.Message; return null; }
        finally { busy = false; Notify(nameof(Ready)); gate.Release(); }
    }
    public async Task<JsonElement?> SaveAsync(LibraryItem? item, JsonObject patch, string[]? unset = null)
    {
        if (item is { CanEdit: false }) { Status = "正文仍在同步，请同步完成后重新打开。"; return null; }
        var result = await CommandAsync("save", new { kind, id = item?.Id ?? Guid.NewGuid().ToString(), expected = item?.Revision ?? 0, patch, unset = unset ?? [] });
        if (result is not null) await RefreshAsync();
        return result;
    }
    public async Task DeleteAsync(LibraryItem item)
    {
        if (await CommandAsync("delete", new { kind, id = item.Id, expected = item.Revision }) is not null) await RefreshAsync();
    }
    public async Task<JsonElement?> ImportAsync(string path, string readerMode, CancellationToken cancellation)
    {
        var start = await CommandAsync("import", new { path, readerMode });
        if (start is null) return null;
        var result = await AwaitJobAsync(start.Value.GetProperty("job").GetString()!, cancellation);
        await RefreshAsync(); return result;
    }
    public async Task<JsonElement?> AwaitJobAsync(string id, CancellationToken cancellation, Action<string>? partial = null)
    {
        try
        {
            while (!disposed)
            {
                if (cancellation.IsCancellationRequested) await CommandAsync("cancelJob", new { id });
                var snapshot = await CommandAsync("job", new { id });
                if (snapshot is null) return null;
                var state = snapshot.Value.GetProperty("status").GetString();
                var result = snapshot.Value.GetProperty("result");
                if (result.ValueKind == JsonValueKind.Object && result.TryGetProperty("text", out var text)) partial?.Invoke(text.GetString() ?? "");
                if (state == "completed") return result.Clone();
                if (state is "failed" or "cancelled") { Status = snapshot.Value.GetProperty("error").GetString() ?? state; return null; }
                Status = $"处理中 {snapshot.Value.GetProperty("progress").GetDouble():P0}";
                await Task.Delay(100);
            }
            return null;
        }
        finally { var lastStatus = Status; if (!disposed) await CommandAsync("forgetJob", new { id }); Status = lastStatus; }
    }
    public async ValueTask DisposeAsync()
    {
        disposed = true; await gate.WaitAsync();
        try { session?.Dispose(); session = null; }
        finally { gate.Release(); }
    }
}
