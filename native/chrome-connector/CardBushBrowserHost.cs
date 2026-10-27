using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

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
        if (args.Length == 1 && args[0] == "--package-data-root")
        {
            try {
                Console.OutputEncoding = new UTF8Encoding(false);
                Console.Write(Json.Serialize(new Dictionary<string, object> { { "path", ConnectorSecurity.PackageDataRoot() } }));
                return 0;
            }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 4; }
        }
        if (args.Length == 2 && args[0] == "--registry-read" && (args[1] == "32" || args[1] == "64"))
        {
            try
            {
                // Fixed, read-only HKCU query. UTF-8 JSON preserves non-ASCII user
                // paths and does not depend on reg.exe's localized output.
                using (RegistryKey user = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser,
                    args[1] == "32" ? RegistryView.Registry32 : RegistryView.Registry64))
                using (RegistryKey key = user.OpenSubKey(@"Software\Google\Chrome\NativeMessagingHosts\com.cardbush.browser_connector"))
                {
                    object value = key == null ? null : key.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                    if (value != null && key.GetValueKind("") != RegistryValueKind.String)
                        throw new InvalidDataException("The Chrome host registration has an unsupported value type.");
                    Console.OutputEncoding = new UTF8Encoding(false);
                    Console.Write(Json.Serialize(new Dictionary<string, object> {
                        { "manifestPath", value }, { "empty", key == null || (key.ValueCount == 0 && key.SubKeyCount == 0) }
                    }));
                    return 0;
                }
            }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 4; }
        }
        if (args.Length == 2 && (args[0] == "--secure-directory" || args[0] == "--secure-pipe"))
        {
            try { ConnectorSecurity.SecureResource(args[0], args[1]); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error.Message); return 4; }
        }
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
            if (!endpoint.StartsWith(pipePrefix + "cardbush-browser-connector-", StringComparison.OrdinalIgnoreCase))
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
                                    if (!String.Equals(RequiredString(message, "protocol"), Protocol, StringComparison.Ordinal))
                                    {
                                        throw new InvalidDataException("The CardBush browser bridge handshake does not match.");
                                    }
                                    WriteNativeMessage(Encoding.UTF8.GetBytes(Json.Serialize(new Dictionary<string, object>
                                    {
                                        { "type", "connector_ready" },
                                        { "protocol", Protocol }
                                    })));
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
        string configPath = null;
#if CARDBUSH_CONNECTOR_TEST
        configPath = Environment.GetEnvironmentVariable("CARDBUSH_CHROME_CONNECTOR_CONFIG");
#endif
        if (String.IsNullOrWhiteSpace(configPath)) configPath = RegisteredConfigPath();
        if (String.IsNullOrWhiteSpace(configPath)) throw new InvalidDataException("Enable the Chrome connector in CardBush settings first.");
        ConnectorSecurity.ValidateRegularFile(configPath);
        Dictionary<string, object> config =
            Json.DeserializeObject(File.ReadAllText(configPath, Encoding.UTF8)) as Dictionary<string, object>;
        if (config == null)
        {
            throw new InvalidDataException("The CardBush browser bridge configuration is invalid.");
        }
        return config;
    }

    private static string RegisteredConfigPath()
    {
        // An MSIX application's Roaming directory is redirected. The browser
        // starts this host outside that context, so use the same physical
        // directory as the native manifest that the browser discovered.
        const string keyPath = @"Software\Google\Chrome\NativeMessagingHosts\com.cardbush.browser_connector";
        string executablePath = Path.GetFullPath(typeof(CardBushBrowserHost).Assembly.Location);
            foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
            {
                using (RegistryKey registry = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, view))
                using (RegistryKey key = registry.OpenSubKey(keyPath))
                {
                    string manifestPath = key == null ? null : key.GetValue(null) as string;
                    if (String.IsNullOrWhiteSpace(manifestPath)) continue;
                    ConnectorSecurity.ValidateManifestLocation(manifestPath);
                    Dictionary<string, object> manifest = Json.DeserializeObject(
                        File.ReadAllText(manifestPath, Encoding.UTF8)) as Dictionary<string, object>;
                    object hostPath, name, origins, type;
                    if (manifest == null || !manifest.TryGetValue("name", out name) || Convert.ToString(name) != "com.cardbush.browser_connector" ||
                        !manifest.TryGetValue("type", out type) || Convert.ToString(type) != "stdio" ||
                        !manifest.TryGetValue("allowed_origins", out origins)) throw new InvalidDataException("Invalid CardBush host manifest.");
                    System.Collections.IList allowed = origins as System.Collections.IList;
                    if (allowed == null || allowed.Count != 1 || Convert.ToString(allowed[0]) != ExtensionOrigin)
                        throw new InvalidDataException("Unexpected extension origin in host manifest.");
                    if (manifest == null || !manifest.TryGetValue("path", out hostPath) || !(hostPath is string)) continue;
                    string registeredHost = Convert.ToString(hostPath);
                    if (!Path.IsPathRooted(registeredHost)) continue;
                    string fullHostPath = Path.GetFullPath(registeredHost);
                    string aliasPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Microsoft", "WindowsApps", "CardBushBrowserHost.exe");
                    if (!String.Equals(fullHostPath, executablePath, StringComparison.OrdinalIgnoreCase) &&
                        !String.Equals(fullHostPath, aliasPath, StringComparison.OrdinalIgnoreCase)) continue;
                    string directory = Path.GetDirectoryName(manifestPath);
                    string preferencePath = Path.Combine(directory, "preference.json");
                    ConnectorSecurity.ValidateRegularFile(preferencePath);
                    Dictionary<string, object> preference = Json.DeserializeObject(File.ReadAllText(preferencePath)) as Dictionary<string, object>;
                    object enabled;
                    if (preference == null || !preference.TryGetValue("enabled", out enabled) || !Object.Equals(enabled, true))
                        throw new InvalidDataException("The Chrome connector is disabled.");
                    return Path.Combine(directory, "bridge.json");
                }
            }
        return null;
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
