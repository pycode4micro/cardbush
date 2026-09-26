using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Security.AccessControl;

internal static class SandboxWorker
{
    private static int Main(string[] args)
    {
        if (args[0] == "acl")
        {
            var security = Directory.GetAccessControl(args[1]);
            var descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
            // Windows may upgrade a legacy DACL to automatic inheritance on its first edit.
            // Compare every ACE and the remaining flags (including inheritance protection),
            // rather than the OS-maintained marker recording that conversion.
            descriptor.SetFlags(descriptor.ControlFlags & ~ControlFlags.DiscretionaryAclAutoInherited);
            Console.Write(descriptor.GetSddlForm(AccessControlSections.Access)); return 0;
        }
        if (args[0] == "wait-write")
        {
            Console.WriteLine("ready"); Console.Out.Flush(); Console.ReadLine();
            File.WriteAllText(args[1], "after peer exit"); Console.WriteLine("written"); return 0;
        }
        if (args[0] == "child") { Probe("childOutsideWrite", delegate { File.WriteAllText(args[1], "unexpected"); }); return 0; }
        string root = args[1], outside = args[2], readOnly = args[3];
        Probe("insideWrite", delegate { File.WriteAllText(Path.Combine(root, "inside.txt"), "allowed"); });
        Probe("outsideWrite", delegate { File.WriteAllText(Path.Combine(outside, "outside.txt"), "unexpected"); });
        Probe("outsideRead", delegate { File.ReadAllText(Path.Combine(outside, "secret.txt")); });
        Probe("readOnlyRead", delegate { File.ReadAllText(Path.Combine(readOnly, "reference.txt")); });
        Probe("readOnlyWrite", delegate { File.WriteAllText(Path.Combine(readOnly, "changed.txt"), "unexpected"); });
        Probe("linkedWrite", delegate { File.WriteAllText(Path.Combine(root, "escape", "linked.txt"), "unexpected"); });
        Probe("network", delegate {
            using (var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
            {
                var operation = socket.BeginConnect("127.0.0.1", Int32.Parse(args[4]), null, null);
                if (!operation.AsyncWaitHandle.WaitOne(1500)) throw new TimeoutException();
                socket.EndConnect(operation);
            }
        });
        Console.WriteLine("hostSecret=" + (Environment.GetEnvironmentVariable("CARDBUSH_TEST_SECRET") ?? "absent"));
        Console.WriteLine("nodeOptions=" + (Environment.GetEnvironmentVariable("NODE_OPTIONS") ?? "absent"));
        var start = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "child \"" + Path.Combine(outside, "child.txt") + "\"");
        start.UseShellExecute = false; start.CreateNoWindow = true; start.RedirectStandardOutput = true;
        using (var child = Process.Start(start)) { Console.Write(child.StandardOutput.ReadToEnd()); child.WaitForExit(); }
        return 0;
    }
    private static void Probe(string label, Action action)
    {
        try { action(); Console.WriteLine(label + "=allowed"); }
        catch (Exception error) { Console.WriteLine(label + "=" + error.GetType().Name); }
    }
}
