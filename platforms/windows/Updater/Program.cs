using System.Diagnostics;
using System.Text.Json;
using Shufang.CoreBridge;
using Shufang.Updates;

if (!OperatingSystem.IsWindows() || args.Length != 2 || args[0] != "--apply") return 2;
UpdateRequest? request = null; Process? launched = null; var switched = false; var parentExited = false; int? originalSchema=null; string? savedBackup=null;
try
{
    request = JsonSerializer.Deserialize<UpdateRequest>(await File.ReadAllTextAsync(args[1])) ?? throw new InvalidDataException("无效更新请求");
    NodeIdentity.Validate(request.WorkspaceId); NodeIdentity.Validate(request.NodeId);
    var workspace = Path.GetFullPath(request.Workspace); var old = Path.GetFullPath(request.CurrentDirectory);
    originalSchema=NativeCore.Execute("sessionDatabaseVersion",new{database=Path.Combine(workspace,"library.sqlite3")}).GetInt32();
    var current = Version.Parse(request.CurrentVersion); var release = UpdatePackage.Verify(request.Envelope, request.PublicKey, current);
    UpdatePackage.RequireSchemaUpgrade(originalSchema.Value,release.SchemaVersion);
    var staged = Path.GetFullPath(request.StagedDirectory);
    var stagingRoot = Path.GetDirectoryName(staged)!;
    // Re-extract the signed archive immediately before applying. A mutable local
    // file manifest alone cannot authenticate staged bytes after download.
    staged = await UpdatePackage.StageArchiveAsync(release, Path.Combine(stagingRoot,"download.zip"),Path.Combine(stagingRoot,"verified-"+Guid.NewGuid().ToString("N")),CancellationToken.None);
    var updates = Path.Combine(workspace, ".updates"); Directory.CreateDirectory(updates);
    using var instance = new FileStream(Path.Combine(updates, "updater.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    try { using var parent = Process.GetProcessById(request.ParentPid); await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); } catch (ArgumentException) { }
    parentExited = true;
    if (Process.GetProcessesByName("Shufang.Windows").Length != 0 || Process.GetProcessesByName("shufang-service").Length != 0) throw new InvalidDataException("请先关闭其他书房窗口和独立服务，再重试更新");
    var installRoot=request.InstallRoot is null ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","Shufang") : Path.GetFullPath(request.InstallRoot);
    var target = Path.Combine(installRoot, release.Version.ToString(3));
    if (Directory.Exists(target)) throw new InvalidDataException("目标版本目录已存在"); Directory.CreateDirectory(Path.GetDirectoryName(target)!);
    var backup = Path.Combine(updates, "backup-" + DateTime.UtcNow.ToString("yyyyMMddTHHmmss") + "-" + Guid.NewGuid().ToString("N") + ".zip");
    using (var maintenance = new FileStream(Path.Combine(workspace, "update.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite))
    {
        maintenance.Lock(0, long.MaxValue);
        try
        {
            NativeCore.Execute("sessionBackupClosed", new { database = Path.Combine(workspace, "library.sqlite3"), destination = backup });
            savedBackup=backup;
            Directory.Move(staged, target);
            await File.WriteAllTextAsync(Path.Combine(updates, "update-state.json"), JsonSerializer.Serialize(new { phase = "installed", old, target, backup, schemaVersion = release.SchemaVersion, keyFingerprint = UpdatePackage.KeyFingerprint(request.PublicKey) }));
        }
        finally { maintenance.Unlock(0, long.MaxValue); }
    }
    var ready = Path.Combine(updates, "ready-" + Guid.NewGuid().ToString("N") + ".json");
    var start = new ProcessStartInfo(Path.Combine(target, "Shufang.Windows.exe")) { UseShellExecute = false, WorkingDirectory = target };
    start.ArgumentList.Add("--workspace"); start.ArgumentList.Add(workspace); start.ArgumentList.Add("--workspace-id"); start.ArgumentList.Add(request.WorkspaceId); start.ArgumentList.Add("--node-id"); start.ArgumentList.Add(request.NodeId); start.ArgumentList.Add("--update-ready-file"); start.ArgumentList.Add(ready);
    launched = Process.Start(start) ?? throw new InvalidDataException("无法启动新版");
    var deadline = DateTime.UtcNow.AddSeconds(45);
    while (!File.Exists(ready)) { if (launched.HasExited || DateTime.UtcNow > deadline) throw new InvalidDataException("新版未完成启动，保留备份；已升级的数据需恢复后才能使用旧程序"); await Task.Delay(200); }
    using (var evidence = JsonDocument.Parse(await File.ReadAllTextAsync(ready))) if (!evidence.RootElement.GetProperty("ready").GetBoolean() || evidence.RootElement.GetProperty("schemaVersion").GetInt32() != release.SchemaVersion || evidence.RootElement.GetProperty("version").GetString() != release.Version.ToString(3)) throw new InvalidDataException("新版启动确认失败");
    await File.WriteAllTextAsync(Path.Combine(updates, "active-install.json"), JsonSerializer.Serialize(new { version = release.Version.ToString(3), directory = target, previousDirectory = old, backup }));
    switched = true;
    string? integrationError = null;
    try { if(request.UpdateShortcuts) {
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType is not null) { dynamic shell = Activator.CreateInstance(shellType)!; dynamic shortcut = shell.CreateShortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "书房.lnk")); shortcut.TargetPath = start.FileName; shortcut.WorkingDirectory = target; shortcut.Arguments = "--workspace \"" + workspace + "\" --workspace-id " + request.WorkspaceId + " --node-id " + request.NodeId; shortcut.Save(); }
        using var run = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
        if (run is not null) foreach (var name in run.GetValueNames().Where(n=>n.StartsWith("Shufang-",StringComparison.Ordinal))) {
            if (run.GetValue(name) is string command && command.Contains(old, StringComparison.OrdinalIgnoreCase) && command.Contains(workspace, StringComparison.OrdinalIgnoreCase)) run.SetValue(name, command.Replace(Path.Combine(old,"shufang-service.exe"),Path.Combine(target,"shufang-service.exe"),StringComparison.OrdinalIgnoreCase));
        }
    } } catch(Exception integration) { integrationError = integration.Message; }
    await File.WriteAllTextAsync(Path.Combine(updates, "update-result.json"), JsonSerializer.Serialize(new { ok = true, version = release.Version.ToString(3), backup, integrationError })); return 0;
}
catch (Exception error)
{
    if (request is not null)
    {
        var updates = Path.Combine(Path.GetFullPath(request.Workspace), ".updates");
        // Recovery must still run when the original failure was exhausted disk
        // space or an unwritable evidence file.
        if (launched is not null && !launched.HasExited) { launched.Kill(); await launched.WaitForExitAsync(); }
        var canRestartOld=false;
        try { canRestartOld=originalSchema is not null && NativeCore.Execute("sessionDatabaseVersion",new{database=Path.Combine(request.Workspace,"library.sqlite3")}).GetInt32()==originalSchema; } catch(Exception) { /* Unknown database state needs explicit recovery. */ }
        try { Directory.CreateDirectory(updates); await File.WriteAllTextAsync(Path.Combine(updates, "update-result.json"), JsonSerializer.Serialize(new { ok = false, error = error.Message, databaseRollback = false, backup=savedBackup, recoveryRequired=!canRestartOld })); } catch(IOException) {} catch(UnauthorizedAccessException) {}
        if (!switched && parentExited && canRestartOld)
        {
            if (launched is not null && !launched.HasExited) { launched.Kill(); await launched.WaitForExitAsync(); }
            var start = new ProcessStartInfo(Path.Combine(request.CurrentDirectory, "Shufang.Windows.exe")) { UseShellExecute = false, WorkingDirectory = request.CurrentDirectory }; start.ArgumentList.Add("--workspace"); start.ArgumentList.Add(request.Workspace); start.ArgumentList.Add("--workspace-id"); start.ArgumentList.Add(request.WorkspaceId); start.ArgumentList.Add("--node-id"); start.ArgumentList.Add(request.NodeId); Process.Start(start);
        }
    }
    return 1;
}
finally { launched?.Dispose(); }
