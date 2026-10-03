using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
// Explicit local signing; the private PEM is never written to the package/feed.
if (args.Length != 5) { Console.Error.WriteLine("Usage: UpdatePublisher <version> <https-zip-url> <zip> <private-pem> <feed-output>"); return 2; }
var version=Version.Parse(args[0]);var uri=new Uri(args[1]);if(uri.Scheme!="https"||uri.UserInfo.Length!=0)throw new ArgumentException("HTTPS required");
using var rsa=RSA.Create();rsa.ImportFromPem(await File.ReadAllTextAsync(args[3]));if(rsa.KeySize<3072)throw new ArgumentException("RSA 3072 required");
using var archive=ZipFile.OpenRead(args[2]);
var prefix=$"Shufang-{version.ToString(3)}-win-x64/";
var entry=archive.GetEntry(prefix+"release-manifest.json")??throw new InvalidDataException("Release manifest required");
using var manifest=JsonDocument.Parse(entry.Open());
var paths=manifest.RootElement.GetProperty("files").EnumerateArray().Select(f=>f.GetProperty("path").GetString()).ToHashSet(StringComparer.Ordinal);
var schemaVersion=paths.Count(p=>p is not null && p.StartsWith("migrations/sqlite/",StringComparison.Ordinal) && p.EndsWith(".sql",StringComparison.Ordinal));
if(schemaVersion is < 2 or > 3 || Enumerable.Range(1,schemaVersion).Any(v=>!paths.Contains($"migrations/sqlite/{v:D4}.sql")) || manifest.RootElement.GetProperty("version").GetString()!=version.ToString(3) || (manifest.RootElement.TryGetProperty("schemaVersion",out var declared) && declared.GetInt32()!=schemaVersion)) throw new InvalidDataException("Invalid release migration chain");
await using var input=File.OpenRead(args[2]);var payload=JsonSerializer.SerializeToUtf8Bytes(new{formatVersion=1,version=version.ToString(3),platform="win-x64",schemaVersion,url=uri.AbsoluteUri,size=input.Length,sha256=Convert.ToHexString(await SHA256.HashDataAsync(input)).ToLowerInvariant(),notes="Windows 阅读器、共享核心、独立服务更新"});
var envelope=JsonSerializer.Serialize(new{payload=Convert.ToBase64String(payload),signature=Convert.ToBase64String(rsa.SignData(payload,HashAlgorithmName.SHA256,RSASignaturePadding.Pkcs1))});
await using var output=new FileStream(args[4],FileMode.CreateNew,FileAccess.Write,FileShare.None);await output.WriteAsync(System.Text.Encoding.UTF8.GetBytes(envelope));Console.WriteLine("Signed feed created (private key excluded)");return 0;
