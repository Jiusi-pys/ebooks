using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Shufang.CoreBridge;

namespace Shufang.Windows;

public sealed record NoteItem(string Id, string Title, string Content, ulong Revision);

public sealed class NotesViewModel : INotifyPropertyChanged, IDisposable, IAsyncDisposable
{
    private readonly Func<LibrarySession> openSession;
    public NotesViewModel(Func<LibrarySession> openSession) => this.openSession = openSession;
    private LibrarySession? session;
    private readonly SemaphoreSlim gate = new(1, 1);
    private bool disposed;
    private string title = "", content = "", status = "正在打开本地工作区";
    private NoteItem? selected;
    private bool busy;
    public ObservableCollection<NoteItem> Notes { get; } = new();
    public string Title { get => title; set { title = value; Notify(); } }
    public string Content { get => content; set { content = value; Notify(); } }
    public string Status { get => status; private set { status = value; Notify(); } }
    public bool CanSave => session != null && !busy && !disposed;
    public NoteItem? Selected
    {
        get => selected;
        set { selected = value; Title = value?.Title ?? ""; Content = value?.Content ?? ""; Notify(); }
    }
    public event PropertyChangedEventHandler? PropertyChanged;
    private void Notify([CallerMemberName] string? name = null) => PropertyChanged?.Invoke(this, new(name));
    public async Task InitializeAsync() => await RunAsync(() =>
    {
        session = openSession();
        return "本地工作区已打开；同步接入尚未交付";
    });
    public void NewNote() => Selected = null;
    public async Task SaveAsync()
    {
        var id = Selected?.Id ?? Guid.NewGuid().ToString();
        var expected = Selected?.Revision ?? 0;
        var savedTitle = Title; var savedContent = Content;
        var saved = await RunAsync(() => { session!.SaveNote(id, savedTitle, savedContent, expected); return "已保存到本机，待同步记录已持久化"; });
        if (saved) Selected = Notes.FirstOrDefault(note => note.Id == id);
    }
    private async Task<bool> RunAsync(Func<string> action)
    {
        await gate.WaitAsync();
        if (disposed) { gate.Release(); return false; }
        busy = true; Notify(nameof(CanSave));
        try
        {
            var result = await Task.Run(() =>
            {
                var message = action();
                var notes = session!.Notes().EnumerateArray().Select(row => {
                    var note = row.GetProperty("note");
                    return new NoteItem(note.GetProperty("id").GetString()!, note.GetProperty("title").GetString()!, note.GetProperty("content").GetString()!, row.GetProperty("revision").GetUInt64());
                }).ToArray();
                return (message, notes);
            });
            if (!disposed) { Notes.Clear(); foreach (var note in result.notes) Notes.Add(note); Status = result.message; }
            return !disposed;
        }
        catch (Exception error) { if (!disposed) Status = error.Message; return false; }
        finally { busy = false; Notify(nameof(CanSave)); gate.Release(); }
    }
    public void Dispose()
    {
        _ = DisposeAsync();
    }
    public async ValueTask DisposeAsync()
    {
        disposed = true;
        await gate.WaitAsync();
        try { session?.Dispose(); session = null; }
        finally { gate.Release(); }
    }
}
