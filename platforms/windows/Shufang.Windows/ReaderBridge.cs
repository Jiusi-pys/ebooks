using Microsoft.Web.WebView2.Core;
using Microsoft.UI.Xaml.Controls;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Shufang.Windows;

/// <summary>Trusted renderer messages describe gestures; use cases persist them.</summary>
public sealed class ReaderBridge
{
    private readonly WebView2 view;
    private JsonObject? pending;
    private string? originalPath;
    private JsonObject? jump;
    public event Action<JsonObject>? Gesture;
    public JsonObject Preferences { get; set; } = new();
    public ReaderBridge(WebView2 view) => this.view = view;
    public async Task InitializeAsync()
    {
        var environment = await CoreWebView2Environment.CreateWithOptionsAsync(null, Path.Combine(WorkspaceFactory.DirectoryPath, "webview"), null);
        await view.EnsureCoreWebView2Async(environment);
        var core = view.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.IsStatusBarEnabled = false;
        core.SetVirtualHostNameToFolderMapping("reader.shufang.local", Path.Combine(AppContext.BaseDirectory, "Reader"), CoreWebView2HostResourceAccessKind.DenyCors);
        core.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith("https://reader.shufang.local/", StringComparison.Ordinal)) e.Cancel = true; };
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        // Virtual-host-mapped requests bypass WebResourceRequested. Serve the
        // single approved original on a separate, unmapped local-only origin.
        core.AddWebResourceRequestedFilter("https://resource.shufang.local/original.pdf", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) =>
        {
            if (originalPath is null) { e.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", ""); return; }
            try { var stream = File.OpenRead(originalPath); e.Response = core.Environment.CreateWebResourceResponse(stream.AsRandomAccessStream(), 200, "OK", $"Content-Type: application/pdf\r\nContent-Length: {stream.Length}\r\nAccess-Control-Allow-Origin: https://reader.shufang.local\r\nCache-Control: no-store"); }
            catch (IOException) { e.Response = core.Environment.CreateWebResourceResponse(null, 404, "Not Found", ""); }
        };
        core.WebMessageReceived += (_, e) =>
        {
            if (e.Source != "https://reader.shufang.local/index.html" || e.WebMessageAsJson.Length > 128_000) return;
            try { var message = JsonNode.Parse(e.WebMessageAsJson)?.AsObject(); if (message?["type"]?.ToString() == "rendered" && jump is not null) { SendJump(jump); jump = null; } else if (message is not null) Gesture?.Invoke(message); }
            catch (JsonException) { }
        };
        core.NavigationCompleted += (_, e) => { if (e.IsSuccess) { core.PostWebMessageAsJson(new JsonObject { ["type"] = "preferences", ["value"] = Preferences.DeepClone() }.ToJsonString()); if (pending is not null) core.PostWebMessageAsJson(pending.ToJsonString()); } };
        view.Source = new Uri("https://reader.shufang.local/index.html");
    }
    public void Present(JsonObject book, string? original = null, JsonArray? highlights = null, JsonArray? translations = null, JsonObject? rendition = null, JsonArray? outline = null)
    {
        originalPath = original; jump = null;
        pending = new JsonObject { ["type"] = "book", ["book"] = book.DeepClone(), ["highlights"] = highlights?.DeepClone(), ["translations"] = translations?.DeepClone(), ["rendition"] = rendition?.DeepClone(), ["outline"] = outline?.DeepClone() };
        view.CoreWebView2?.PostWebMessageAsJson(pending.ToJsonString());
    }
    public void Jump(JsonObject anchor) { jump = anchor.DeepClone().AsObject(); }
    public void Highlights(JsonArray highlights) => view.CoreWebView2?.PostWebMessageAsJson(new JsonObject { ["type"] = "highlights", ["highlights"] = highlights.DeepClone() }.ToJsonString());
    public void Outline(JsonArray outline) => view.CoreWebView2?.PostWebMessageAsJson(new JsonObject { ["type"] = "outline", ["outline"] = outline.DeepClone() }.ToJsonString());
    private void SendJump(JsonObject anchor) => view.CoreWebView2?.PostWebMessageAsJson(new JsonObject { ["type"] = "jump", ["anchor"] = anchor.DeepClone() }.ToJsonString());
}
