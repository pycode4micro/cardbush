using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

internal static class ConnectorSecurity
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetCurrentPackageFamilyName(ref uint length, StringBuilder name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint length, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint SetNamedSecurityInfo(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetNamedSecurityInfo(string name, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll")]
    private static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static string PackageDataRoot()
    {
        uint length = 0;
        if (GetCurrentPackageFamilyName(ref length, null) != 122)
            throw new InvalidDataException("A package identity is required for connector data.");
        StringBuilder family = new StringBuilder((int)length);
        if (GetCurrentPackageFamilyName(ref length, family) != 0)
            throw new InvalidDataException("Cannot verify package identity.");
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Local", "Packages",
            family.ToString(), "LocalState");
    }

    public static void ValidateRegularFile(string file)
    {
        FileInfo info = new FileInfo(file);
        if (!info.Exists || info.Length > 65536 || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Invalid connector configuration file.");
        using (FileStream stream = File.Open(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            StringBuilder finalPath = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(stream.SafeFileHandle.DangerousGetHandle(), finalPath, (uint)finalPath.Capacity, 0);
            string actual = finalPath.ToString();
            if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
            if (length == 0 || length >= finalPath.Capacity || !String.Equals(actual, Path.GetFullPath(file), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Redirected connector configuration is not allowed.");
        }
    }

    public static void ValidateManifestLocation(string manifestPath)
    {
        if (!Path.IsPathRooted(manifestPath)) throw new InvalidDataException("The host manifest path must be absolute.");
        uint length = 0;
        int result = GetCurrentPackageFamilyName(ref length, null);
        string root;
        if (result == 122)
        {
            StringBuilder family = new StringBuilder((int)length);
            if (GetCurrentPackageFamilyName(ref length, family) != 0) throw new InvalidDataException("Cannot verify package identity.");
            root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "AppData", "Local", "Packages",
                family.ToString(), "LocalCache", "Roaming", "cardbush");
        }
        else if (result == 15700) root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "cardbush");
        else throw new InvalidDataException("Cannot verify package identity.");
        string expected = Path.Combine(root, "browser-connector", "com.cardbush.browser_connector.json");
        if (!String.Equals(Path.GetFullPath(manifestPath), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The host manifest is outside this user's CardBush installation.");
        ValidateRegularFile(manifestPath);
    }

    public static void SecureResource(string operation, string target)
    {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        bool directory = operation == "--secure-directory";
        if (directory)
        {
            if (!Path.IsPathRooted(target) || Path.GetFileName(target) != "browser-connector" ||
                (File.GetAttributes(target) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Invalid connector directory.");
        }
        else if (!target.StartsWith(@"\\.\pipe\cardbush-browser-connector-", StringComparison.Ordinal))
            throw new InvalidDataException("Invalid connector pipe.");
        string inheritance = directory ? "OICI" : "";
        string sddl = "D:P(A;" + inheritance + ";FA;;;" + sid + ")(A;" + inheritance + ";FA;;;SY)";
        IntPtr descriptor, dacl; uint size; bool present, defaulted;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out descriptor, out size))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present)
                throw new InvalidDataException("Missing connector access control list.");
            uint error = SetNamedSecurityInfo(target, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) throw new System.ComponentModel.Win32Exception((int)error);
        }
        finally { LocalFree(descriptor); }
        IntPtr owner, group, sacl;
        uint readError = GetNamedSecurityInfo(target, 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
        if (readError != 0) throw new System.ComponentModel.Win32Exception((int)readError);
        try
        {
            byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            RawSecurityDescriptor actual = new RawSecurityDescriptor(bytes, 0);
            if (actual.DiscretionaryAcl == null || actual.DiscretionaryAcl.Count != 2)
                throw new InvalidDataException("Unexpected connector access control list.");
            foreach (GenericAce entry in actual.DiscretionaryAcl)
            {
                CommonAce ace = entry as CommonAce;
                if (ace == null || ace.AceQualifier != AceQualifier.AccessAllowed ||
                    (ace.SecurityIdentifier.Value != sid && ace.SecurityIdentifier.Value != "S-1-5-18"))
                    throw new InvalidDataException("Connector resource grants access to another account.");
            }
        }
        finally { LocalFree(descriptor); }
    }
}
