using Microsoft.UI.Xaml;

namespace Shufang.Windows;

public partial class App : Application
{
    private Window? window;
    public App() => InitializeComponent();
    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        var command = Environment.GetCommandLineArgs();
        if (command.Contains("--service-start"))
        {
            try { var index = Array.IndexOf(command, "--port"); await ServiceController.StartAsync(index >= 0 && index + 1 < command.Length ? int.Parse(command[index + 1]) : 31417); }
            catch (Exception error) { Directory.CreateDirectory(WorkspaceFactory.DirectoryPath); File.AppendAllText(Path.Combine(WorkspaceFactory.DirectoryPath, "startup.log"), $"{DateTimeOffset.Now:O} {error.Message}\n"); }
            Exit(); return;
        }
        window = new MainWindow();
        window.Activate();
    }
}
