using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class CardBushBrowserHost
{
    private const string Protocol = "cardbush.chrome_connector.v1";
    private const string ExtensionOrigin = "chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln/";
    // Chrome allows up to 64 MiB from an extension to a native host, but only
    // 1 MiB in the other direction. Screenshot responses travel extension ->
    // host, while commands sent back to Chrome remain deliberately small.
    private const int MaximumIncomingMessageBytes = 64 * 1024 * 1024;
    private const int MaximumOutgoingMessageBytes = 1024 * 1024;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = MaximumIncomingMessageBytes
    };
    private static readonly Stream NativeOutput = Console.OpenStandardOutput();
    private static readonly object OutputLock = new object();
    private static volatile bool ShuttingDown;

    public static int Main(string[] args)
    {
        string origin = FindOrigin(args);
        if (!String.Equals(origin, ExtensionOrigin, StringComparison.Ordinal))
        {
            WriteNativeError("extension_origin_rejected", "This host only accepts the CardBush Browser Connector extension.");
            return 2;
        }

        try
        {
            Dictionary<string, object> config = ReadConfig();
            string endpoint = RequiredString(config, "endpoint");
            string token = RequiredString(config, "token");
            if (!String.Equals(RequiredString(config, "protocol"), Protocol, StringComparison.Ordinal))
            {
                throw new InvalidDataException("The CardBush browser bridge protocol does not match.");
            }
            const string pipePrefix = @"\\.\pipe\";
            if (!endpoint.StartsWith(pipePrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("The CardBush browser bridge is not a Windows named pipe.");
            }
            string pipeName = endpoint.Substring(pipePrefix.Length);

            using (NamedPipeClientStream pipe = new NamedPipeClientStream(
                ".",
                pipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous))
            {
                pipe.Connect(5000);
                using (StreamReader reader = new StreamReader(pipe, new UTF8Encoding(false), false, 4096, true))
                using (StreamWriter writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true))
                {
                    writer.NewLine = "\n";
                    writer.AutoFlush = true;
                    writer.WriteLine(Json.Serialize(new Dictionary<string, object>
                    {
                        { "type", "hello" },
                        { "protocol", Protocol },
                        { "role", "extension" },
                        { "token", token },
                        { "origin", origin }
                    }));

                    Thread bridgeOutput = new Thread(delegate()
                    {
                        try
                        {
                            string line;
                            while ((line = reader.ReadLine()) != null)
                            {
                                Dictionary<string, object> message = Json.DeserializeObject(line) as Dictionary<string, object>;
                                object type;
                                if (message != null && message.TryGetValue("type", out type) &&
                                    String.Equals(Convert.ToString(type), "hello_ack", StringComparison.Ordinal))
                                {
                                    continue;
                                }
                                WriteNativeMessage(Encoding.UTF8.GetBytes(line));
                            }
                        }
                        catch (IOException)
                        {
                            // The CardBush process or Chrome closed the connection.
                        }
                        catch (ObjectDisposedException)
                        {
                            // Chrome closed stdin and the native host is shutting down.
                        }
                        finally
                        {
                            // The bridge belongs to the CardBush process. If that
                            // process exits or crashes, terminate this dedicated
                            // host so Chrome observes onDisconnect and reconnects
                            // to the next CardBush instance instead of retaining a
                            // zombie native port.
                            if (!ShuttingDown) Environment.Exit(0);
                        }
                    });
                    bridgeOutput.IsBackground = true;
                    bridgeOutput.Name = "CardBush browser bridge output";
                    bridgeOutput.Start();

                    Stream input = Console.OpenStandardInput();
                    byte[] header = new byte[4];
                    while (ReadExact(input, header, 0, header.Length, true))
                    {
                        int length = BitConverter.ToInt32(header, 0);
                        if (length < 0 || length > MaximumIncomingMessageBytes)
                        {
                            throw new InvalidDataException("Chrome sent a native message that exceeds the CardBush limit.");
                        }
                        byte[] body = new byte[length];
                        ReadExact(input, body, 0, length, false);
                        // Validate the payload before it reaches the local bridge.
                        Json.DeserializeObject(Encoding.UTF8.GetString(body));
                        writer.WriteLine(Encoding.UTF8.GetString(body));
                    }
                    ShuttingDown = true;
                    // EOF on stdin means Chrome detached the extension. Let the
                    // surrounding using blocks dispose the writer before the pipe;
                    // closing the pipe here made StreamWriter.Dispose() flush a
                    // closed stream and turned a clean shutdown into exit code 3.
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            WriteNativeError("cardbush_bridge_unavailable", error.Message);
            return 3;
        }
    }

    private static Dictionary<string, object> ReadConfig()
    {
        string configPath = Environment.GetEnvironmentVariable("CARDBUSH_CHROME_CONNECTOR_CONFIG");
        if (String.IsNullOrWhiteSpace(configPath))
        {
            configPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "cardbush",
                "browser-connector",
                "bridge.json");
        }
        Dictionary<string, object> config =
            Json.DeserializeObject(File.ReadAllText(configPath, Encoding.UTF8)) as Dictionary<string, object>;
        if (config == null)
        {
            throw new InvalidDataException("The CardBush browser bridge configuration is invalid.");
        }
        return config;
    }

    private static string RequiredString(Dictionary<string, object> value, string key)
    {
        object candidate;
        if (!value.TryGetValue(key, out candidate) || String.IsNullOrWhiteSpace(Convert.ToString(candidate)))
        {
            throw new InvalidDataException("The CardBush browser bridge configuration is missing " + key + ".");
        }
        return Convert.ToString(candidate);
    }

    private static string FindOrigin(string[] args)
    {
        foreach (string argument in args)
        {
            if (argument.StartsWith("chrome-extension://", StringComparison.Ordinal)) return argument;
        }
        return String.Empty;
    }

    private static bool ReadExact(Stream input, byte[] buffer, int offset, int count, bool allowCleanEnd)
    {
        int read = 0;
        while (read < count)
        {
            int received = input.Read(buffer, offset + read, count - read);
            if (received <= 0)
            {
                if (allowCleanEnd && read == 0) return false;
                throw new EndOfStreamException("Chrome closed a partial native message.");
            }
            read += received;
        }
        return true;
    }

    private static void WriteNativeError(string code, string message)
    {
        WriteNativeMessage(Encoding.UTF8.GetBytes(Json.Serialize(new Dictionary<string, object>
        {
            { "type", "connector_error" },
            { "code", code },
            { "message", message }
        })));
    }

    private static void WriteNativeMessage(byte[] body)
    {
        if (body.Length > MaximumOutgoingMessageBytes)
        {
            body = Encoding.UTF8.GetBytes(Json.Serialize(new Dictionary<string, object>
            {
                { "type", "connector_error" },
                { "code", "cardbush_command_too_large" },
                { "message", "CardBush sent a command larger than Chrome's native messaging limit." }
            }));
        }
        byte[] header = BitConverter.GetBytes(body.Length);
        lock (OutputLock)
        {
            NativeOutput.Write(header, 0, header.Length);
            NativeOutput.Write(body, 0, body.Length);
            NativeOutput.Flush();
        }
    }
}
