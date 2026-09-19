using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbDrawRunTools
{
    private const string DrawRunSelectSql = """
        SELECT id,
               workspace_id,
               prompt,
               provider_name,
               model_name,
               mode,
               meta_json,
               created_at,
               is_generating,
               images_json,
               error_json,
               updated_at
          FROM draw_runs
        """;

    public static WorkerResponse List(JsonElement parameters)
    {
        try
        {
            var workspaceId = RequireString(parameters, "workspaceId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = $"{DrawRunSelectSql} WHERE workspace_id = $workspaceId ORDER BY created_at DESC";
            command.Parameters.AddWithValue("$workspaceId", workspaceId);
            return WorkerResponse.Json(ReadRows(command), WorkerJsonContext.Default.ListDrawRunRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse Save(JsonElement parameters)
    {
        try
        {
            var workspaceId = RequireString(parameters, "workspaceId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            using (var owner = connection.CreateCommand())
            {
                owner.Transaction = transaction;
                owner.CommandText = "SELECT workspace_id FROM draw_runs WHERE id = $id";
                owner.Parameters.AddWithValue("$id", RequireString(parameters, "id"));
                if (owner.ExecuteScalar() is string existing && existing != workspaceId)
                    throw new InvalidOperationException("Draw run belongs to another workspace.");
            }
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO draw_runs (
                  id,
                  workspace_id,
                  prompt,
                  provider_name,
                  model_name,
                  mode,
                  meta_json,
                  created_at,
                  is_generating,
                  images_json,
                  error_json,
                  updated_at
                ) VALUES (
                  $id,
                  $workspaceId,
                  $prompt,
                  $providerName,
                  $modelName,
                  $mode,
                  $metaJson,
                  $createdAt,
                  $isGenerating,
                  $imagesJson,
                  $errorJson,
                  $updatedAt
                ) ON CONFLICT(id) DO UPDATE SET
                  prompt = excluded.prompt,
                  provider_name = excluded.provider_name,
                  model_name = excluded.model_name,
                  mode = excluded.mode,
                  meta_json = excluded.meta_json,
                  is_generating = excluded.is_generating,
                  images_json = excluded.images_json,
                  error_json = excluded.error_json,
                  updated_at = excluded.updated_at
                """,
                new DbSql.SqlParam("$id", RequireString(parameters, "id")),
                new DbSql.SqlParam("$workspaceId", workspaceId),
                new DbSql.SqlParam("$prompt", RequireString(parameters, "prompt")),
                new DbSql.SqlParam("$providerName", RequireString(parameters, "providerName")),
                new DbSql.SqlParam("$modelName", RequireString(parameters, "modelName")),
                new DbSql.SqlParam("$mode", JsonHelpers.GetString(parameters, "mode") ?? "image"),
                new DbSql.SqlParam("$metaJson", JsonHelpers.GetString(parameters, "metaJson")),
                new DbSql.SqlParam("$createdAt", JsonHelpers.GetLong(parameters, "createdAt", Now())),
                new DbSql.SqlParam("$isGenerating", JsonHelpers.GetBool(parameters, "isGenerating", false) ? 1 : 0),
                new DbSql.SqlParam("$imagesJson", JsonHelpers.GetString(parameters, "imagesJson") ?? "[]"),
                new DbSql.SqlParam("$errorJson", JsonHelpers.GetString(parameters, "errorJson")),
                new DbSql.SqlParam("$updatedAt", JsonHelpers.GetLong(parameters, "updatedAt", Now())));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Delete(JsonElement parameters)
    {
        try
        {
            var id = RequireString(parameters, "id");
            var workspaceId = RequireString(parameters, "workspaceId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM draw_runs WHERE id = $id AND workspace_id = $workspaceId",
                new DbSql.SqlParam("$id", id),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse Clear(JsonElement parameters)
    {
        try
        {
            var workspaceId = RequireString(parameters, "workspaceId");
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM draw_runs WHERE workspace_id = $workspaceId",
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();
            return Mutation(changed);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    private static List<DrawRunRow> ReadRows(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        var rows = new List<DrawRunRow>();
        while (reader.Read())
        {
            rows.Add(new DrawRunRow
            {
                Id = reader.GetString(0),
                WorkspaceId = reader.GetString(1),
                Prompt = reader.GetString(2),
                ProviderName = reader.GetString(3),
                ModelName = reader.GetString(4),
                Mode = reader.GetString(5),
                MetaJson = reader.IsDBNull(6) ? null : reader.GetString(6),
                CreatedAt = reader.GetInt64(7),
                IsGenerating = reader.GetInt32(8),
                ImagesJson = reader.GetString(9),
                ErrorJson = reader.IsDBNull(10) ? null : reader.GetString(10),
                UpdatedAt = reader.GetInt64(11)
            });
        }

        return rows;
    }

    private static WorkerResponse Mutation(int changed)
    {
        return WorkerResponse.Json(
            new DrawRunMutationResult(true, changed, null),
            WorkerJsonContext.Default.DrawRunMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new DrawRunMutationResult(false, 0, error),
            WorkerJsonContext.Default.DrawRunMutationResult);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required draw run field: {name}");
    }

    private static long Now()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}
