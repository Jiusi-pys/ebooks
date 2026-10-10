using System.Diagnostics;
using System.Net.Http;
using System.Text.Json;

namespace Shufang.Windows;

internal static class ServiceController
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private static string EntryName => "ShufangService-" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(WorkspaceFactory.DirectoryPath)))[..12];
    public static bool AutoStartEnabled { get { using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey); return key?.GetValue(EntryName) is string; } }
    public static void SetAutoStart(bool enabled, int port)
    {
        using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(RunKey);
        if (!enabled) { key.DeleteValue(EntryName, false); return; }
        if (port is < 1024 or > 65535) throw new InvalidOperationException("端口无效");
        // Launch the UI's invisible service entry so sign-in does not create a console window.
        var exe = Path.Combine(AppContext.BaseDirectory, "Shufang.Windows.exe");
        key.SetValue(EntryName, $"\"{exe}\" --service-start --workspace \"{WorkspaceFactory.DirectoryPath.TrimEnd('\\')}\" --port {port} --workspace-id {WorkspaceFactory.WorkspaceId} --node-id {WorkspaceFactory.NodeId}");
    }
    private static async Task<HttpClient> ClientAsync()
    {
        var token = await Task.Run(() => { using var session = WorkspaceFactory.Open(); return session.Command("serviceToken").GetProperty("token").GetString(); });
        var client = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
        client.DefaultRequestHeaders.Add("X-API-Key", token); return client;
    }
    public static async Task<string> StartAsync(int port)
    {
        if (port is < 1024 or > 65535) throw new InvalidOperationException("端口范围为 1024–65535");
        using var client = await ClientAsync();
        try { var running = await client.GetAsync($"http://127.0.0.1:{port}/admin/status"); if (running.IsSuccessStatusCode) return $"服务已运行：127.0.0.1:{port}"; }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { }
        var executable = Path.Combine(AppContext.BaseDirectory, "shufang-service.exe");
        if (!File.Exists(executable)) throw new FileNotFoundException("服务程序未随应用安装", executable);
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
        start.ArgumentList.Add("--workspace"); start.ArgumentList.Add(WorkspaceFactory.DirectoryPath);
        start.ArgumentList.Add("--workspace-id"); start.ArgumentList.Add(WorkspaceFactory.WorkspaceId);
        start.ArgumentList.Add("--node-id"); start.ArgumentList.Add(WorkspaceFactory.NodeId);
        start.ArgumentList.Add("--port"); start.ArgumentList.Add(port.ToString());
        using var process = Process.Start(start) ?? throw new InvalidOperationException("服务启动失败");
        for (var i = 0; i < 30; i++)
        {
            if (process.HasExited) throw new InvalidOperationException($"服务退出，代码 {process.ExitCode}");
            await Task.Delay(200);
            try { if ((await client.GetAsync($"http://127.0.0.1:{port}/admin/status")).IsSuccessStatusCode) return $"服务已运行：127.0.0.1:{port}"; } catch (Exception e) when (e is HttpRequestException or TaskCanceledException) { }
        }
        throw new InvalidOperationException("服务未在预期时间内就绪，请检查日志和端口");
    }
    public static async Task<string> StopAsync(int port)
    {
        using var client = await ClientAsync();
        var response = await client.PostAsync($"http://127.0.0.1:{port}/admin/stop", null);
        response.EnsureSuccessStatusCode(); return "服务正在停止";
    }
    public static async Task<bool> IsRunningAsync(int port)
    {
        using var client = await ClientAsync();
        try { using var response = await client.GetAsync($"http://127.0.0.1:{port}/admin/status"); return response.IsSuccessStatusCode; }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException) { return false; }
    }
    public static async Task<string> StatusAsync(int port) => await IsRunningAsync(port)
        ? $"服务已运行：127.0.0.1:{port}。关闭窗口后继续运行。"
        : $"当前工作区服务未在 127.0.0.1:{port} 运行。";
    public static async Task<JsonElement> RequestAsync(int port, string method, string path, object? body = null)
    {
        using var client = await ClientAsync();
        using var request = new HttpRequestMessage(new HttpMethod(method), $"http://127.0.0.1:{port}{path}");
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body), System.Text.Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request); var text = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"服务请求失败 ({(int)response.StatusCode})：{text}");
        using var document = JsonDocument.Parse(text); return document.RootElement.Clone();
    }
}
