using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

// The executable and runtime stay together inside an importable plugin folder.
// No shell, machine PATH mutation, console window, or global runtime is needed.
class PortablePlugin {
    static async Task Pump(Stream input, Stream output) {
        byte[] buffer = new byte[8192];
        int length;
        while ((length = await input.ReadAsync(buffer, 0, buffer.Length)) > 0) {
            await output.WriteAsync(buffer, 0, length);
            await output.FlushAsync();
        }
    }
    static string Quote(string value) {
        var text = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') text.Append('\\', slashes * 2 + 1);
            else text.Append('\\', slashes);
            slashes = 0; text.Append(c);
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    static string Inside(string root, string relative) {
        string path = Path.GetFullPath(Path.Combine(root, relative));
        if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Runtime path must stay inside the plugin.");
        return path;
    }
    static int Main(string[] extra) {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                File.ReadAllText(Path.Combine(root, "portable-runtime.json")));
            var args = ((System.Collections.ArrayList)config["args"]).Cast<string>()
                .Select(x => x.Replace("${PLUGIN_ROOT}", root)).Concat(extra);
            var start = new ProcessStartInfo(Inside(root, (string)config["executable"]), string.Join(" ", args.Select(Quote))) {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            foreach (string key in new [] {"PYTHONHOME", "PYTHONPATH", "NODE_OPTIONS", "NODE_PATH"}) start.EnvironmentVariables.Remove(key);
            start.EnvironmentVariables["PYTHONUTF8"] = "1";
            start.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
            if (config.ContainsKey("environment")) foreach (var entry in (Dictionary<string, object>)config["environment"])
                start.EnvironmentVariables[entry.Key] = ((string)entry.Value).Replace("${PLUGIN_ROOT}", root);
            using (var child = Process.Start(start)) {
                var output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                var error = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
                // EOF must reach the server so MCP shutdown does not leave a child waiting.
                Task.Run(async () => { try { await Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
                    catch (IOException) {} finally { try { child.StandardInput.Close(); } catch (InvalidOperationException) {} } });
                child.WaitForExit(); Task.WaitAll(output, error); return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("Portable plugin failed: " + error.Message); return 1; }
    }
}
