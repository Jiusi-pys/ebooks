using Shufang.CoreBridge;
using Shufang.Updates;

namespace Shufang.Windows;

// Platform composition root. ViewModels do not choose a database or touch files.
internal static class WorkspaceFactory
{
    public static string WorkspaceId { get; } = NodeIdentity.Argument(Environment.GetCommandLineArgs(), "--workspace-id", "local-preview");
    public static string NodeId { get; } = NodeIdentity.Argument(Environment.GetCommandLineArgs(), "--node-id", "windows-preview");
    public static string DirectoryPath { get; } = ResolveDirectory();
    private static string ResolveDirectory()
    {
        var args = Environment.GetCommandLineArgs();
        var index = Array.IndexOf(args, "--workspace");
        if (index >= 0)
        {
            if (index + 1 >= args.Length || !Path.IsPathFullyQualified(args[index + 1])) throw new ArgumentException("工作区必须为绝对路径");
            return Path.GetFullPath(args[index + 1]);
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Shufang", "NativePreview");
    }
    public static LibrarySession Open()
    {
        var directory = DirectoryPath;
        Directory.CreateDirectory(directory);
        return new LibrarySession(Path.Combine(directory, "library.sqlite3"), WorkspaceId, NodeId);
    }
}
