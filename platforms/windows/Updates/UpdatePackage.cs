using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace Shufang.Updates;

public sealed record VerifiedRelease(Version Version, Uri Url, long Size, string Sha256, int SchemaVersion, string Notes);
public static class UpdatePackage
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = false, PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
    private sealed record Envelope(string Payload, string Signature);
    private sealed record Payload(int FormatVersion, string Version, string Platform, int SchemaVersion, string Url, long Size, string Sha256, string Notes);
    public static void RequireSchemaUpgrade(int current,int target)
    {
        if (current < 0 || target is < 2 or > 3 || current > target) throw new InvalidDataException("更新包不支持当前工作区数据版本，请保留数据并使用兼容程序");
    }
    public static string KeyFingerprint(string pem) { using var key = RSA.Create(); key.ImportFromPem(pem); if (key.KeySize < 3072) throw new InvalidDataException("更新密钥至少需要 RSA 3072 位"); return Convert.ToHexString(SHA256.HashData(key.ExportSubjectPublicKeyInfo())).ToLowerInvariant(); }
    public static VerifiedRelease Verify(string envelope, string pinnedPem, Version current)
    {
        try
        {
            if (envelope.Length > 100_000) throw new InvalidDataException("更新清单过大");
            var signed = JsonSerializer.Deserialize<Envelope>(envelope, JsonOptions) ?? throw new InvalidDataException("无效更新清单");
            var bytes = Convert.FromBase64String(signed.Payload); var signature = Convert.FromBase64String(signed.Signature);
            if (bytes.Length > 64_000 || signature.Length > 1024) throw new InvalidDataException("更新签名过大");
            using var key = RSA.Create(); key.ImportFromPem(pinnedPem);
            if (key.KeySize < 3072 || !key.VerifyData(bytes, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new InvalidDataException("更新签名验证失败");
            var payload = JsonSerializer.Deserialize<Payload>(bytes, JsonOptions) ?? throw new InvalidDataException("无效更新内容");
            if (payload.FormatVersion != 1 || payload.Platform != "win-x64" || payload.SchemaVersion is < 2 or > 3 || !System.Text.RegularExpressions.Regex.IsMatch(payload.Version, @"^\d+\.\d+\.\d+$") || !Version.TryParse(payload.Version, out var version) || version <= current || payload.Size < 1 || payload.Size > 1024L * 1024 * 1024 || !System.Text.RegularExpressions.Regex.IsMatch(payload.Sha256, "^[a-f0-9]{64}$") || !Uri.TryCreate(payload.Url, UriKind.Absolute, out var url) || url.Scheme != "https" || !string.IsNullOrEmpty(url.UserInfo)) throw new InvalidDataException("更新版本、平台、数据版本或下载地址不受支持");
            return new(version, url, payload.Size, payload.Sha256, payload.SchemaVersion, payload.Notes ?? "");
        }
        catch (Exception e) when (e is JsonException or FormatException or CryptographicException or ArgumentException) { throw new InvalidDataException("无效更新签名或清单", e); }
    }
    public static string RelativePath(string path)
    {
        if (string.IsNullOrEmpty(path) || Path.IsPathRooted(path) || path.Contains('\\') || path.Contains(':') || path.Contains('\0') || path.Split('/').Any(p => p is "" or "." or ".." || p.EndsWith('.') || p.EndsWith(' ') || p.IndexOfAny(['<','>','"','|','?','*']) >= 0 || System.Text.RegularExpressions.Regex.IsMatch(p.Split('.')[0], "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))) throw new InvalidDataException("无效 Windows 归档路径");
        return path;
    }
    public static async Task<string> FetchFeedAsync(Uri url, CancellationToken cancellation)
    {
        if (url.Scheme != "https" || !string.IsNullOrEmpty(url.UserInfo)) throw new InvalidDataException("更新地址必须使用 HTTPS");
        using var client = Client(); using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation); response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellation); using var bytes = new MemoryStream(); await CopyBounded(stream, bytes, 100_000, cancellation); return System.Text.Encoding.UTF8.GetString(bytes.ToArray());
    }
    private static HttpClient Client() => new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(5) };
    private static async Task CopyBounded(Stream input, Stream output, long limit, CancellationToken cancellation)
    {
        var bytes = new byte[65536]; long total = 0; int count;
        while ((count = await input.ReadAsync(bytes, cancellation)) != 0) { total = checked(total + count); if (total > limit) throw new InvalidDataException("下载或解压超过限额"); await output.WriteAsync(bytes.AsMemory(0, count), cancellation); }
    }
    public static async Task<string> StageAsync(VerifiedRelease release, string staging, CancellationToken cancellation)
    {
        staging = Path.GetFullPath(staging); if (Directory.Exists(staging)) throw new InvalidDataException("更新暂存目录必须是新目录"); Directory.CreateDirectory(staging);
        var archive = Path.Combine(staging, "download.zip");
        using (var client = Client()) using (var response = await client.GetAsync(release.Url, HttpCompletionOption.ResponseHeadersRead, cancellation))
        {
            response.EnsureSuccessStatusCode(); if (response.Content.Headers.ContentLength is long length && length != release.Size) throw new InvalidDataException("更新包长度不一致");
            await using var input = await response.Content.ReadAsStreamAsync(cancellation); await using var output = new FileStream(archive, FileMode.CreateNew, FileAccess.Write, FileShare.None); await CopyBounded(input, output, release.Size, cancellation);
        }
        return await StageArchiveAsync(release, archive, staging, cancellation);
    }
    public static async Task<string> StageArchiveAsync(VerifiedRelease release, string archive, string staging, CancellationToken cancellation)
    {
        await using var input = new FileStream(archive, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (input.Length != release.Size || !Convert.ToHexString(await SHA256.HashDataAsync(input, cancellation)).Equals(release.Sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("更新包校验失败"); input.Position = 0;
        using var zip = new ZipArchive(input, ZipArchiveMode.Read); if (zip.Entries.Count > 100_000) throw new InvalidDataException("更新包文件过多");
        var prefix = $"Shufang-{release.Version.ToString(3)}-win-x64";
        var destination = Path.Combine(Path.GetFullPath(staging), prefix); if (Directory.Exists(destination)) throw new InvalidDataException("已存在此暂存版本"); Directory.CreateDirectory(destination);
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase); long total = 0;
        foreach (var entry in zip.Entries)
        {
            cancellation.ThrowIfCancellationRequested(); var name = entry.FullName.TrimEnd('/'); RelativePath(name);
            if (!names.Add(name) || (name != prefix && !name.StartsWith(prefix + "/", StringComparison.Ordinal)) || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000) throw new InvalidDataException("更新归档含重复、链接或外部路径");
            if (entry.FullName.EndsWith('/')) continue;
            total = checked(total + entry.Length); if (entry.Length > 512L * 1024 * 1024 || total > 2L * 1024 * 1024 * 1024) throw new InvalidDataException("更新包解压限额");
            var relative = RelativePath(name[(prefix.Length + 1)..]); var path = Path.Combine(destination, relative); Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await using var source = entry.Open(); await using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); await CopyBounded(source, output, entry.Length, cancellation);
            if (output.Length != entry.Length) throw new InvalidDataException("更新归档长度不一致");
        }
        await VerifyFilesAsync(destination, release.Version, cancellation);
        if (ReadSchemaVersion(destination) != release.SchemaVersion) throw new InvalidDataException("包内数据版本与签名清单不一致");
        return destination;
    }
    public static int ReadSchemaVersion(string directory)
    {
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "release-manifest.json")));
        var paths = manifest.RootElement.GetProperty("files").EnumerateArray().Select(f => f.GetProperty("path").GetString()).ToHashSet(StringComparer.Ordinal);
        var migrations = paths.Where(p => p is not null && p.StartsWith("migrations/sqlite/", StringComparison.Ordinal) && p.EndsWith(".sql", StringComparison.Ordinal)).ToArray();
        var count = migrations.Length;
        if (count is < 2 or > 3 || Enumerable.Range(1, count).Any(v => !paths.Contains($"migrations/sqlite/{v:D4}.sql"))) throw new InvalidDataException("数据迁移链不完整或不受支持");
        if (manifest.RootElement.TryGetProperty("schemaVersion", out var declared) && declared.GetInt32() != count) throw new InvalidDataException("包内数据版本与迁移链不一致");
        return count;
    }
    public static async Task VerifyFilesAsync(string directory, Version version, CancellationToken cancellation)
    {
        using var manifest = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(directory, "release-manifest.json"), cancellation));
        if (manifest.RootElement.GetProperty("version").GetString() != version.ToString(3)) throw new InvalidDataException("包内版本不一致");
        _ = ReadSchemaVersion(directory);
        var listed = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "release-manifest.json" };
        foreach (var file in manifest.RootElement.GetProperty("files").EnumerateArray())
        {
            var relative = RelativePath(file.GetProperty("path").GetString()!); if (!listed.Add(relative)) throw new InvalidDataException("包内清单重复");
            await using var input = File.OpenRead(Path.Combine(directory, relative)); var hash = Convert.ToHexString(await SHA256.HashDataAsync(input, cancellation));
            if (!hash.Equals(file.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("包内文件校验失败：" + relative);
        }
        if (Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories).Any(path => !listed.Contains(Path.GetRelativePath(directory, path).Replace('\\', '/')))) throw new InvalidDataException("更新包含未列出的文件");
        foreach (var required in new[] { "Shufang.Windows.exe", "shufang_bindings.dll", "shufang-service.exe", "Updater/Shufang.Updater.exe", "migrations/sqlite/0001.sql", "migrations/sqlite/0002.sql" }) if (!listed.Contains(required)) throw new InvalidDataException("更新缺少必需文件：" + required);
    }
}
