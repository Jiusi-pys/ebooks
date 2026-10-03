using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using System.Text.Json;
using System.Text.Json.Nodes;
using Windows.Storage.Pickers;
using Path = System.IO.Path;
using Shufang.Updates;

namespace Shufang.Windows;

public sealed partial class MainWindow : Window
{
    public LibraryViewModel ViewModel { get; } = new(WorkspaceFactory.Open);
    private ReaderBridge? renderer;
    private LibraryItem? selected, readingBook;
    private JsonObject? selection, associationStart, mindRoot, mindNode;
    private TreeViewNode? selectedTreeNode;
    private readonly Dictionary<TreeViewNode, JsonObject> mindNodes = new();
    private CancellationTokenSource taskCancellation = new();
    private ulong aiRevision, servicePreferencesRevision, syncRevision;
    private int savedServicePort = 31417;
    private ulong readerPreferencesRevision;
    private string screen = "books";
    private string? aiBookId;
    private JsonObject? aiAnchor;
    private bool aiFromReader;
    private string readingSession = Guid.NewGuid().ToString();
    private uint activeSeconds;
    private bool checkpointBusy, windowActive;
    private readonly DispatcherTimer heartbeat = new() { Interval = TimeSpan.FromSeconds(10) };
    private readonly Dictionary<string, string> bookTitles = new();
    private ulong updateRevision;
    private VerifiedRelease? updateRelease;
    private string? updateEnvelope, updatePublicKey, updateStaging;
    private static Version InstalledVersion => File.Exists(Path.Combine(AppContext.BaseDirectory,"release-manifest.json")) ? Version.Parse(JsonNode.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"release-manifest.json")))!["version"]!.ToString()) : new Version(0,2,2);
    public MainWindow()
    {
        InitializeComponent();
        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(1380, 900));
        Activated += Initialize;
        Activated += (_, e) => windowActive = e.WindowActivationState != WindowActivationState.Deactivated;
        heartbeat.Tick += async (_, _) => { if (windowActive && ReaderPanel.Visibility == Visibility.Visible && readingBook is not null) { activeSeconds += 10; await Checkpoint(readingBook.Value["progress"]?.DeepClone().AsObject()); } };
        heartbeat.Start();
        Closed += async (_, _) => { taskCancellation.Cancel(); await ViewModel.DisposeAsync(); };
    }
    private async void Initialize(object sender, WindowActivatedEventArgs args)
    {
        Activated -= Initialize; await ViewModel.InitializeAsync();
        renderer = new ReaderBridge(Reader); renderer.Gesture += ReaderGesture;
        var preferences = (await LoadItems("preferences")).FirstOrDefault(p=>p.Id=="reader");
        if (preferences is not null) { renderer.Preferences = preferences.Value; readerPreferencesRevision = preferences.Revision; }
        try { await renderer.InitializeAsync(); } catch (Exception error) { await Message(error.Message); }
        var command = Environment.GetCommandLineArgs(); var readyIndex = Array.IndexOf(command,"--update-ready-file");
        if (ViewModel.Ready && readyIndex >= 0 && readyIndex + 1 < command.Length) {
            var ready = Path.GetFullPath(command[readyIndex+1]);var directory=Path.GetFullPath(Path.Combine(WorkspaceFactory.DirectoryPath,".updates"));
            if (Path.GetDirectoryName(ready)==directory) { Directory.CreateDirectory(directory); await File.WriteAllTextAsync(ready, JsonSerializer.Serialize(new { ready=true,schemaVersion=Shufang.CoreBridge.NativeCore.Execute("sessionDatabaseVersion",new{database=Path.Combine(WorkspaceFactory.DirectoryPath,"library.sqlite3")}).GetInt32(),version=InstalledVersion.ToString(3) })); }
        }
        var updates=(await LoadItems("preferences")).FirstOrDefault(p=>p.Id=="windows-update");
        if(updates?.Value["automaticCheck"]?.GetValue<bool>()==true) { await LoadUpdateSettings(); CheckUpdate(this,new RoutedEventArgs()); }
    }
    private async Task Message(string text) => await new ContentDialog { Title = "书房", Content = text, CloseButtonText = "确定", XamlRoot = Navigation.XamlRoot }.ShowAsync();
    private void Panels(string panel)
    {
        TopActions.Visibility = panel == "settings" ? Visibility.Collapsed : Visibility.Visible;
        Editor.Visibility = panel == "edit" ? Visibility.Visible : Visibility.Collapsed;
        ReaderPanel.Visibility = panel == "reader" ? Visibility.Visible : Visibility.Collapsed;
        AiPanel.Visibility = panel == "ai" ? Visibility.Visible : Visibility.Collapsed;
        GraphPanel.Visibility = panel == "graph" ? Visibility.Visible : Visibility.Collapsed;
        SettingsPanel.Visibility = panel == "settings" ? Visibility.Visible : Visibility.Collapsed;
    }
    private async void Navigate(NavigationView sender, NavigationViewItemInvokedEventArgs args)
    {
        if (args.IsSettingsInvoked) { screen = "settings"; Heading.Text = "设置"; Panels("settings"); await LoadAiSettings(); await LoadServiceSettings(); await LoadUpdateSettings(); await LoadSyncSettings(); return; }
        if (args.InvokedItemContainer is not NavigationViewItem item) return;
        screen = item.Tag?.ToString() ?? "books"; Heading.Text = item.Content?.ToString() ?? "书房";
        selected = null; selection = null; Panels("edit"); TitleInput.Visibility = Visibility.Visible;
        ViewModel.Reviewing = screen == "review"; ViewModel.ReviewStudySet = null;
        ReviewQuestion.Visibility = NotePreview.Visibility = PreviewNoteButton.Visibility = StudyReviewButton.Visibility = EnrollReviewButton.Visibility = Visibility.Collapsed; ContentInput.Visibility = Visibility.Visible;
        await ViewModel.SelectKindAsync(screen switch { "review" => "highlights", "history" => "books", _ => screen });
        TitleInput.Text = ContentInput.Text = ""; AuthorInput.Visibility = FolderInput.Visibility = BookMetadataPanel.Visibility = CitationSources.Visibility = TagsInput.Visibility = ClozeInput.Visibility = ReviewControls.Visibility = MindControls.Visibility = StudyBooks.Visibility = Visibility.Collapsed;
        if (ViewModel.Items.Count > 0) Entries.SelectedIndex = 0;
        if (screen == "associations") { bookTitles.Clear(); foreach (var b in await LoadItems("books")) bookTitles[b.Id] = b.Title; Panels("graph"); RenderGraph(); }
    }
    private async void Search(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs args) => await ViewModel.SearchAsync(args.QueryText);
    private async void SelectItem(object sender, SelectionChangedEventArgs args)
    {
        if (Entries.SelectedItem is not LibraryItem item) return;
        selected = item; Panels("edit"); TitleInput.Text = item.Title;
        if (!item.CanEdit) {
            ContentInput.Text = "正文仍在同步，请同步完成后重新打开。";
            ContentInput.IsReadOnly = true;
            await Message("数据列表已同步，正文尚未下载完成。请在同步设置中重试，完成后重新打开。");
            return;
        }
        ContentInput.IsReadOnly = false;
        TitleInput.Visibility = screen == "review" ? Visibility.Collapsed : Visibility.Visible;
        ReviewQuestion.Visibility = screen == "review" ? Visibility.Visible : Visibility.Collapsed;
        NotePreview.Visibility = Visibility.Collapsed; ContentInput.Visibility = screen == "review" ? Visibility.Collapsed : Visibility.Visible;
        PreviewNoteButton.Visibility = ViewModel.Kind == "notes" ? Visibility.Visible : Visibility.Collapsed;
        StudyReviewButton.Visibility = ViewModel.Kind == "studySets" ? Visibility.Visible : Visibility.Collapsed;
        EnrollReviewButton.Visibility = ViewModel.Kind == "highlights" ? Visibility.Visible : Visibility.Collapsed;
        EnrollReviewButton.Content = item.Value["review"] is null ? "加入复习" : "退出复习";
        var value = item.Value;
        CitationSources.Visibility = ViewModel.Kind == "notes" ? Visibility.Visible : Visibility.Collapsed;
        if (ViewModel.Kind == "notes") { var sources = (await LoadItems("highlights")).Where(h=>h.Value["noteId"]?.ToString()==item.Id).ToList(); if (selected != item) return; CitationSources.ItemsSource = sources; CitationSources.SelectedIndex = sources.Count > 0 ? 0 : -1; }
        AuthorInput.Visibility = FolderInput.Visibility = ViewModel.Kind == "books" ? Visibility.Visible : Visibility.Collapsed;
        BookMetadataPanel.Visibility = AuthorInput.Visibility;
        AuthorInput.Text = value["author"]?.ToString() ?? "";
        ContentInput.Text = value["content"]?.ToString() ?? value["note"]?.ToString() ?? value["description"]?.ToString() ?? value["text"]?.ToString() ?? "";
        if (ViewModel.Kind == "books") ContentInput.Text = value["metadata"]?["description"]?.ToString() ?? "";
        if (screen == "history") ContentInput.Text = string.Join("\n", value["readingSessions"]?.AsArray().Select(s => $"{DateTimeOffset.FromUnixTimeMilliseconds(s!["startedAt"]!.GetValue<long>()).LocalDateTime:g}　{Math.Max(0, (s["endedAt"]!.GetValue<long>() - s["startedAt"]!.GetValue<long>()) / 60000.0):F1} 分钟") ?? []);
        TagsInput.Visibility = ClozeInput.Visibility = ReviewControls.Visibility = ViewModel.Kind == "highlights" ? Visibility.Visible : Visibility.Collapsed;
        TagsInput.Text = string.Join(", ", value["tags"]?.AsArray().Select(v => v?.ToString()) ?? []);
        if (screen == "review") TagsInput.Visibility = ClozeInput.Visibility = Visibility.Collapsed;
        ClozeInput.Text = string.Join(", ", value["cloze"]?.AsArray().Select(v => v?.ToString()) ?? []);
        StudyBooks.Visibility = ViewModel.Kind == "studySets" ? Visibility.Visible : Visibility.Collapsed;
        MindControls.Visibility = ViewModel.Kind == "mindMaps" ? Visibility.Visible : Visibility.Collapsed;
        if (screen == "review") { var prompt = value["text"]?.ToString() ?? ""; foreach (var word in value["cloze"]?.AsArray() ?? []) if (word?.ToString() is string term && term.Length > 0) prompt = prompt.Replace(term, "______", StringComparison.Ordinal); ReviewPrompt.Text = prompt; }
        if (ViewModel.Kind == "books")
        {
            var metadata = value["metadata"]?.AsObject(); PublisherInput.Text = metadata?["publisher"]?.ToString() ?? ""; PublishedDateInput.Text = metadata?["publishedDate"]?.ToString() ?? "";
            LanguageInput.Text = metadata?["languages"]?.AsArray().FirstOrDefault()?.ToString() ?? ""; SeriesInput.Text = metadata?["series"]?.ToString() ?? ""; SubjectsInput.Text = string.Join(", ", metadata?["subjects"]?.AsArray().Select(v=>v?.ToString()) ?? []); RatingInput.Value = metadata?["rating"]?.GetValue<double>() ?? 0;
            IsbnInput.Text = metadata?["identifiers"]?.AsArray().FirstOrDefault(v => v?["scheme"]?.ToString() == "ISBN")?["value"]?.ToString() ?? "";
            await ShowCover(value["customCover"]?.ToString() ?? value["cover"]?.ToString()); if (selected != item) return;
            var rows = await LoadItems("folders"); var options = new List<LibraryItem> { new("", "未分类", 0, new()) }; options.AddRange(rows);
            if (selected != item) return;
            FolderInput.ItemsSource = options; FolderInput.SelectedItem = options.FirstOrDefault(f => f.Id == (value["folderId"]?.ToString() ?? ""));
        }
        if (ViewModel.Kind == "studySets") { var books = await LoadItems("books"); if (selected != item) return; StudyBooks.ItemsSource = books; foreach (LibraryItem book in StudyBooks.Items) if (value["bookIds"]?.AsArray().Any(id => id?.ToString() == book.Id) == true) StudyBooks.SelectedItems.Add(book); }
        if (ViewModel.Kind == "mindMaps") { mindRoot = value["root"]?.DeepClone().AsObject(); RenderMind(); }
    }
    private async Task<List<LibraryItem>> LoadItems(string kind)
    {
        var rows = await ViewModel.CommandAsync("list", new { kind }); if (rows is null) return [];
        return rows.Value.EnumerateArray().Select(LibraryItem.FromRecord).ToList();
    }
    private async void NewItem(object sender, RoutedEventArgs args)
    {
        if (ViewModel.Kind == "books") { ImportBooks(sender, args); return; }
        selected = null; Entries.SelectedItem = null; Panels("edit"); TitleInput.Visibility = Visibility.Visible; TitleInput.Text = ""; ContentInput.Text = "";
        ContentInput.IsReadOnly = false;
        ReviewQuestion.Visibility = NotePreview.Visibility = EnrollReviewButton.Visibility = StudyReviewButton.Visibility = Visibility.Collapsed; ContentInput.Visibility = Visibility.Visible;
        PreviewNoteButton.Visibility = ViewModel.Kind == "notes" ? Visibility.Visible : Visibility.Collapsed;
        AuthorInput.Visibility = FolderInput.Visibility = BookMetadataPanel.Visibility = CitationSources.Visibility = TagsInput.Visibility = ClozeInput.Visibility = ReviewControls.Visibility = Visibility.Collapsed;
        StudyBooks.Visibility = ViewModel.Kind == "studySets" ? Visibility.Visible : Visibility.Collapsed;
        MindControls.Visibility = ViewModel.Kind == "mindMaps" ? Visibility.Visible : Visibility.Collapsed;
        if (ViewModel.Kind == "studySets") StudyBooks.ItemsSource = await LoadItems("books");
        mindRoot = new() { ["id"] = Guid.NewGuid().ToString(), ["text"] = "中心主题", ["children"] = new JsonArray() }; RenderMind();
    }
    private async void SaveItem(object sender, RoutedEventArgs args)
    {
        var patch = new JsonObject();
        switch (ViewModel.Kind)
        {
            case "notes": patch["title"] = TitleInput.Text; patch["content"] = ContentInput.Text.Replace("\r\n", "\n").Replace('\r', '\n'); break;
            case "books": patch["title"] = TitleInput.Text; patch["author"] = AuthorInput.Text; if (FolderInput.SelectedItem is LibraryItem folder && folder.Id.Length > 0) patch["folderId"] = folder.Id; break;
            case "folders": patch["name"] = TitleInput.Text; break;
            case "studySets": patch["name"] = TitleInput.Text; patch["description"] = ContentInput.Text; patch["bookIds"] = new JsonArray(StudyBooks.SelectedItems.Cast<LibraryItem>().Select(i => JsonValue.Create(i.Id) as JsonNode).ToArray()); break;
            case "highlights": if (selected is null) { await Message("请在阅读器中选择文段创建书摘。"); return; } patch["name"] = TitleInput.Text; patch["note"] = ContentInput.Text; patch["tags"] = Split(TagsInput.Text); patch["cloze"] = Split(ClozeInput.Text); break;
            case "mindMaps": patch["title"] = TitleInput.Text; patch["root"] = mindRoot?.DeepClone(); break;
            case "associations": if (selected is null) { await Message("请在阅读器中选择关联的两个文段。"); return; } patch["label"] = TitleInput.Text; break;
            default: return;
        }
        var unset = ViewModel.Kind == "books" && FolderInput.SelectedItem is LibraryItem { Id.Length: 0 } ? new[] { "folderId" } : Array.Empty<string>();
        if (ViewModel.Kind == "books") { var metadata = selected?.Value["metadata"]?.DeepClone().AsObject() ?? new JsonObject(); metadata["version"] = 1; metadata["publisher"] = PublisherInput.Text; metadata["publishedDate"] = PublishedDateInput.Text; metadata["description"] = ContentInput.Text; metadata["series"] = SeriesInput.Text; metadata["languages"] = Split(LanguageInput.Text); metadata["subjects"] = Split(SubjectsInput.Text); metadata["rating"] = double.IsNaN(RatingInput.Value) ? 0 : RatingInput.Value; var identifiers = metadata["identifiers"]?.DeepClone().AsArray() ?? new JsonArray(); foreach (var item in identifiers.Where(v=>v?["scheme"]?.ToString()=="ISBN").ToArray()) identifiers.Remove(item); if (!string.IsNullOrWhiteSpace(IsbnInput.Text)) identifiers.Add(new JsonObject { ["scheme"] = "ISBN", ["value"] = IsbnInput.Text }); metadata["identifiers"] = identifiers; patch["metadata"] = metadata; }
        var result = await ViewModel.SaveAsync(selected, patch, unset);
        if (result is not null) Entries.SelectedItem = ViewModel.Items.FirstOrDefault(i => i.Id == result.Value.GetProperty("value").GetProperty("id").GetString());
    }
    private static JsonArray Split(string text) => new(text.Split([',', '，'], StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).Select(s => JsonValue.Create(s) as JsonNode).ToArray());
    private async void DeleteItem(object sender, RoutedEventArgs args)
    {
        if (selected is null) return;
        var dialog = new ContentDialog { Title = $"删除“{selected.Title}”？", Content = "关联记录将按业务规则一起清理。", PrimaryButtonText = "删除", CloseButtonText = "取消", XamlRoot = Navigation.XamlRoot };
        if (await dialog.ShowAsync() == ContentDialogResult.Primary) await ViewModel.DeleteAsync(selected);
    }
    private async void ImportBooks(object sender, RoutedEventArgs args)
    {
        var picker = new FileOpenPicker(); WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        foreach (var extension in new[] { ".pdf", ".epub", ".mobi", ".azw", ".azw3", ".fb2", ".txt" }) picker.FileTypeFilter.Add(extension);
        var files = await picker.PickMultipleFilesAsync(); taskCancellation = new();
        foreach (var file in files) { if (taskCancellation.IsCancellationRequested) break; await ViewModel.ImportAsync(file.Path, "original", taskCancellation.Token); }
    }
    private void CancelTask(object sender, RoutedEventArgs args) => taskCancellation.Cancel();
    private async void RefreshList(object sender, RoutedEventArgs args) => await ViewModel.RefreshAsync();
    private async void ImportPath(object sender, RoutedEventArgs args)
    {
        var input = new TextBox { Header = "本机书籍的绝对路径（每行一个）", AcceptsReturn = true, MinWidth = 520, MinHeight = 100 };
        var dialog = new ContentDialog { Title = "导入书籍", Content = input, PrimaryButtonText = "导入", CloseButtonText = "取消", XamlRoot = Navigation.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        taskCancellation = new(); await ViewModel.SelectKindAsync("books"); screen = "books"; Heading.Text = "书库";
        foreach (var path in input.Text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)) { if (taskCancellation.IsCancellationRequested) break; await ViewModel.ImportAsync(path.Trim('"'), "original", taskCancellation.Token); }
    }
    private async Task ShowCover(string? data)
    {
        CoverImage.Source = null; if (data is null || !data.StartsWith("data:image/", StringComparison.Ordinal)) return;
        try { var bytes = Convert.FromBase64String(data[(data.IndexOf(',') + 1)..]); using var stream = new MemoryStream(bytes); var bitmap = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(); await bitmap.SetSourceAsync(stream.AsRandomAccessStream()); CoverImage.Source = bitmap; } catch (Exception e) when (e is FormatException or ArgumentException or System.Runtime.InteropServices.COMException) { }
    }
    private async void SetCover(object sender, RoutedEventArgs args)
    {
        if (selected is null || ViewModel.Kind != "books") return;
        var picker = new FileOpenPicker(); foreach (var extension in new[] { ".png", ".jpg", ".jpeg", ".webp" }) picker.FileTypeFilter.Add(extension); WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this)); var file = await picker.PickSingleFileAsync(); if (file is null) return;
        var current = selected; var saved = await ViewModel.CommandAsync("setCover", new { id = current.Id, expected = current.Revision, path = file.Path }); if (saved is null) return; await ViewModel.RefreshAsync(); Entries.SelectedItem = ViewModel.Items.FirstOrDefault(i=>i.Id==current.Id);
    }
    private async void LookupMetadata(object sender, RoutedEventArgs args)
    {
        if (selected is null || ViewModel.Kind != "books") return;
        var current = selected;
        var query = new TextBox { Text = string.IsNullOrWhiteSpace(IsbnInput.Text) ? TitleInput.Text + " " + AuthorInput.Text : "isbn:" + IsbnInput.Text, Header = "发送至 Open Library 的书名 / 作者 / ISBN", MinWidth = 400 };
        var ask = new ContentDialog { Title = "查找书籍元数据", Content = query, PrimaryButtonText = "查询", CloseButtonText = "取消", XamlRoot = Navigation.XamlRoot };
        if (await ask.ShowAsync() != ContentDialogResult.Primary) return;
        taskCancellation.Dispose(); taskCancellation = new();
        var start = await ViewModel.CommandAsync("lookupMetadata", new { query = query.Text }); if (start is null) return;
        var result = await ViewModel.AwaitJobAsync(start.Value.GetProperty("job").GetString()!, taskCancellation.Token); if (result is null) return;
        var items = result.Value.EnumerateArray().Select(v => JsonNode.Parse(v.GetRawText())!.AsObject()).ToArray();
        if (items.Length == 0) { await Message("未找到匹配书籍，可以调整书名或 ISBN 后重试。"); return; }
        var list = new ComboBox { ItemsSource = items.Select(v => v["title"] + " · " + v["author"] + " · " + v["metadata"]?["publisher"] + " · " + v["metadata"]?["publishedDate"]).ToArray(), SelectedIndex = 0, MinWidth = 400 };
        var replaceTitle = new CheckBox { Content = "同时替换标题与作者", IsChecked = false };
        var preview=new TextBlock {TextWrapping=TextWrapping.Wrap,MaxWidth=500};
        void PreviewCandidate(){if(list.SelectedIndex>=0){var metadata=items[list.SelectedIndex]["metadata"]!;preview.Text="ISBN："+string.Join("、",metadata["identifiers"]!.AsArray().Select(v=>v!["value"]!.ToString()))+"\n语言："+string.Join("、",metadata["languages"]!.AsArray().Select(v=>v!.ToString()));}}
        list.SelectionChanged+=(_,_)=>PreviewCandidate();PreviewCandidate();
        var panel = new StackPanel { Spacing = 12 }; panel.Children.Add(list); panel.Children.Add(preview); panel.Children.Add(replaceTitle); panel.Children.Add(new TextBlock { Text = "结果可能汇总多个版本，请核对 ISBN、语言与出版信息。已有评分、封面和丛书保留；未勾选时保留标题与作者。", TextWrapping = TextWrapping.Wrap });
        var choose = new ContentDialog { Title = "选择候选项", Content = panel, PrimaryButtonText = "应用", CloseButtonText = "取消", XamlRoot = Navigation.XamlRoot };
        if (await choose.ShowAsync() != ContentDialogResult.Primary || list.SelectedIndex < 0) return;
        var candidate = items[list.SelectedIndex]; var metadata = current.Value["metadata"]?.DeepClone().AsObject() ?? new JsonObject { ["version"] = 1 };
        foreach (var field in candidate["metadata"]!.AsObject()) if ((field.Key != "contributors" || replaceTitle.IsChecked == true) && field.Value is not null && field.Value.ToString() != "" && (field.Value is not JsonArray array || array.Count != 0)) metadata[field.Key] = field.Value.DeepClone();
        var patch = new JsonObject { ["metadata"] = metadata };
        if (replaceTitle.IsChecked == true) { patch["title"] = candidate["title"]?.DeepClone(); patch["author"] = candidate["author"]?.DeepClone(); }
        var saved = await ViewModel.CommandAsync("save", new { kind = "books", id = current.Id, expected = current.Revision, patch });
        if (saved is not null) { await ViewModel.RefreshAsync(); Entries.SelectedItem = ViewModel.Items.FirstOrDefault(i => i.Id == current.Id); }
    }
    private async void ClearCover(object sender, RoutedEventArgs args) { if (selected is null || ViewModel.Kind != "books") return; var id = selected.Id; if (await ViewModel.SaveAsync(selected, new(), ["customCover"]) is not null) Entries.SelectedItem = ViewModel.Items.FirstOrDefault(i=>i.Id==id); }
    private async void OpenReader(object sender, RoutedEventArgs args)
    {
        if (selected is null) return;
        var anchor = ViewModel.Kind == "notes" && CitationSources.SelectedItem is LibraryItem citation ? citation.Value : selected.Value["source"]?.AsObject() ?? selected.Value;
        var id = ViewModel.Kind == "books" ? selected.Id : anchor["bookId"]?.ToString();
        if (id is null) return;
        var result = await ViewModel.CommandAsync("get", new { kind = "books", id }); if (result is null) return;
        var value = JsonNode.Parse(result.Value.GetProperty("value").GetRawText())!.AsObject();
        readingBook = new(id, value["title"]!.ToString(), result.Value.GetProperty("revision").GetUInt64(), value);
        selection = null; readingSession = Guid.NewGuid().ToString(); activeSeconds = 0;
        string? original = null;
        if (value["format"]?.ToString() == "pdf") { var resource = await ViewModel.CommandAsync("bookResource", new { id }); original = resource?.GetProperty("path").GetString(); }
        var marks = await ReaderHighlights(id);
        JsonObject? rendition = null;
        if (value["format"]?.ToString() == "epub") { var data = await ViewModel.CommandAsync("epubRendition", new { id }); if (data is not null) rendition = JsonNode.Parse(data.Value.GetRawText())!.AsObject(); }
        var outline = await ViewModel.CommandAsync("outline", new { id });
        Panels("reader"); renderer?.Present(value, original, marks, new JsonArray((await LoadItems("translations")).Where(t=>t.Value["bookId"]?.ToString()==id).Select(t=>t.Value.DeepClone()).ToArray()), rendition, outline is null ? null : JsonNode.Parse(outline.Value.GetRawText())!.AsArray());
        if (ViewModel.Kind != "books") renderer?.Jump(anchor);
    }
    private void CloseReader(object sender, RoutedEventArgs args) => Panels("edit");
    private async void ReaderGesture(JsonObject message)
    {
        if (message["type"]?.ToString() == "outlineEdit" && readingBook is not null)
        {
            var command = message.DeepClone().AsObject(); command.Remove("type"); command["id"] = readingBook.Id; command["expected"] = readingBook.Revision;
            if (command["action"]?.ToString() == "add") { if (selection is null) { await Message("请先选择正文作为目录位置。"); return; } command["target"] = selection.DeepClone(); }
            var saved = await ViewModel.CommandAsync("editOutline", command);
            if (saved is not null) { readingBook = LibraryItem.FromRecord(saved.Value); renderer?.Outline(readingBook.Value["outline"]!.AsArray()); }
            return;
        }
        if (message["type"]?.ToString() == "preferences" && message["value"] is JsonObject preferences) { var result = await ViewModel.CommandAsync("save", new { kind = "preferences", id = "reader", expected = readerPreferencesRevision, patch = preferences }); if (result is not null) { readerPreferencesRevision = result.Value.GetProperty("revision").GetUInt64(); renderer!.Preferences = preferences.DeepClone().AsObject(); } return; }
        if (message["type"]?.ToString() == "selection" && message["anchor"]?["bookId"]?.ToString() == readingBook?.Id) selection = message["anchor"]?.DeepClone().AsObject();
        if (message["type"]?.ToString() == "progress" && message["bookId"]?.ToString() == readingBook?.Id)
        {
            await Checkpoint(new JsonObject { ["chapterId"] = message["chapterId"]?.ToString(), ["ratio"] = message["ratio"]?.GetValue<double>() ?? 0 });
        }
        if (message["type"]?.ToString() == "readerMode" && readingBook is not null && message["bookId"]?.ToString() == readingBook.Id) { var saved = await ViewModel.CommandAsync("save", new { kind = "books", id = readingBook.Id, expected = readingBook.Revision, patch = new { readerMode = message["mode"]?.ToString() } }); if (saved is not null) { readingBook = LibraryItem.FromRecord(saved.Value); if (ViewModel.Kind == "books") selected = LibraryItem.RebaseReading(selected, readingBook); } }
    }
    private async Task Checkpoint(JsonObject? progress)
    {
        if (readingBook is null || progress is null || checkpointBusy) return;
        checkpointBusy = true; var current = readingBook;
        try { var saved = await ViewModel.CommandAsync("checkpoint", new { id = current.Id, session = readingSession, activeSeconds, progress }); if (saved is not null && readingBook?.Id == current.Id) { readingBook = LibraryItem.FromRecord(saved.Value); if (ViewModel.Kind == "books") selected = LibraryItem.RebaseReading(selected, readingBook); } }
        finally { checkpointBusy = false; }
    }
    private async Task<JsonElement?> SaveSelection()
    {
        if (selection is null) { await Message("请先选择一段正文。"); return null; }
        var patch = selection.DeepClone().AsObject(); patch.Remove("kind"); patch["style"] = new JsonObject { ["kind"] = "background", ["color"] = "yellow" };
        return await ViewModel.CommandAsync("save", new { kind = "highlights", id = Guid.NewGuid().ToString(), expected = 0, patch });
    }
    private async Task<JsonArray> ReaderHighlights(string id) => new((await LoadItems("highlights")).Where(h=>h.Value["bookId"]?.ToString()==id).Select(h=>h.Value.DeepClone()).ToArray());
    private async void HighlightSelection(object sender, RoutedEventArgs args) { if (await SaveSelection() is not null && readingBook is not null) renderer?.Highlights(await ReaderHighlights(readingBook.Id)); }
    private async void CiteSelection(object sender, RoutedEventArgs args)
    {
        var notes = await LoadItems("notes"); var picker = new ComboBox { ItemsSource = notes, DisplayMemberPath = "Title", MinWidth = 320 };
        var dialog = new ContentDialog { Title = "引用到笔记", Content = picker, PrimaryButtonText = "引用", CloseButtonText = "取消", XamlRoot = Navigation.XamlRoot };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary || picker.SelectedItem is not LibraryItem note) return;
        var highlight = await SaveSelection(); if (highlight is null) return;
        await ViewModel.CommandAsync("cite", new { highlight = highlight.Value.GetProperty("value").GetProperty("id").GetString(), note = note.Id, highlightRevision = highlight.Value.GetProperty("revision").GetUInt64(), noteRevision = note.Revision });
        if (readingBook is not null) renderer?.Highlights(await ReaderHighlights(readingBook.Id));
    }
    private void PinAssociation(object sender, RoutedEventArgs args) => associationStart = selection?.DeepClone().AsObject();
    private async void CreateAssociation(object sender, RoutedEventArgs args)
    {
        if (selection is null || associationStart is null) { await Message("请分别选择起点和终点文段。"); return; }
        await ViewModel.CommandAsync("save", new { kind = "associations", id = Guid.NewGuid().ToString(), expected = 0, patch = new { source = associationStart, target = selection, direction = "bidirectional", label = "关联" } });
    }
    private void RevealReview(object sender, RoutedEventArgs args) => ReviewPrompt.Text = selected?.Value["text"]?.ToString() ?? "";
    private async void Rate(object sender, RoutedEventArgs args)
    {
        if (selected is null) return;
        if (await ViewModel.CommandAsync("review", new { id = selected.Id, rating = int.Parse(((Button)sender).Tag.ToString()!), expected = selected.Revision }) is null) return;
        await ViewModel.RefreshAsync();
        selected = null; ReviewPrompt.Text = "本轮复习已完成";
        if (ViewModel.Items.Count > 0) Entries.SelectedIndex = 0;
    }
    private void RenderMind()
    {
        MindTree.RootNodes.Clear(); mindNodes.Clear(); if (mindRoot is null) return;
        TreeViewNode Node(JsonObject data) { var node = new TreeViewNode { Content = data["text"]?.ToString() ?? "", IsExpanded = true }; mindNodes[node] = data; foreach (var child in data["children"]?.AsArray() ?? []) if (child is JsonObject value) node.Children.Add(Node(value)); return node; }
        MindTree.RootNodes.Add(Node(mindRoot));
    }
    private void SelectMindNode(TreeView sender, TreeViewItemInvokedEventArgs args) { selectedTreeNode = args.InvokedItem as TreeViewNode; if (selectedTreeNode is not null && mindNodes.TryGetValue(selectedTreeNode, out var value)) { mindNode = value; MindNodeText.Text = value["text"]?.ToString() ?? ""; } }
    private void UpdateMindNode(object sender, RoutedEventArgs args) { if (mindNode is null) return; mindNode["text"] = MindNodeText.Text; RenderMind(); }
    private void AddMindNode(object sender, RoutedEventArgs args) { var target = mindNode ?? mindRoot; target?["children"]?.AsArray().Add(new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["text"] = "新节点", ["children"] = new JsonArray() }); RenderMind(); }
    private void DeleteMindNode(object sender, RoutedEventArgs args) { if (mindNode?.Parent is JsonArray parent) { parent.Remove(mindNode); mindNode = null; RenderMind(); } }
    private void RenderGraph()
    {
        GraphCanvas.Children.Clear(); var nodes = new Dictionary<string, (double X, double Y)>();
        foreach (var item in ViewModel.Items) foreach (var endpoint in new[] { "source", "target" }) { var id = item.Value[endpoint]?["bookId"]?.ToString(); if (id is not null && !nodes.ContainsKey(id)) { var i = nodes.Count; nodes[id] = (80 + i % 4 * 210, 80 + i / 4 * 160); } }
        foreach (var item in ViewModel.Items) { var from = item.Value["source"]?["bookId"]?.ToString(); var to = item.Value["target"]?["bookId"]?.ToString(); if (from is null || to is null) continue; var a = nodes[from]; var b = nodes[to]; GraphCanvas.Children.Add(new Line { X1 = a.X, Y1 = a.Y, X2 = b.X, Y2 = b.Y, Stroke = new SolidColorBrush(Microsoft.UI.Colors.SteelBlue), StrokeThickness = 2 }); var button = new Button { Content = item.Value["label"]?.ToString() ?? "关联", Tag = item }; button.Click += (_, _) => { Entries.SelectedItem = item; }; Canvas.SetLeft(button, (a.X + b.X) / 2); Canvas.SetTop(button, (a.Y + b.Y) / 2); GraphCanvas.Children.Add(button); }
        foreach (var node in nodes) { var label = new TextBlock { Text = bookTitles.GetValueOrDefault(node.Key, node.Key), MaxWidth = 180, TextWrapping = TextWrapping.Wrap }; Canvas.SetLeft(label, node.Value.X); Canvas.SetTop(label, node.Value.Y); GraphCanvas.Children.Add(label); }
    }
    private void ShowAi(object sender, RoutedEventArgs args) { aiFromReader = ReaderPanel.Visibility == Visibility.Visible; aiAnchor = (aiFromReader ? selection : ViewModel.Kind == "highlights" ? selected?.Value : null)?.DeepClone().AsObject(); aiBookId = aiFromReader ? readingBook?.Id : ViewModel.Kind == "books" ? selected?.Id : selected?.Value["bookId"]?.ToString(); Panels("ai"); AiContext.Text = aiAnchor?["text"]?.ToString() ?? selected?.Value["content"]?.ToString() ?? selected?.Value["text"]?.ToString() ?? ""; }
    private void CloseAi(object sender, RoutedEventArgs args) => Panels(aiFromReader ? "reader" : "edit");
    private async Task LoadAiSettings()
    {
        ServiceAutoStart.IsChecked = ServiceController.AutoStartEnabled;
        var config = await ViewModel.CommandAsync("aiConfig"); if (config is null) return;
        aiRevision = config.Value.GetProperty("revision").GetUInt64(); var value = config.Value.GetProperty("value");
        ProviderInput.SelectedItem = value.GetProperty("provider").GetString(); ModelInput.Text = value.GetProperty("model").GetString() ?? ""; EffortInput.SelectedItem = value.GetProperty("effort").GetString(); ApiKeyInput.Password = "";
    }
    private async void SaveAiSettings(object sender, RoutedEventArgs args)
    {
        if (await ViewModel.CommandAsync("saveAiConfig", new { expected = aiRevision, apiKey = ApiKeyInput.Password, config = new { provider = ProviderInput.SelectedItem?.ToString(), model = ModelInput.Text, effort = EffortInput.SelectedItem?.ToString() } }) is not null) await LoadAiSettings();
    }
    private async Task RunAiTask(string task, Action<string> output)
    {
        taskCancellation = new(); var start = await ViewModel.CommandAsync("ai", new { task, text = AiContext.Text, question = AiQuestion.Text, targetLang = "中文", bookId = task == "digest" ? aiBookId : null }); if (start is null) return;
        var result = await ViewModel.AwaitJobAsync(start.Value.GetProperty("job").GetString()!, taskCancellation.Token, output); if (result is not null) output(result.Value.TryGetProperty("text", out var text) ? text.GetString() ?? "" : result.Value.ToString());
    }
    private async void RunAi(object sender, RoutedEventArgs args) { AiAnswer.Text = ""; await RunAiTask((AiTask.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "chat", text => AiAnswer.Text = text); }
    private async void TestAi(object sender, RoutedEventArgs args) => await RunAiTask("test", text => ModelsResult.Text = text);
    private async void ListModels(object sender, RoutedEventArgs args) => await RunAiTask("models", text => ModelsResult.Text = text);
    private async void SaveAiNote(object sender, RoutedEventArgs args) => await ViewModel.CommandAsync("save", new { kind = "notes", id = Guid.NewGuid().ToString(), expected = 0, patch = new { title = string.IsNullOrWhiteSpace(AiQuestion.Text) ? "AI 阅读笔记" : AiQuestion.Text, content = AiAnswer.Text } });
    private async void StartService(object sender, RoutedEventArgs args) { try { if (await PersistServicePort()) ServiceStatus.Text = await ServiceController.StartAsync(savedServicePort); } catch (Exception error) { ServiceStatus.Text = error.Message; } }
    private async void StopService(object sender, RoutedEventArgs args) { try { ServiceStatus.Text = await ServiceController.StopAsync(savedServicePort); } catch (Exception error) { ServiceStatus.Text = error.Message; } }
    private async void ChangeAutoStart(object sender, RoutedEventArgs args) { try { if (!await PersistServicePort()) { ServiceAutoStart.IsChecked = ServiceController.AutoStartEnabled; return; } ServiceController.SetAutoStart(ServiceAutoStart.IsChecked == true, savedServicePort); ServiceStatus.Text = "启动选项已保存"; } catch (Exception error) { ServiceStatus.Text = error.Message; ServiceAutoStart.IsChecked = ServiceController.AutoStartEnabled; } }
    private async void CopyServiceToken(object sender, RoutedEventArgs args) { var result = await ViewModel.CommandAsync("serviceToken"); if (result is null) return; var data = new global::Windows.ApplicationModel.DataTransfer.DataPackage(); data.SetText(result.Value.GetProperty("token").GetString()!); global::Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(data); ServiceStatus.Text = "令牌已复制。请只提供给受信任的本地客户端。"; }
    private async void BackupWorkspace(object sender, RoutedEventArgs args)
    {
        var picker = new FileSavePicker { SuggestedFileName = $"书房备份-{DateTime.Now:yyyyMMdd-HHmmss}" }; picker.FileTypeChoices.Add("工作区备份", new List<string> { ".zip" }); WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var file = await picker.PickSaveFileAsync(); if (file is null) return;
        // The save picker creates an empty placeholder; only remove that exact empty selection.
        var properties = await file.GetBasicPropertiesAsync(); if (properties.Size != 0) { await Message("请选择新的备份文件名。"); return; } await file.DeleteAsync();
        var start = await ViewModel.CommandAsync("backup", new { path = file.Path }); if (start is not null) { var saved = await ViewModel.AwaitJobAsync(start.Value.GetProperty("job").GetString()!, CancellationToken.None); if (saved is not null) await Message("备份已完成：" + file.Path); }
    }
    private async void RestoreWorkspace(object sender, RoutedEventArgs args)
    {
        var picker = new FileOpenPicker(); picker.FileTypeFilter.Add(".zip"); WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this)); var file = await picker.PickSingleFileAsync(); if (file is null) return;
        var folderPicker = new FolderPicker(); folderPicker.FileTypeFilter.Add("*"); WinRT.Interop.InitializeWithWindow.Initialize(folderPicker, WinRT.Interop.WindowNative.GetWindowHandle(this)); var parent = await folderPicker.PickSingleFolderAsync(); if (parent is null) return;
        var destination = Path.Combine(parent.Path, "Shufang-Restored-" + DateTime.Now.ToString("yyyyMMdd-HHmmss")); var start = await ViewModel.CommandAsync("restore", new { path = file.Path, destination }); if (start is null) return;
        var restored = await ViewModel.AwaitJobAsync(start.Value.GetProperty("job").GetString()!, CancellationToken.None); if (restored is null) return;
        var process = new System.Diagnostics.ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "Shufang.Windows.exe")) { UseShellExecute = false }; process.ArgumentList.Add("--workspace"); process.ArgumentList.Add(destination); System.Diagnostics.Process.Start(process); await Message("已恢复到新工作区：" + destination);
    }
    private async void SaveAiGenerated(object sender, RoutedEventArgs args)
    {
        var task = (AiTask.SelectedItem as ComboBoxItem)?.Tag?.ToString();
        var saved = await ViewModel.CommandAsync("saveAiResult", new { task, text = AiAnswer.Text, anchor = aiAnchor, bookId = aiBookId, title = string.IsNullOrWhiteSpace(AiQuestion.Text) ? "AI 阅读成果" : AiQuestion.Text });
        if (saved is not null) await Message("已保存到书库，请从脑图或书摘中查看。");
    }
    private async Task LoadSyncSettings()
    {
        var config = await ViewModel.CommandAsync("syncConfig");
        if (config is null) return;
        syncRevision = config.Value.GetProperty("revision").GetUInt64();
        var identity = config.Value.GetProperty("identity");
        SyncIdentity.Text = $"工作区：{identity.GetProperty("workspaceId").GetString()} / 本节点：{identity.GetProperty("nodeId").GetString()}";
        SyncPeers.ItemsSource = config.Value.GetProperty("peers").EnumerateArray().Select(p => new LibraryItem(p.GetProperty("id").GetString()!, $"{p.GetProperty("id").GetString()} · {p.GetProperty("url").GetString()}", 0, JsonNode.Parse(p.GetRawText())!.AsObject())).ToArray();
        var status = await ViewModel.CommandAsync("syncStatus");
        var lines = new List<string> { config.Value.GetProperty("paused").GetBoolean() ? "同步已暂停；正在执行的请求会完成。" : "同步已启用。独立服务运行时自动重试。" };
        if (status is not null && status.Value.GetProperty("peers").ValueKind == JsonValueKind.Object)
            foreach (var peer in status.Value.GetProperty("peers").EnumerateObject()) {
                var value = peer.Value;
                lines.Add($"{peer.Name}：最近成功 {(value.TryGetProperty("lastSuccess", out var last) ? last.GetString() : "尚未成功")}；错误 {(value.TryGetProperty("error", out var error) && error.ValueKind != JsonValueKind.Null ? error.GetString() : "无")}");
            }
        if (status is not null && status.Value.TryGetProperty("worker",out var worker) && worker.ValueKind==JsonValueKind.Object && worker.TryGetProperty("error",out var configurationError) && configurationError.ValueKind==JsonValueKind.String) lines.Add("同步配置不可用，请检查本机凭据配置。");
        SyncStatus.Text = string.Join("\n", lines);
    }
    private void SelectSyncPeer(object sender, SelectionChangedEventArgs args)
    {
        if (SyncPeers.SelectedItem is not LibraryItem item) return;
        SyncPeerId.Text = item.Id; SyncPeerUrl.Text = item.Value["url"]!.ToString(); SyncPeerToken.Password = "";
    }
    private async void SaveSyncPeer(object sender, RoutedEventArgs args)
    {
        if (await ViewModel.CommandAsync("saveSyncPeer", new { expected = syncRevision, id = SyncPeerId.Text.Trim(), url = SyncPeerUrl.Text.Trim(), token = SyncPeerToken.Password }) is null) return;
        SyncPeerToken.Password = ""; await LoadSyncSettings();
    }
    private async void RemoveSyncPeer(object sender, RoutedEventArgs args)
    {
        if (SyncPeers.SelectedItem is not LibraryItem item) return;
        if (await ViewModel.CommandAsync("removeSyncPeer", new { expected = syncRevision, id = item.Id }) is not null) await LoadSyncSettings();
    }
    private async void ResumeSync(object sender, RoutedEventArgs args)
    {
        try {
            if (!await PersistServicePort()) return;
            await ServiceController.StartAsync(savedServicePort);
            if (await ViewModel.CommandAsync("pauseSync", new { expected = syncRevision, paused = false }) is not null) { await ViewModel.CommandAsync("requestSync"); await LoadSyncSettings(); }
        } catch (Exception error) { SyncStatus.Text = error.Message; }
    }
    private async void PauseSync(object sender, RoutedEventArgs args) { if (await ViewModel.CommandAsync("pauseSync", new { expected = syncRevision, paused = true }) is not null) await LoadSyncSettings(); }
    private async void RequestSync(object sender, RoutedEventArgs args)
    {
        try { await ServiceController.StartAsync(savedServicePort); if (await ViewModel.CommandAsync("requestSync") is not null) { await LoadSyncSettings(); SyncStatus.Text += "\n已请求立即同步；稍后刷新查看结果。"; } }
        catch (Exception error) { SyncStatus.Text = error.Message; }
    }
    private async void RefreshSync(object sender, RoutedEventArgs args) => await LoadSyncSettings();
    private async Task LoadServiceSettings()
    {
        var preferences = (await LoadItems("preferences")).FirstOrDefault(p => p.Id == "windows-service");
        servicePreferencesRevision = preferences?.Revision ?? 0;
        savedServicePort = int.TryParse(preferences?.Value["port"]?.ToString(), out var port) && port is >= 1024 and <= 65535 ? port : 31417;
        ServicePort.Value = savedServicePort;
        ServiceStatus.Text = await ServiceController.StatusAsync(savedServicePort);
    }
    private async Task<bool> PersistServicePort()
    {
        var port = ServicePort.Value;
        if (double.IsNaN(port) || port != Math.Truncate(port) || port is < 1024 or > 65535) throw new InvalidOperationException("端口必须是 1024–65535 的整数");
        if (port != savedServicePort && await ServiceController.IsRunningAsync(savedServicePort)) throw new InvalidOperationException("请先停止当前服务，再修改端口。");
        var saved = await ViewModel.CommandAsync("save", new { kind = "preferences", id = "windows-service", expected = servicePreferencesRevision, patch = new { port = (int)port } });
        if (saved is null) return false;
        savedServicePort = (int)port; servicePreferencesRevision = saved.Value.GetProperty("revision").GetUInt64();
        if (ServiceController.AutoStartEnabled) ServiceController.SetAutoStart(true, savedServicePort);
        return true;
    }
    private async void SaveServicePort(object sender, RoutedEventArgs args) { try { if (await PersistServicePort()) ServiceStatus.Text = await ServiceController.StatusAsync(savedServicePort); } catch (Exception error) { ServiceStatus.Text = error.Message; } }
    private async void ToggleReview(object sender, RoutedEventArgs args)
    {
        if (selected is null) return; var id = selected.Id;
        if (await ViewModel.CommandAsync("setReview", new { id, expected = selected.Revision, enabled = selected.Value["review"] is null }) is null) return;
        await ViewModel.RefreshAsync(); Entries.SelectedItem = ViewModel.Items.FirstOrDefault(i => i.Id == id);
    }
    private async void ReviewStudySet(object sender, RoutedEventArgs args)
    {
        if (selected is null) return; var id = selected.Id; var title = selected.Title;
        screen = "review"; ViewModel.Reviewing = true; ViewModel.ReviewStudySet = id;
        Heading.Text = "复习 · " + title; await ViewModel.SelectKindAsync("highlights");
        selected = null; StudyBooks.Visibility = StudyReviewButton.Visibility = Visibility.Collapsed;
        ContentInput.Visibility = Visibility.Collapsed; ReviewQuestion.Visibility = Visibility.Visible;
        ReviewPrompt.Text = "此学习集当前没有到期卡片";
        if (ViewModel.Items.Count > 0) Entries.SelectedIndex = 0;
    }
    private void PreviewNote(object sender, RoutedEventArgs args)
    {
        if (NotePreview.Visibility == Visibility.Visible) { NotePreview.Visibility = Visibility.Collapsed; ContentInput.Visibility = Visibility.Visible; return; }
        NotePreview.Blocks.Clear();
        foreach (var block in NotePresentation.Parse(ContentInput.Text))
        {
            var paragraph = new Microsoft.UI.Xaml.Documents.Paragraph { Margin = new Thickness(0, 5, 0, 9) };
            if (block.Kind.StartsWith("heading")) { paragraph.FontSize = block.Kind == "heading1" ? 28 : block.Kind == "heading2" ? 23 : 20; paragraph.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold; }
            if (block.Kind == "quote") { paragraph.Margin = new Thickness(18, 5, 0, 9); paragraph.FontStyle = global::Windows.UI.Text.FontStyle.Italic; }
            if (block.Kind == "code") paragraph.FontFamily = new FontFamily("Consolas");
            foreach (var inline in block.Inlines)
            {
                var run = new Microsoft.UI.Xaml.Documents.Run { Text = inline.Text };
                if (inline.Kind == "strong") run.FontWeight = Microsoft.UI.Text.FontWeights.Bold;
                if (inline.Kind == "code") run.FontFamily = new FontFamily("Consolas");
                if (inline.Kind == "link") { var link = new Microsoft.UI.Xaml.Documents.Hyperlink(); link.Inlines.Add(run); var title = inline.Text; link.Click += async (_, _) => await OpenWikiTitle(title); paragraph.Inlines.Add(link); }
                else paragraph.Inlines.Add(run);
            }
            NotePreview.Blocks.Add(paragraph);
        }
        ContentInput.Visibility = Visibility.Collapsed; NotePreview.Visibility = Visibility.Visible;
    }
    private async Task OpenWikiTitle(string title)
    {
        foreach (var kind in new[] { "notes", "books" })
        {
            var target = (await LoadItems(kind)).FirstOrDefault(i => string.Equals(i.Title, title, StringComparison.OrdinalIgnoreCase));
            if (target is null) continue;
            screen = kind; ViewModel.Reviewing = false; await ViewModel.SelectKindAsync(kind);
            Heading.Text = kind == "notes" ? "笔记" : "书库"; Entries.SelectedItem = ViewModel.Items.FirstOrDefault(i => i.Id == target.Id); return;
        }
        await Message("没有找到“" + title + "”，请先新建同名笔记。");
    }
    private async Task LoadWebhooks()
    {
        var hooks = await ServiceController.RequestAsync(savedServicePort, "GET", "/api/native/v1/webhooks");
        Webhooks.ItemsSource = hooks.GetProperty("webhooks").EnumerateArray().Select(v => new LibraryItem(v.GetProperty("id").GetString()!, v.GetProperty("url").GetString()!, 0, new())).ToArray();
        var deliveries = await ServiceController.RequestAsync(savedServicePort, "GET", "/admin/webhook-deliveries");
        WebhookDeliveries.ItemsSource = deliveries.GetProperty("deliveries").EnumerateArray().Select(v=>new LibraryItem(v.GetProperty("id").GetString()!, $"{v.GetProperty("event")} · 已尝试 {v.GetProperty("attempts")} 次", 0, new())).ToArray();
    }
    private async Task LoadUpdateSettings()
    {
        var saved=(await LoadItems("preferences")).FirstOrDefault(p=>p.Id=="windows-update");
        if(saved is not null){updateRevision=saved.Revision;UpdateFeedInput.Text=saved.Value["feed"]?.ToString()??"";UpdateKeyInput.Text=saved.Value["publicKey"]?.ToString()??"";AutomaticUpdateCheck.IsChecked=saved.Value["automaticCheck"]?.GetValue<bool>()??false;}
        var result=Path.Combine(WorkspaceFactory.DirectoryPath,".updates","update-result.json");if(File.Exists(result))UpdateStatus.Text=File.ReadAllText(result);
    }
    private async void SaveUpdateSettings(object sender,RoutedEventArgs args)
    {
        try {
            var uri=new Uri(UpdateFeedInput.Text);if(uri.Scheme!="https"||!string.IsNullOrEmpty(uri.UserInfo))throw new InvalidDataException("更新源必须使用 HTTPS");
            var fingerprint=UpdatePackage.KeyFingerprint(UpdateKeyInput.Text);
            var saved=await ViewModel.CommandAsync("save",new{kind="preferences",id="windows-update",expected=updateRevision,patch=new{feed=uri.AbsoluteUri,publicKey=UpdateKeyInput.Text,keyFingerprint=fingerprint,automaticCheck=AutomaticUpdateCheck.IsChecked==true}});
            if(saved is not null){updateRevision=saved.Value.GetProperty("revision").GetUInt64();updateRelease=null;updateStaging=null;DownloadUpdateButton.IsEnabled=InstallUpdateButton.IsEnabled=false;UpdateStatus.Text="已保存可信公钥指纹："+fingerprint;}
        }catch(Exception error){UpdateStatus.Text=error.Message;}
    }
    private async void CheckUpdate(object sender,RoutedEventArgs args)
    {
        try {
            taskCancellation.Dispose();taskCancellation=new();DownloadUpdateButton.IsEnabled=InstallUpdateButton.IsEnabled=false;updateStaging=null;
            var saved=(await LoadItems("preferences")).FirstOrDefault(p=>p.Id=="windows-update")??throw new InvalidDataException("请先保存更新源与可信公钥");
            UpdateStatus.Text="正在读取签名更新清单";updatePublicKey=saved.Value["publicKey"]!.ToString();updateEnvelope=await UpdatePackage.FetchFeedAsync(new Uri(saved.Value["feed"]!.ToString()),taskCancellation.Token);
            updateRelease=UpdatePackage.Verify(updateEnvelope,updatePublicKey,InstalledVersion);DownloadUpdateButton.IsEnabled=true;UpdateStatus.Text=$"发现 {updateRelease.Version}，{updateRelease.Size/1024/1024} MiB。\n{updateRelease.Notes}";UpdateNotice.Text=$"发现签名更新 {updateRelease.Version}，请在设置中下载并更新。";
        }catch(Exception error){UpdateStatus.Text=error.Message;UpdateNotice.Text="更新检查："+error.Message;}
    }
    private async void DownloadUpdate(object sender,RoutedEventArgs args)
    {
        if(updateRelease is null)return;
        try {DownloadUpdateButton.IsEnabled=false;UpdateStatus.Text="正在下载、校验签名包和全部文件";taskCancellation.Dispose();taskCancellation=new();
            var staging=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","Shufang",".staging",Guid.NewGuid().ToString("N"));
            updateStaging=await UpdatePackage.StageAsync(updateRelease,staging,taskCancellation.Token);InstallUpdateButton.IsEnabled=true;UpdateStatus.Text="更新包已完整校验，关闭并更新将停止当前窗口、备份数据并启动新版。";
        }catch(Exception error){UpdateStatus.Text=error.Message;DownloadUpdateButton.IsEnabled=true;}
    }
    private async void InstallUpdate(object sender,RoutedEventArgs args)
    {
        if(updateStaging is null||updateEnvelope is null||updatePublicKey is null)return;
        try {
            if(await ServiceController.IsRunningAsync(savedServicePort)){await Message("请先停止独立服务，再安装更新。");return;}
            var dialog=new ContentDialog{Title="安装已校验的更新",Content="请先保存正在编辑的内容。安装将关闭当前窗口，备份工作区后启动新版；启动失败保留备份；数据已升级时，需恢复备份后才能使用旧程序。数据库不会因程序回退而回滚。",PrimaryButtonText="关闭并更新",CloseButtonText="取消",XamlRoot=Navigation.XamlRoot};if(await dialog.ShowAsync()!=ContentDialogResult.Primary)return;
            var updater=Path.Combine(AppContext.BaseDirectory,"Updater","Shufang.Updater.exe");if(!File.Exists(updater))throw new FileNotFoundException("当前为开发构建，请使用包含更新器的发行包。");
            var directory=Path.Combine(WorkspaceFactory.DirectoryPath,".updates");Directory.CreateDirectory(directory);var plan=Path.Combine(directory,"request-"+Guid.NewGuid().ToString("N")+".json");
            await File.WriteAllTextAsync(plan,JsonSerializer.Serialize(new UpdateRequest(Environment.ProcessId,WorkspaceFactory.DirectoryPath,AppContext.BaseDirectory,InstalledVersion.ToString(3),updateStaging,updateEnvelope,updatePublicKey,WorkspaceId:WorkspaceFactory.WorkspaceId,NodeId:WorkspaceFactory.NodeId)));
            var start=new System.Diagnostics.ProcessStartInfo(updater){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=Path.GetDirectoryName(updater)};start.ArgumentList.Add("--apply");start.ArgumentList.Add(plan);System.Diagnostics.Process.Start(start);Close();
        }catch(Exception error){UpdateStatus.Text=error.Message;}
    }
    private async void RefreshWebhooks(object sender, RoutedEventArgs args) { try { await LoadWebhooks(); } catch (Exception error) { ServiceStatus.Text = error.Message; } }
    private async void AddWebhook(object sender, RoutedEventArgs args) { try { await ServiceController.RequestAsync(savedServicePort, "POST", "/api/native/v1/webhooks", new { url = WebhookUrl.Text, events = WebhookEvents.Text.Split(',', StringSplitOptions.RemoveEmptyEntries|StringSplitOptions.TrimEntries), secret = WebhookSecret.Password }); WebhookSecret.Password = ""; await LoadWebhooks(); } catch (Exception error) { ServiceStatus.Text = error.Message; } }
    private async void DeleteWebhook(object sender, RoutedEventArgs args) { if (Webhooks.SelectedItem is not LibraryItem item) return; try { await ServiceController.RequestAsync(savedServicePort, "DELETE", "/api/native/v1/webhooks/" + Uri.EscapeDataString(item.Id)); await LoadWebhooks(); } catch (Exception error) { ServiceStatus.Text = error.Message; } }
    private async void RetryWebhook(object sender, RoutedEventArgs args) { if (WebhookDeliveries.SelectedItem is not LibraryItem item) return; try { await ServiceController.RequestAsync(savedServicePort, "POST", "/admin/webhook-deliveries/" + Uri.EscapeDataString(item.Id) + "/retry"); await LoadWebhooks(); } catch (Exception error) { ServiceStatus.Text = error.Message; } }
}
