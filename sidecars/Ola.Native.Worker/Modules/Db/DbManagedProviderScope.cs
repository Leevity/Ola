internal static class DbManagedProviderScope
{
    public static void Validate(string? providerId, string workspaceId)
    {
        const string prefix = "ola-managed:";
        if (providerId?.StartsWith(prefix, StringComparison.Ordinal) == true &&
            providerId[prefix.Length..] != workspaceId)
            throw new InvalidOperationException("Managed provider is not available in this workspace.");
    }
}
