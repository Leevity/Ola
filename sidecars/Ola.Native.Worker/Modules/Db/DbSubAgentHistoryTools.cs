using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbSubAgentHistoryTools
{
    public static WorkerResponse Index(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 100), 1, 500);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT id, session_id, sub_agent_id, tool_use_id, name, status,
                       started_at, completed_at, updated_at, sort_order
                  FROM sub_agent_history
                 WHERE session_id = $sessionId
                 ORDER BY started_at DESC, sort_order DESC
                 LIMIT $limit
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$limit", limit);
            return WorkerResponse.Json(
                ReadRows(command, includeSnapshot: false),
                WorkerJsonContext.Default.ListSubAgentHistoryRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 50), 1, 200);
            var offset = Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 0));
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT id, session_id, sub_agent_id, tool_use_id, name, status,
                       started_at, completed_at, updated_at, sort_order, snapshot_json
                  FROM sub_agent_history
                 WHERE session_id = $sessionId
                 ORDER BY started_at DESC, sort_order DESC
                 LIMIT $limit OFFSET $offset
                """;
            command.Parameters.AddWithValue("$sessionId", sessionId);
            command.Parameters.AddWithValue("$limit", limit + 1);
            command.Parameters.AddWithValue("$offset", offset);
            var rows = ReadRows(command, includeSnapshot: true);
            var hasMore = rows.Count > limit;
            if (hasMore) rows.RemoveAt(rows.Count - 1);
            return WorkerResponse.Json(
                new SubAgentHistoryPage(rows, offset, limit, hasMore),
                WorkerJsonContext.Default.SubAgentHistoryPage);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse Apply(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = Upsert(connection, transaction, parameters);
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Replace(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            if (!parameters.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
                throw new InvalidOperationException("items must be an array");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM sub_agent_history WHERE session_id = $sessionId",
                new DbSql.SqlParam("$sessionId", sessionId));
            var changed = 0;
            foreach (var item in items.EnumerateArray())
            {
                if (RequireString(item, "sessionId") != sessionId)
                    throw new InvalidOperationException("replacement item belongs to another session");
                changed += Upsert(connection, transaction, item);
            }
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse MigrationStatus(JsonElement parameters)
    {
        try
        {
            var key = RequireString(parameters, "key");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT applied_at FROM app_migrations WHERE key = $key LIMIT 1";
            command.Parameters.AddWithValue("$key", key);
            var value = command.ExecuteScalar();
            return WorkerResponse.Json(
                new SubAgentHistoryMigrationStatus(value is not null, value is long appliedAt ? appliedAt : null),
                WorkerJsonContext.Default.SubAgentHistoryMigrationStatus);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse MarkMigration(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "INSERT INTO app_migrations (key, applied_at) VALUES ($key, $appliedAt) ON CONFLICT(key) DO NOTHING",
                new DbSql.SqlParam("$key", RequireString(parameters, "key")),
                new DbSql.SqlParam("$appliedAt", JsonHelpers.GetLong(parameters, "appliedAt", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    private static int Upsert(SqliteConnection connection, SqliteTransaction transaction, JsonElement item)
    {
        return DbSql.ExecuteNonQuery(
            connection,
            transaction,
            """
            INSERT INTO sub_agent_history (
              id, session_id, sub_agent_id, tool_use_id, name, status, started_at,
              completed_at, updated_at, sort_order, snapshot_json
            ) VALUES (
              $id, $sessionId, $subAgentId, $toolUseId, $name, $status, $startedAt,
              $completedAt, $updatedAt, $sortOrder, $snapshotJson
            )
            ON CONFLICT(session_id, tool_use_id) DO UPDATE SET
              sub_agent_id = excluded.sub_agent_id,
              name = excluded.name,
              status = excluded.status,
              started_at = excluded.started_at,
              completed_at = excluded.completed_at,
              updated_at = excluded.updated_at,
              sort_order = excluded.sort_order,
              snapshot_json = excluded.snapshot_json
            """,
            new DbSql.SqlParam("$id", RequireString(item, "id")),
            new DbSql.SqlParam("$sessionId", RequireString(item, "sessionId")),
            new DbSql.SqlParam("$subAgentId", RequireString(item, "subAgentId")),
            new DbSql.SqlParam("$toolUseId", RequireString(item, "toolUseId")),
            new DbSql.SqlParam("$name", RequireString(item, "name")),
            new DbSql.SqlParam("$status", RequireString(item, "status")),
            new DbSql.SqlParam("$startedAt", JsonHelpers.GetLong(item, "startedAt", 0)),
            new DbSql.SqlParam("$completedAt", GetNullableLong(item, "completedAt")),
            new DbSql.SqlParam("$updatedAt", JsonHelpers.GetLong(item, "updatedAt", 0)),
            new DbSql.SqlParam("$sortOrder", JsonHelpers.GetInt(item, "sortOrder", 0)),
            new DbSql.SqlParam("$snapshotJson", RequireString(item, "snapshotJson")));
    }

    private static List<SubAgentHistoryRow> ReadRows(SqliteCommand command, bool includeSnapshot)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<SubAgentHistoryRow>();
        while (reader.Read())
        {
            rows.Add(new SubAgentHistoryRow(
                reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
                reader.GetString(4), reader.GetString(5), reader.GetInt64(6),
                reader.IsDBNull(7) ? null : reader.GetInt64(7), reader.GetInt64(8), reader.GetInt32(9),
                includeSnapshot && !reader.IsDBNull(10) ? reader.GetString(10) : null));
        }
        return rows;
    }

    private static string RequireString(JsonElement element, string name)
    {
        var value = JsonHelpers.GetString(element, name);
        return string.IsNullOrWhiteSpace(value) ? throw new InvalidOperationException($"{name} is required") : value;
    }

    private static long? GetNullableLong(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null)
            return null;
        return value.TryGetInt64(out var number) ? number : null;
    }

    private static WorkerResponse Mutation(int changed) => WorkerResponse.Json(
        new SubAgentHistoryMutation(true, changed, null), WorkerJsonContext.Default.SubAgentHistoryMutation);

    private static WorkerResponse MutationError(string error) => WorkerResponse.Json(
        new SubAgentHistoryMutation(false, 0, error), WorkerJsonContext.Default.SubAgentHistoryMutation);
}

internal sealed record SubAgentHistoryRow(
    string Id, string SessionId, string SubAgentId, string ToolUseId, string Name, string Status,
    long StartedAt, long? CompletedAt, long UpdatedAt, int SortOrder, string? SnapshotJson);
internal sealed record SubAgentHistoryPage(List<SubAgentHistoryRow> Items, int Offset, int Limit, bool HasMore);
internal sealed record SubAgentHistoryMutation(bool Success, int Changed, string? Error);
internal sealed record SubAgentHistoryMigrationStatus(bool Applied, long? AppliedAt);
