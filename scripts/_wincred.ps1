# Windows-only, stdin/stdout transport for the native Credential Manager APIs.
# https://learn.microsoft.com/windows/win32/api/wincred/nf-wincred-credwritew
# https://learn.microsoft.com/windows/win32/api/wincred/nf-wincred-credreadw
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    # Node writes UTF-8 bytes to redirected stdin. Console.In uses the Windows
    # console code page in PowerShell 5.1, corrupting non-ASCII profile paths.
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
    try { $request = $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose() }
    if ($request.operation -eq 'protect-directory' -or $request.operation -eq 'protect-file') {
        # POSIX chmod has no owner-only ACL meaning on Windows. An explicitly
        # selected file fallback must restrict access to the current user.
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($request.operation -eq 'protect-directory') {
            $acl = New-Object System.Security.AccessControl.DirectorySecurity
            $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
        } else {
            $acl = New-Object System.Security.AccessControl.FileSecurity
            $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
        }
        $acl.SetOwner($identity)
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inheritance, 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath ([string]$request.target) -AclObject $acl
        exit 0
    }
    if ($request.target -notmatch '^org\.manifest-network\.manifest-agent/[a-f0-9-]+$') { throw 'Invalid target.' }
    if ($request.operation -ne 'store' -and $request.operation -ne 'read') { throw 'Invalid operation.' }
    # Only Credential Manager operations need the native API wrapper.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ManifestCredentialStore {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public UInt32 Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CredWrite(ref Credential credential, UInt32 flags);
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);
    public static void Store(string target, string payload) {
        byte[] bytes = Encoding.UTF8.GetBytes(payload);
        if (bytes.Length > 2560) throw new Exception("Credential too long.");
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            Credential credential = new Credential();
            credential.Type = 1; // CRED_TYPE_GENERIC
            credential.TargetName = target;
            credential.UserName = "manifest-agent";
            credential.Persist = 2; // CRED_PERSIST_LOCAL_MACHINE, current user
            credential.CredentialBlobSize = (UInt32)bytes.Length;
            credential.CredentialBlob = blob;
            if (!CredWrite(ref credential, 0)) throw new Exception("Credential write failed.");
        } finally {
            for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
            Marshal.FreeHGlobal(blob);
            Array.Clear(bytes, 0, bytes.Length);
        }
    }
    public static string Read(string target) {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer)) throw new Exception("Credential read failed.");
        try {
            Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (credential.CredentialBlobSize > 2560) throw new Exception("Invalid credential.");
            byte[] bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            try { return Encoding.UTF8.GetString(bytes); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        } finally { CredFree(pointer); }
    }
}
'@
    if ($request.operation -eq 'store') {
        [ManifestCredentialStore]::Store([string]$request.target, [string]$request.payload)
    } elseif ($request.operation -eq 'read') {
        [Console]::Out.Write([ManifestCredentialStore]::Read([string]$request.target))
    } else { throw 'Invalid operation.' }
} catch {
    # PowerShell's default error formatting can include the input object.
    [Console]::Error.WriteLine('Windows credential access failed.')
    exit 1
}
