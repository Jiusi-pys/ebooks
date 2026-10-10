using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Shufang.CoreBridge;

/// <summary>Only marshaling and ownership live here; no persistence or business rules.</summary>
public static class NativeCore
{
    private const string Library = "shufang_bindings";
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    private static extern uint core_abi_version();
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    private static extern nint core_alloc(nuint length);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    private static extern nuint core_buffer_len(nint pointer);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    private static extern nint core_execute(nint pointer);
    [DllImport(Library, CallingConvention = CallingConvention.Cdecl)]
    private static extern void core_free(nint pointer);

    public static JsonElement Execute(string command, object parameters)
    {
        if (core_abi_version() != 1) throw new InvalidOperationException("unsupported_core_abi");
        var fields = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(parameters))!;
        fields["version"] = JsonSerializer.SerializeToElement(1);
        fields["command"] = JsonSerializer.SerializeToElement(command);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(fields);
        var input = core_alloc((nuint)bytes.Length);
        if (input == 0) throw new InvalidOperationException("core_allocation_failed");
        nint output = 0;
        try
        {
            Marshal.Copy(bytes, 0, input, bytes.Length);
            output = core_execute(input);
            var length = checked((int)core_buffer_len(output));
            if (output == 0 || length == 0) throw new InvalidOperationException("core_execution_failed");
            var result = new byte[length];
            Marshal.Copy(output, result, 0, length);
            using var json = JsonDocument.Parse(result);
            if (!json.RootElement.GetProperty("ok").GetBoolean())
                throw new InvalidOperationException(json.RootElement.GetProperty("error").GetProperty("code").GetString());
            return json.RootElement.GetProperty("value").Clone();
        }
        finally
        {
            core_free(input);
            if (output != 0) core_free(output);
        }
    }
}

public sealed class LibrarySession : IDisposable
{
    private readonly string session;
    private bool closed;
    public LibrarySession(string databasePath, string workspace, string replica)
    {
        session = NativeCore.Execute("sessionOpen", new { path = Path.GetFullPath(databasePath), workspace, replica })
            .GetProperty("session").GetString()!;
    }
    public JsonElement Notes() { AssertOpen(); return NativeCore.Execute("sessionNotes", new { session }); }
    public JsonElement Pending() { AssertOpen(); return NativeCore.Execute("sessionPending", new { session }); }
    public JsonElement Command(string action, object? args = null)
    {
        AssertOpen();
        return NativeCore.Execute("sessionCommand", new { session, action, args = args ?? new { } });
    }
    public JsonElement SaveNote(string id, string title, string content, ulong expected)
    {
        AssertOpen();
        return NativeCore.Execute("sessionSaveNote", new { session, id, title, content, expected });
    }
    private void AssertOpen() => ObjectDisposedException.ThrowIf(closed, this);
    public void Dispose()
    {
        if (closed) return;
        NativeCore.Execute("sessionClose", new { session });
        closed = true;
    }
}
