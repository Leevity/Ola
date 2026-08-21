using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbCapabilityTools
{
    public static WorkerResponse WikiGet(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT project_root, document_json, generated_at, updated_at FROM wiki_documents WHERE project_root = $root LIMIT 1";
            command.Parameters.AddWithValue("$root", Required(parameters, "projectRoot"));
            using var reader = command.ExecuteReader();
            if (!reader.Read()) return WorkerResponse.RawJson("null");
            return WorkerResponse.Json(new WikiDocumentRow
            {
                ProjectRoot = reader.GetString(0),
                DocumentJson = reader.GetString(1),
                GeneratedAt = reader.GetInt64(2),
                UpdatedAt = reader.GetInt64(3)
            }, WorkerJsonContext.Default.WikiDocumentRow);
        }
        catch (Exception ex) { return WorkerResponse.Error(ex.Message); }
    }

    public static WorkerResponse WikiSave(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var changed = DbSql.ExecuteNonQuery(connection, transaction, """
                INSERT INTO wiki_documents(project_root, document_json, generated_at, updated_at)
                VALUES($root, $document, $generatedAt, $updatedAt)
                ON CONFLICT(project_root) DO UPDATE SET document_json = excluded.document_json,
                  generated_at = excluded.generated_at, updated_at = excluded.updated_at
                """,
                new DbSql.SqlParam("$root", Required(parameters, "projectRoot")),
                new DbSql.SqlParam("$document", Required(parameters, "documentJson")),
                new DbSql.SqlParam("$generatedAt", JsonHelpers.GetLong(parameters, "generatedAt", now)),
                new DbSql.SqlParam("$updatedAt", now));
            var documentJson = Required(parameters, "documentJson");
            if (documentJson.Length > 10 * 1024 * 1024) throw new InvalidOperationException("Wiki document is too large.");
            var projectRoot = Required(parameters, "projectRoot");
            DbSql.ExecuteNonQuery(connection, transaction, "DELETE FROM wiki_nodes WHERE project_root = $root; DELETE FROM wiki_file_snapshots WHERE project_root = $root;",
                new DbSql.SqlParam("$root", projectRoot));
            using var document = JsonDocument.Parse(documentJson);
            if (document.RootElement.TryGetProperty("nodes", out var nodes) && nodes.ValueKind == JsonValueKind.Array)
            {
                foreach (var node in nodes.EnumerateArray())
                {
                    var path = node.TryGetProperty("path", out var pathValue) ? pathValue.GetString() : null;
                    if (string.IsNullOrWhiteSpace(path) || path.Length > 1024) continue;
                    DbSql.ExecuteNonQuery(connection, transaction,
                        "INSERT OR REPLACE INTO wiki_nodes(project_root, node_path, node_json, updated_at) VALUES($root, $path, $node, $updatedAt)",
                        new DbSql.SqlParam("$root", projectRoot),
                        new DbSql.SqlParam("$path", path),
                        new DbSql.SqlParam("$node", node.GetRawText()),
                        new DbSql.SqlParam("$updatedAt", now));
                    if (node.TryGetProperty("kind", out var kind) && kind.GetString() == "file")
                    {
                        DbSql.ExecuteNonQuery(connection, transaction,
                            "INSERT OR REPLACE INTO wiki_file_snapshots(project_root, file_path, content_hash, size_bytes, modified_at, updated_at) VALUES($root, $path, $hash, $size, $modifiedAt, $updatedAt)",
                            new DbSql.SqlParam("$root", projectRoot),
                            new DbSql.SqlParam("$path", path),
                            new DbSql.SqlParam("$hash", node.TryGetProperty("hash", out var hash) ? hash.GetString() : null),
                            new DbSql.SqlParam("$size", node.TryGetProperty("size", out var size) && size.TryGetInt64(out var sizeValue) ? sizeValue : 0),
                            new DbSql.SqlParam("$modifiedAt", node.TryGetProperty("modifiedAt", out var modified) && modified.TryGetDouble(out var modifiedValue) ? (long)modifiedValue : 0),
                            new DbSql.SqlParam("$updatedAt", now));
                    }
                }
            }
            DbSql.ExecuteNonQuery(connection, transaction,
                "INSERT INTO wiki_generation_runs(id, project_root, state, started_at, finished_at) VALUES($id, $root, 'succeeded', $startedAt, $finishedAt)",
                new DbSql.SqlParam("$id", Guid.NewGuid().ToString("N")),
                new DbSql.SqlParam("$root", projectRoot),
                new DbSql.SqlParam("$startedAt", now),
                new DbSql.SqlParam("$finishedAt", now));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex) { return MutationError(ex.Message); }
    }

    public static WorkerResponse WikiDelete(JsonElement parameters) => DeleteByKey(parameters, "wiki_documents", "project_root", "projectRoot");

    public static WorkerResponse FlowList(JsonElement parameters) => ReadFlowRows(parameters);

    public static WorkerResponse FlowSave(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var changed = DbSql.ExecuteNonQuery(connection, transaction, """
                INSERT INTO desktop_flows(id, name, flow_json, created_at, updated_at)
                VALUES($id, $name, $flow, $createdAt, $updatedAt)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, flow_json = excluded.flow_json,
                  updated_at = excluded.updated_at
                """,
                new DbSql.SqlParam("$id", Required(parameters, "id")),
                new DbSql.SqlParam("$name", Required(parameters, "name")),
                new DbSql.SqlParam("$flow", Required(parameters, "flowJson")),
                new DbSql.SqlParam("$createdAt", JsonHelpers.GetLong(parameters, "createdAt", now)),
                new DbSql.SqlParam("$updatedAt", now));
            var flowJson = Required(parameters, "flowJson");
            if (flowJson.Length > 5 * 1024 * 1024) throw new InvalidOperationException("Desktop flow is too large.");
            var flowId = Required(parameters, "id");
            DbSql.ExecuteNonQuery(connection, transaction, "DELETE FROM desktop_flow_steps WHERE flow_id = $flowId",
                new DbSql.SqlParam("$flowId", flowId));
            using var flow = JsonDocument.Parse(flowJson);
            if (flow.RootElement.TryGetProperty("steps", out var steps) && steps.ValueKind == JsonValueKind.Array)
            {
                var sortOrder = 0;
                foreach (var step in steps.EnumerateArray())
                {
                    var stepId = step.TryGetProperty("id", out var stepIdValue) ? stepIdValue.GetString() : null;
                    if (string.IsNullOrWhiteSpace(stepId) || stepId.Length > 128) continue;
                    DbSql.ExecuteNonQuery(connection, transaction,
                        "INSERT OR REPLACE INTO desktop_flow_steps(flow_id, step_id, sort_order, step_json, updated_at) VALUES($flowId, $stepId, $sortOrder, $stepJson, $updatedAt)",
                        new DbSql.SqlParam("$flowId", flowId),
                        new DbSql.SqlParam("$stepId", stepId),
                        new DbSql.SqlParam("$sortOrder", sortOrder++),
                        new DbSql.SqlParam("$stepJson", step.GetRawText()),
                        new DbSql.SqlParam("$updatedAt", now));
                }
            }
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex) { return MutationError(ex.Message); }
    }

    public static WorkerResponse FlowDelete(JsonElement parameters) => DeleteByKey(parameters, "desktop_flows", "id", "id");

    private static WorkerResponse ReadFlowRows(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT id, name, flow_json, created_at, updated_at FROM desktop_flows ORDER BY updated_at DESC LIMIT 100";
            using var reader = command.ExecuteReader();
            var rows = new List<string>();
            while (reader.Read()) rows.Add(reader.GetString(2));
            return WorkerResponse.Json(rows, WorkerJsonContext.Default.ListString);
        }
        catch (Exception ex) { return WorkerResponse.Error(ex.Message); }
    }

    private static WorkerResponse DeleteByKey(JsonElement parameters, string table, string column, string property)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(connection, transaction, $"DELETE FROM {table} WHERE {column} = $value",
                new DbSql.SqlParam("$value", Required(parameters, property)));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex) { return MutationError(ex.Message); }
    }

    private static string Required(JsonElement parameters, string name) =>
        JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value : throw new InvalidOperationException($"Missing required field: {name}");

    private static WorkerResponse Mutation(int changed) => WorkerResponse.Json(
        new CapabilityMutationResult(true, changed, null), WorkerJsonContext.Default.CapabilityMutationResult);

    private static WorkerResponse MutationError(string error) => WorkerResponse.Json(
        new CapabilityMutationResult(false, 0, error), WorkerJsonContext.Default.CapabilityMutationResult);
}
