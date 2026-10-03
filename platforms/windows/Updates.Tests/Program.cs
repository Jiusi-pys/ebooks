using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.IO.Compression;
using Shufang.Updates;
static void Assert(bool value,string message){if(!value)throw new Exception(message);}
static void Reject(Action action,string message){try{action();}catch(InvalidDataException){return;}throw new Exception(message);}
using var key=RSA.Create(3072);
var bytes=JsonSerializer.SerializeToUtf8Bytes(new{formatVersion=1,version="0.3.0",platform="win-x64",schemaVersion=2,url="https://example.test/release.zip",size=123,sha256=new string('a',64),notes="测试"});
var envelope=JsonSerializer.Serialize(new{payload=Convert.ToBase64String(bytes),signature=Convert.ToBase64String(key.SignData(bytes,HashAlgorithmName.SHA256,RSASignaturePadding.Pkcs1))});
var verified=UpdatePackage.Verify(envelope,key.ExportSubjectPublicKeyInfoPem(),new Version(0,2,2));
Assert(verified.Version==new Version(0,3,0),"signed version");
string SignedSchema(int schema) { var data=JsonSerializer.SerializeToUtf8Bytes(new{formatVersion=1,version="0.3.4",platform="win-x64",schemaVersion=schema,url="https://example.test/release.zip",size=123,sha256=new string('a',64),notes="sync"}); return JsonSerializer.Serialize(new{payload=Convert.ToBase64String(data),signature=Convert.ToBase64String(key.SignData(data,HashAlgorithmName.SHA256,RSASignaturePadding.Pkcs1))}); }
Assert(UpdatePackage.Verify(SignedSchema(3),key.ExportSubjectPublicKeyInfoPem(),new Version(0,3,3)).SchemaVersion==3,"schema 3 feed rejected");
Reject(()=>UpdatePackage.Verify(SignedSchema(4),key.ExportSubjectPublicKeyInfoPem(),new Version(0,3,3)),"unsupported schema accepted");

