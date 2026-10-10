using Shufang.CoreBridge;

static void Assert(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

var directory = Path.Combine(Path.GetTempPath(), "shufang-core-test-" + Guid.NewGuid());
Directory.CreateDirectory(directory);
try
{
    using (var pending = System.Text.Json.JsonDocument.Parse("{\"revision\":1,\"value\":{\"id\":\"pending\",\"title\":\"Waiting\",\"content\":{\"$blob\":{}}},\"pendingFields\":[\"content\"]}")) {
        var item = Shufang.Windows.LibraryItem.FromRecord(pending.RootElement);
        Assert(!item.CanEdit && item.PendingFields.SequenceEqual(new[] { "content" }), "pending object metadata must disable editing");
    }
    var path = Path.Combine(directory, "library.sqlite3");
    using (var core = new LibrarySession(path, "test-workspace", "windows-test"))
    {
        var saved = core.SaveNote("note", "原生书房😀", "无需 Node 或 MySQL", 0);
        Assert(saved.GetProperty("revision").GetInt32() == 1, "revision");
        try { core.SaveNote("note", "stale", "lost update", 0); throw new Exception("stale write accepted"); }
        catch (InvalidOperationException error) when (error.Message == "revision_conflict") { }
        Assert(core.Pending().GetArrayLength() == 1, "durable outbox");
    }
    using (var reopened = new LibrarySession(path, "test-workspace", "windows-test"))
    {
        Assert(reopened.Notes()[0].GetProperty("note").GetProperty("title").GetString() == "原生书房😀", "restart/UTF-8");
        Assert(reopened.Pending().GetArrayLength() == 1, "restart/outbox");
    }
    await using (var viewModel = new Shufang.Windows.NotesViewModel(() => new LibrarySession(path, "test-workspace", "windows-test")))
    {
        await viewModel.InitializeAsync();
        viewModel.Selected = viewModel.Notes[0];
        viewModel.Title = "";
        viewModel.Content = "unsaved draft";
        await viewModel.SaveAsync();
        Assert(viewModel.Status == "invalid_note", "validation surfaced to view");
        Assert(viewModel.Content == "unsaved draft", "failed save must preserve draft");
    }
    await using (var library = new Shufang.Windows.LibraryViewModel(() => new LibrarySession(path, "test-workspace", "windows-test")))
    {
        await library.InitializeAsync(); await library.SelectKindAsync("notes");
        await library.SearchAsync("书房😀");
        Assert(library.Items.Count == 1, "Chinese and emoji search must match decoded text");
        await library.SearchAsync("no matching text"); Assert(library.Items.Count == 0, "search excludes unmatched rows");
    }
    using (var core = new LibrarySession(path, "test-workspace", "windows-test"))
    {
        var value = core.Command("save", new { kind = "books", id = "b", expected = 0, patch = new { title = "编辑草稿", author = "", format = "txt", chapters = new[] { new { id = "c", title = "章", paragraphs = new[] { "正文" } } } } });
        var baseline = Shufang.Windows.LibraryItem.FromRecord(value);
        var checkpoint = Shufang.Windows.LibraryItem.FromRecord(core.Command("checkpoint", new { id = "b", session = "s", activeSeconds = 10, progress = new { chapterId = "c", ratio = 0.5 } }));
        var refreshed = Shufang.Windows.LibraryItem.RebaseReading(baseline, checkpoint);
        Assert(refreshed!.Revision == checkpoint.Revision, $"own reading changes must not conflict with metadata editing: {baseline.Value} -> {checkpoint.Value}");
        var changed = Shufang.Windows.LibraryItem.FromRecord(core.Command("save", new { kind = "books", id = "b", expected = checkpoint.Revision, patch = new { title = "来自独立服务的修改" } }));
        Assert(Shufang.Windows.LibraryItem.RebaseReading(refreshed, changed)!.Revision == refreshed.Revision, "external metadata edit must still produce a conflict");
        core.Command("save", new { kind = "highlights", id = "h", expected = 0, patch = new { bookId = "b", chapterId = "c", text = "正文", paraIndex = 0, start = 0, end = 2 } });
        core.Command("setReview", new { id = "h", expected = 1, enabled = true });
        Assert(core.Command("reviewQueue").GetArrayLength() == 1, "review enrollment through real native command");
        core.Command("save", new { kind = "preferences", id = "windows-service", expected = 0, patch = new { port = 32345 } });
    }
    await using (var library = new Shufang.Windows.LibraryViewModel(() => new LibrarySession(path, "test-workspace", "windows-test")))
    {
        await library.InitializeAsync(); library.Reviewing = true;
        await library.SelectKindAsync("highlights");
        Assert(library.Items.Count == 1 && !library.Items[0].Title.Contains("正文"), "review list must not reveal the answer");
        var prefs = await library.CommandAsync("get", new { kind = "preferences", id = "windows-service" });
        Assert(prefs!.Value.GetProperty("value").GetProperty("port").GetInt32() == 32345, "service preferences survive reopen");
    }
    var blocks = Shufang.Windows.NotePresentation.Parse("# 读书😀\n**重点** [[引用笔记]]\n<!-- shufang-citation-id:test -->\n> 引文\n- 清单\n```\n<script>alert(1)</script>\n```");
    Assert(blocks[0].Kind == "heading1" && blocks[0].Inlines[0].Text == "读书😀", "Unicode markdown heading");
    Assert(blocks[1].Inlines.Any(i => i.Kind == "strong") && blocks[1].Inlines.Any(i => i.Kind == "link" && i.Text == "引用笔记"), "rich note and wikilink tokens");
    Assert(blocks.All(b => b.Inlines.All(i => !i.Text.Contains("shufang-citation-id"))), "hide internal citation markers");
    Assert(blocks.Last().Kind == "code" && blocks.Last().Inlines[0].Text.Contains("<script>"), "untrusted HTML remains literal text");
    var nativeLines = Shufang.Windows.NotePresentation.Parse("# 标题\r<!-- shufang-citation-id:test -->\r> 引文");
    Assert(nativeLines.Count == 2 && nativeLines[1].Kind == "quote", "WinUI TextBox CR line endings preserve Markdown blocks");
    if (OperatingSystem.IsWindows()) using (var maintenance = new FileStream(Path.Combine(directory,"update.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.ReadWrite)) {
        maintenance.Lock(0,long.MaxValue);
        try { try { using var blocked = new LibrarySession(path,"test-workspace","windows-test"); throw new Exception("C# maintenance lock did not exclude native session"); } catch(InvalidOperationException error) when(error.Message=="workspace_update_in_progress") {} }
        finally { if(OperatingSystem.IsWindows()) maintenance.Unlock(0,long.MaxValue); }
    }
    using (var afterMaintenance = new LibrarySession(path,"test-workspace","windows-test")) Assert(afterMaintenance.Notes().GetArrayLength()==1,"maintenance release preserves data");
    Assert(NativeCore.Execute("sessionDatabaseVersion",new{database=path}).GetInt32()==3,"updater readonly schema probe crosses C ABI");
    using(var sync = new LibrarySession(path,"test-workspace","windows-test")) {
        var config=sync.Command("syncConfig");Assert(config.GetProperty("identity").GetProperty("workspaceId").GetString()=="test-workspace","sync identity");
        sync.Command("saveSyncPeer",new{expected=0,id="other-node",url="https://books.example.test",token="isolated-private-sync-token"});
        Assert(!sync.Command("syncConfig").GetRawText().Contains("isolated-private-sync-token"),"UI must not expose credentials");
        sync.Command("pauseSync",new{expected=1,paused=false});sync.Command("requestSync");
        Assert(sync.Command("syncStatus").GetProperty("requested").GetInt32()==1,"manual retry crosses C ABI");
        sync.Command("removeSyncPeer",new{expected=2,id="other-node"});
    }
    Console.WriteLine("PASS: C# -> C ABI -> Rust use case -> SQLite, restart, conflict, Unicode search, outbox and cross-runtime maintenance lock.");
}
finally
{
    // Only the unique temporary test directory created above is removed.
    var resolved = Path.GetFullPath(directory);
    var temporaryRoot = Path.GetFullPath(Path.GetTempPath());
    if (!resolved.StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
        || !Path.GetFileName(resolved).StartsWith("shufang-core-test-", StringComparison.Ordinal))
        throw new InvalidOperationException("Unexpected test cleanup path");
    Directory.Delete(resolved, recursive: true);
}
