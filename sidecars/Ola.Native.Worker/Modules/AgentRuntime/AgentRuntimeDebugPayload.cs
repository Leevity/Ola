using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

internal sealed record AgentRuntimeDebugBodyFile(string Ref, long Bytes);

internal static class AgentRuntimeDebugPayload
{
    private const string DebugBodyDirectoryName = "ola-request-debug-bodies";
    private const int MaxDebugBodyFiles = 8;
    private const long MaxDebugBodyBytes = 64L * 1024 * 1024;
    private static readonly object Sync = new();
    private static readonly string TempDirectory = Path.Combine(Path.GetTempPath(), DebugBodyDirectoryName);
    private static readonly Dictionary<string, DebugBodyEntry> BodyFiles = new(StringComparer.Ordinal);
    private static readonly Queue<string> BodyFileOrder = new();
    private static long TotalBodyBytes;

    public static string? PrepareBody(string? body, JsonElement parameters)
    {
        return null;
    }

    public static AgentRuntimeDebugBodyFile? PrepareBodyFile(string? body, JsonElement parameters)
    {
        if (!JsonHelpers.GetBool(parameters, "includeFullDebugBody", false) ||
            string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        var redacted = RedactPromptCacheKey(body) ?? body;
        var bodyRef = Guid.NewGuid().ToString("N");
        var filePath = Path.Combine(TempDirectory, $"{bodyRef}.json");
        var bytes = Encoding.UTF8.GetByteCount(redacted);

        lock (Sync)
        {
            Directory.CreateDirectory(TempDirectory);
            File.WriteAllText(filePath, redacted, Encoding.UTF8);
            BodyFiles[bodyRef] = new DebugBodyEntry(bodyRef, filePath, bytes);
            BodyFileOrder.Enqueue(bodyRef);
            TotalBodyBytes += bytes;
            PruneBodyFilesLocked();
        }

        return new AgentRuntimeDebugBodyFile(bodyRef, bytes);
    }

    public static WorkerResponse ReadBody(JsonElement parameters)
    {
        var bodyRef = JsonHelpers.GetString(parameters, "bodyRef");
        if (string.IsNullOrWhiteSpace(bodyRef))
        {
            return ToResponse(Mutation(false, null, null, "Missing debug body reference"));
        }

        lock (Sync)
        {
            if (!BodyFiles.TryGetValue(bodyRef, out var entry) || !File.Exists(entry.Path))
            {
                return ToResponse(Mutation(false, null, null, "Debug body is no longer available"));
            }

            var body = File.ReadAllText(entry.Path, Encoding.UTF8);
            var bytes = new FileInfo(entry.Path).Length;
            return ToResponse(Mutation(true, body, bytes, null));
        }
    }

    public static void CleanupTempFiles()
    {
        lock (Sync)
        {
            BodyFiles.Clear();
            BodyFileOrder.Clear();
            TotalBodyBytes = 0;
            try
            {
                if (Directory.Exists(TempDirectory))
                {
                    Directory.Delete(TempDirectory, recursive: true);
                }
            }
            catch (Exception ex)
            {
                WorkerLog.Warn($"failed to clean debug body temp files: {ex.Message}");
            }
        }
    }

    private static void PruneBodyFilesLocked()
    {
        while (BodyFileOrder.Count > 0 &&
            (BodyFiles.Count > MaxDebugBodyFiles ||
                (TotalBodyBytes > MaxDebugBodyBytes && BodyFiles.Count > 1)))
        {
            var oldestRef = BodyFileOrder.Dequeue();
            if (!BodyFiles.Remove(oldestRef, out var entry))
            {
                continue;
            }

            TotalBodyBytes = Math.Max(0, TotalBodyBytes - entry.Bytes);
            DeleteBodyFileLocked(entry);
        }
    }

    private static void DeleteBodyFileLocked(DebugBodyEntry entry)
    {
        try
        {
            if (File.Exists(entry.Path))
            {
                File.Delete(entry.Path);
            }
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"failed to delete previous debug body file: {ex.Message}");
        }
    }

    private static string? RedactPromptCacheKey(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return body;
        }

        try
        {
            var node = JsonNode.Parse(body);
            if (node is null)
            {
                return body;
            }

            RedactPromptCacheKey(node);
            return node.ToJsonString();
        }
        catch (JsonException)
        {
            return body;
        }
    }

    private static void RedactPromptCacheKey(JsonNode node)
    {
        if (node is JsonObject obj)
        {
            foreach (var property in obj.ToArray())
            {
                if (string.Equals(property.Key, "prompt_cache_key", StringComparison.Ordinal))
                {
                    obj[property.Key] = "[redacted]";
                    continue;
                }

                if (property.Value is not null)
                {
                    RedactPromptCacheKey(property.Value);
                }
            }
            return;
        }

        if (node is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is not null)
                {
                    RedactPromptCacheKey(item);
                }
            }
        }
    }

    private static JsonObject Mutation(bool success, string? body, long? bodyBytes, string? error)
    {
        var result = new JsonObject { ["success"] = success };
        if (body is not null)
        {
            result["body"] = body;
        }
        if (bodyBytes.HasValue)
        {
            result["bodyBytes"] = bodyBytes.Value;
        }
        if (!string.IsNullOrWhiteSpace(error))
        {
            result["error"] = error;
        }
        return result;
    }

    private static WorkerResponse ToResponse(JsonObject node)
    {
        return WorkerResponse.RawJson(node.ToJsonString());
    }

    private sealed record DebugBodyEntry(string Ref, string Path, long Bytes);
}
