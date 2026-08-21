using System.Text.Json.Serialization;

internal sealed class WikiDocumentRow
{
    [JsonPropertyName("projectRoot")]
    public string ProjectRoot { get; set; } = string.Empty;

    [JsonPropertyName("documentJson")]
    public string DocumentJson { get; set; } = string.Empty;

    [JsonPropertyName("generatedAt")]
    public long GeneratedAt { get; set; }

    [JsonPropertyName("updatedAt")]
    public long UpdatedAt { get; set; }
}

internal sealed record CapabilityMutationResult(bool Success, int Changed, string? Error);