Reject(()=>UpdatePackage.Verify(envelope.Replace("signature\":\"","signature\":\"AA"),key.ExportSubjectPublicKeyInfoPem(),new Version(0,2,2)),"invalid signature accepted");
Reject(()=>UpdatePackage.Verify(envelope,key.ExportSubjectPublicKeyInfoPem(),new Version(0,3,0)),"downgrade accepted");
using var other=RSA.Create(3072);Reject(()=>UpdatePackage.Verify(envelope,other.ExportSubjectPublicKeyInfoPem(),new Version(0,2,2)),"untrusted key accepted");
foreach(var path in new[]{"../evil","C:/evil","a/../../evil","a:stream","CON.txt","folder/trailing.","folder\\evil"})Reject(()=>UpdatePackage.RelativePath(path),"bad path accepted: "+path);
Assert(UpdatePackage.RelativePath("Reader/index.html")=="Reader/index.html","safe path");
Console.WriteLine("PASS signed feed, wrong key, invalid signature, downgrade, Windows archive paths");
var root=Path.Combine(Path.GetTempPath(),"Shufang-update-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
try {
    var required=new[]{"Shufang.Windows.exe","shufang_bindings.dll","shufang-service.exe","Updater/Shufang.Updater.exe","migrations/sqlite/0001.sql","migrations/sqlite/0002.sql"};
    var files=required.Select(path=>new{path,sha256=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(path))).ToLowerInvariant()}).ToArray();
    string Archive(string name,string? attack=null){
        var path=Path.Combine(root,name);using var zip=ZipFile.Open(path,ZipArchiveMode.Create);
        foreach(var file in required){using var writer=new StreamWriter(zip.CreateEntry("Shufang-0.3.0-win-x64/"+file).Open());writer.Write(file);}
        using(var writer=new StreamWriter(zip.CreateEntry("Shufang-0.3.0-win-x64/release-manifest.json").Open()))writer.Write(JsonSerializer.Serialize(new{version="0.3.0",files}));
        if(attack is not null){using var writer=new StreamWriter(zip.CreateEntry(attack).Open());writer.Write("attack");}return path;
    }
    VerifiedRelease Release(string path)=>new(new Version(0,3,0),new Uri("https://example.test/release.zip"),new FileInfo(path).Length,Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant(),2,"");
    var archive=Archive("valid.zip");var release=Release(archive);
    var staged=await UpdatePackage.StageArchiveAsync(release,archive,Path.Combine(root,"valid"),CancellationToken.None);
    Assert(File.ReadAllText(Path.Combine(staged,"migrations/sqlite/0001.sql"))=="migrations/sqlite/0001.sql","migration retained");
    try{await UpdatePackage.StageArchiveAsync(release with{SchemaVersion=3},archive,Path.Combine(root,"schema-mismatch"),CancellationToken.None);throw new Exception("schema mismatch accepted");}catch(InvalidDataException){}
    var migration3="migrations/sqlite/0003.sql";
    File.WriteAllText(Path.Combine(staged,migration3),migration3);
    var files3=files.Append(new{path=migration3,sha256=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(migration3))).ToLowerInvariant()}).ToArray();
    File.WriteAllText(Path.Combine(staged,"release-manifest.json"),JsonSerializer.Serialize(new{version="0.3.0",schemaVersion=3,files=files3}));
    await UpdatePackage.VerifyFilesAsync(staged,release.Version,CancellationToken.None);
    Assert(UpdatePackage.ReadSchemaVersion(staged)==3,"schema 3 chain not detected");
    File.WriteAllText(Path.Combine(staged,"release-manifest.json"),JsonSerializer.Serialize(new{version="0.3.0",schemaVersion=2,files=files3}));
    Reject(()=>UpdatePackage.ReadSchemaVersion(staged),"false declared schema accepted");
    File.WriteAllText(Path.Combine(staged,"release-manifest.json"),JsonSerializer.Serialize(new{version="0.3.0",schemaVersion=3,files=files3}));
    File.AppendAllText(Path.Combine(staged,"Shufang.Windows.exe"),"tamper");
    try{await UpdatePackage.VerifyFilesAsync(staged,release.Version,CancellationToken.None);throw new Exception("tampered file accepted");}catch(InvalidDataException){}
    try{await UpdatePackage.StageArchiveAsync(release with{Sha256=new string('0',64)},archive,Path.Combine(root,"bad-hash"),CancellationToken.None);throw new Exception("hash accepted");}catch(InvalidDataException){}
    var hostile=Archive("hostile.zip","Shufang-0.3.0-win-x64/../escape");
    try{await UpdatePackage.StageArchiveAsync(Release(hostile),hostile,Path.Combine(root,"hostile"),CancellationToken.None);throw new Exception("traversal accepted");}catch(InvalidDataException){}
    var extra=Archive("extra.zip","Shufang-0.3.0-win-x64/unlisted.dll");
    try{await UpdatePackage.StageArchiveAsync(Release(extra),extra,Path.Combine(root,"extra"),CancellationToken.None);throw new Exception("unlisted file accepted");}catch(InvalidDataException){}
    using var canceled=new CancellationTokenSource();canceled.Cancel();
    try{await UpdatePackage.StageArchiveAsync(release,archive,Path.Combine(root,"cancel"),canceled.Token);throw new Exception("cancellation ignored");}catch(OperationCanceledException){}
    Assert(!File.Exists(Path.Combine(root,"escape")),"escaped archive");
    Console.WriteLine("PASS signed-size/hash staging, migration retention, tampered files, traversal, extras, cancellation");
    if(args.Length==2){var real=args[0];var realVersion=Version.Parse(args[1]);var actual=Release(real) with{Version=realVersion};var realStaged=await UpdatePackage.StageArchiveAsync(actual,real,Path.Combine(root,"real"),CancellationToken.None);Console.WriteLine("PASS complete release archive: "+realVersion);}
} finally { Directory.Delete(root,true); }

Assert(NodeIdentity.Argument(["app","--node-id","windows-a"],"--node-id","windows-preview")=="windows-a","node argument lost");
Assert(NodeIdentity.Argument(["app"],"--workspace-id","local-preview")=="local-preview","legacy identity changed");
Reject(()=>NodeIdentity.Argument(["app","--node-id"],"--node-id","windows-preview"),"missing node argument accepted");
Reject(()=>NodeIdentity.Argument(["app","--node-id","bad\"value"],"--node-id","windows-preview"),"unsafe node argument accepted");
Reject(()=>NodeIdentity.Argument(["app","--node-id","a","--node-id","b"],"--node-id","windows-preview"),"ambiguous identity accepted");

var legacyRequest=JsonSerializer.Deserialize<UpdateRequest>(JsonSerializer.Serialize(new{ParentPid=1,Workspace="test",CurrentDirectory="old",CurrentVersion="0.3.3",StagedDirectory="stage",Envelope="signed",PublicKey="public"}))!;
Assert(legacyRequest.WorkspaceId=="local-preview" && legacyRequest.NodeId=="windows-preview","old update request identity compatibility");

UpdatePackage.RequireSchemaUpgrade(1,3);UpdatePackage.RequireSchemaUpgrade(2,3);UpdatePackage.RequireSchemaUpgrade(3,3);
Reject(()=>UpdatePackage.RequireSchemaUpgrade(3,2),"executable update allowed database downgrade");
Reject(()=>UpdatePackage.RequireSchemaUpgrade(4,3),"future database accepted by older release");
