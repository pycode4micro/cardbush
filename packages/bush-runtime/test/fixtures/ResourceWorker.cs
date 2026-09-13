using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class ResourceWorker
{
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr VirtualAlloc(IntPtr address, UIntPtr size, uint type, uint protection);
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        string mode = args[0];
        if (mode == "echo") { Console.WriteLine(String.Join("|", args, 1, args.Length - 1)); return 0; }
        if (mode == "stdin") { Console.WriteLine(Console.ReadLine()); return 0; }
        if (mode == "exit") return Int32.Parse(args[1]);
        if (mode == "cpu")
        {
            int count = Environment.ProcessorCount;
            long end = Stopwatch.GetTimestamp() + Stopwatch.Frequency * 2;
            var threads = new List<Thread>();
            for (int i = 0; i < count; i++)
            {
                var thread = new Thread(delegate() { while (Stopwatch.GetTimestamp() < end) { } });
                threads.Add(thread); thread.Start();
            }
            foreach (Thread thread in threads) thread.Join();
            Console.WriteLine("cpuMs=" + Process.GetCurrentProcess().TotalProcessorTime.TotalMilliseconds);
            Console.WriteLine("cores=" + count);
            return 0;
        }
        if (mode == "children" || mode == "orphan")
        {
            int count = mode == "orphan" ? 1 : 12;
            for (int i = 0; i < count; i++)
            {
                try
                {
                    var child = Process.Start(new ProcessStartInfo {
                        FileName = Process.GetCurrentProcess().MainModule.FileName,
                        Arguments = "hold", UseShellExecute = false, CreateNoWindow = true
                    });
                    Console.WriteLine("child=" + child.Id);
                }
                catch { break; }
            }
            if (mode == "orphan") return 0;
        }
        if (mode == "allocate" || mode == "hold-memory")
        {
            int blocks = mode == "hold-memory" ? Int32.Parse(args[1]) : 32;
            // Even if the guard regresses this fixture can commit at most 512 MiB.
            for (int i = 0; i < blocks; i++)
            {
                IntPtr memory = VirtualAlloc(IntPtr.Zero, new UIntPtr(16U * 1024 * 1024), 0x3000, 4);
                if (memory == IntPtr.Zero)
                {
                    Console.WriteLine("allocation-denied");
                    Thread.Sleep(300);
                    return 23;
                }
                for (int offset = 0; offset < 16 * 1024 * 1024; offset += 4096) Marshal.WriteByte(memory, offset, 1);
                Console.WriteLine("committed=" + ((i + 1) * 16 * 1024 * 1024));
            }
            if (mode == "allocate") { Console.WriteLine("allocation-finished"); return 0; }
        }
        if (mode == "write")
        {
            using (var stream = new FileStream(args[1], FileMode.Create, FileAccess.Write))
            {
                var buffer = new byte[1024 * 1024];
                for (int i = 0; i < 24; i++) stream.Write(buffer, 0, buffer.Length);
                stream.Flush(true);
            }
        }
        Console.WriteLine("ready=" + Process.GetCurrentProcess().Id);
        // Independent deadline keeps failed tests from leaving a permanent worker.
        Thread.Sleep(15000);
        return 0;
    }
}
