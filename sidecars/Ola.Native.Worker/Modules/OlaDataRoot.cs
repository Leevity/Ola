using System.Diagnostics;

internal static class OlaDataRoot
{
    public static void ApplyIsolatedHome(ProcessStartInfo startInfo)
    {
        if (Environment.GetEnvironmentVariable("OLA_E2E_DATA_ROOT") is null) return;
        var home = DirectoryPath;
        startInfo.Environment["HOME"] = home;
        startInfo.Environment["USERPROFILE"] = home;
        startInfo.Environment["XDG_CONFIG_HOME"] = Path.Combine(home, ".config");
    }

    public static string ExternalDataHome =>
        Environment.GetEnvironmentVariable("OLA_E2E_DATA_ROOT") is null
            ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
            : DirectoryPath;

    // An explicitly marked test root is shared with Main; an invalid override must not fall back to user data.
    public static string DirectoryPath
    {
        get
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var overridePath = Environment.GetEnvironmentVariable("OLA_E2E_DATA_ROOT");
            if (overridePath is null)
                return Path.Combine(home, ".ola");

            if (overridePath.Length == 0 || !Path.IsPathFullyQualified(overridePath))
                throw new InvalidOperationException("OLA_E2E_DATA_ROOT must be an absolute, marked test directory");

            var requestedRoot = Path.GetFullPath(overridePath);
            var rootInfo = new DirectoryInfo(requestedRoot);
            if (!rootInfo.Exists)
                throw new InvalidOperationException("OLA_E2E_DATA_ROOT does not exist");
            var root = rootInfo.ResolveLinkTarget(true)?.FullName ?? rootInfo.FullName;
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (string.Equals(root, Path.GetPathRoot(root), comparison)
                || string.Equals(root, Path.GetFullPath(home), comparison)
                || string.Equals(root, Path.GetFullPath(Path.Combine(home, ".ola")), comparison))
                throw new InvalidOperationException("OLA_E2E_DATA_ROOT cannot be a user or filesystem data root");

            var marker = Path.Combine(root, ".ola-e2e-root");
            if (!File.Exists(marker) || File.ReadAllText(marker) != "OLA_ISOLATED_E2E_ROOT\n")
                throw new InvalidOperationException("OLA_E2E_DATA_ROOT has an invalid test marker");
            return requestedRoot;
        }
    }
}
