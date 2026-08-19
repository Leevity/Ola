using System.Text.Json;

internal sealed record RuntimeToolResultRecord(
    string SessionId,
    string ToolUseId,
    string RunId,
    string ToolName,
    string Status,
    JsonElement Content,
    bool IsError,
    long? StartedAt,
    long CompletedAt);

internal static class AgentRuntimeToolResultJournal
{
    private const int MaxLookupIds = 256;

    public static void Persist(
        string sessionId,
        string toolUseId,
        string runId,
        string toolName,
        string status,
        JsonElement content,
        bool isError,
        long? startedAt,
        long completedAt)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || string.IsNullOrWhiteSpace(toolUseId)) return;

        try
        {
            using var connection = DbConnectionFactory.OpenReadWriteCreate(
                DbConnectionFactory.ResolveDbPath(default));
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO runtime_tool_results
                  (session_id, tool_use_id, run_id, tool_name, status, content_json,
                   is_error, started_at, completed_at)
                VALUES ($sessionId, $toolUseId, $runId, $toolName, $status, $content,
                        $isError, $startedAt, $completedAt)
                ON CONFLICT(session_id, tool_use_id) DO UPDATE SET
                  run_id = excluded.run_id, tool_name = excluded.tool_name,
                  status = excluded.status, content_json = excluded.content_json,
                  is_error = excluded.is_error,
                  started_at = COALESCE(excluded.started_at, runtime_tool_results.started_at),
                  completed_at = excluded.completed_at;
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId.Trim());
            command.Parameters.AddWithValue("$toolUseId", toolUseId.Trim());
            command.Parameters.AddWithValue("$runId", runId ?? string.Empty);
            command.Parameters.AddWithValue("$toolName", toolName ?? string.Empty);
            command.Parameters.AddWithValue("$status", status ?? "completed");
            command.Parameters.AddWithValue("$content", content.GetRawText());
            command.Parameters.AddWithValue("$isError", isError ? 1 : 0);
            command.Parameters.AddWithValue("$startedAt", (object?)startedAt ?? DBNull.Value);
            command.Parameters.AddWithValue("$completedAt", completedAt);
            command.ExecuteNonQuery();
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"runtime tool result journal write failed: {ex.Message}");
        }
    }

    public static WorkerResponse Lookup(JsonElement parameters)
    {
        var sessionId = JsonHelpers.GetString(parameters, "sessionId")?.Trim();
        if (string.IsNullOrEmpty(sessionId)) return WorkerResponse.Error("sessionId is required");
        var ids = ReadToolUseIds(parameters);
        if (ids.Count == 0)
            return WorkerResponse.Json(new List<RuntimeToolResultRecord>(), WorkerJsonContext.Default.ListRuntimeToolResultRecord);

        try
        {
            using var connection = DbConnectionFactory.OpenReadWriteCreate(DbConnectionFactory.ResolveDbPath(parameters));
            using var command = connection.CreateCommand();
            var placeholders = new List<string>(ids.Count);
            for (var index = 0; index < ids.Count; index++)
            {
                var name = $"$id{index}";
                placeholders.Add(name);
                command.Parameters.AddWithValue(name, ids[index]);
            }
            command.CommandText = $"""
                SELECT session_id, tool_use_id, run_id, tool_name, status, content_json,
                       is_error, started_at, completed_at
                  FROM runtime_tool_results
                 WHERE session_id = $sessionId AND tool_use_id IN ({string.Join(", ", placeholders)})
                 ORDER BY completed_at ASC;
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);

            var records = new List<RuntimeToolResultRecord>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                using var document = JsonDocument.Parse(reader.GetString(5));
                records.Add(new RuntimeToolResultRecord(
                    reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                    reader.GetString(4), document.RootElement.Clone(), reader.GetInt32(6) != 0,
                    reader.IsDBNull(7) ? null : reader.GetInt64(7), reader.GetInt64(8)));
            }
            return WorkerResponse.Json(records, WorkerJsonContext.Default.ListRuntimeToolResultRecord);
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"runtime tool result journal lookup failed: {ex.Message}");
            return WorkerResponse.Json(new List<RuntimeToolResultRecord>(), WorkerJsonContext.Default.ListRuntimeToolResultRecord);
        }
    }

    private static List<string> ReadToolUseIds(JsonElement parameters)
    {
        var ids = new List<string>();
        if (!parameters.TryGetProperty("toolUseIds", out var values) || values.ValueKind != JsonValueKind.Array) return ids;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var value in values.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String) continue;
            var id = value.GetString()?.Trim();
            if (string.IsNullOrEmpty(id) || !seen.Add(id)) continue;
            ids.Add(id);
            if (ids.Count >= MaxLookupIds) break;
        }
        return ids;
    }
}
