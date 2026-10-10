namespace Shufang.Updates;
public sealed record UpdateRequest(int ParentPid, string Workspace, string CurrentDirectory, string CurrentVersion, string StagedDirectory, string Envelope, string PublicKey, string? InstallRoot = null, bool UpdateShortcuts = true, string WorkspaceId = "local-preview", string NodeId = "windows-preview");
