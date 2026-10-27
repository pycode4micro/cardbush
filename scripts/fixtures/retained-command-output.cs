using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

internal static class RetainedCommandOutput
{
    private static int Main(string[] args)
    {
        string directory = args[1];
        if (args[0] == "hold")
        {
            Console.Error.Write("inherited output handle\n");
            File.WriteAllText(Path.Combine(directory, "holding"), "ready");
            DateTime deadline = DateTime.UtcNow.AddSeconds(12);
            while (!File.Exists(Path.Combine(directory, "release")) && DateTime.UtcNow < deadline) Thread.Sleep(20);
            File.WriteAllText(Path.Combine(directory, "released"), "done");
            return 0;
        }
        Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "hold \"" + directory + "\"")
        { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
        DateTime wait = DateTime.UtcNow.AddSeconds(3);
        while (!File.Exists(Path.Combine(directory, "holding")) && DateTime.UtcNow < wait) Thread.Sleep(10);
        if (args[0] == "--secure-pipe") { Console.Error.Write("fixture verification rejected\n"); return 4; }
        return 0;
    }
}
