using System.Text.Json;
using Microsoft.Data.Sqlite;

internal static class DbPluginSessionTools
{
    private const string PlaceholderNewConversation = "New Conversation";
    private const string PlaceholderNewChat = "New Chat";

    private static SqliteConnection OpenDefaultConnection()
    {
        return DbConnectionFactory.OpenReadWrite(Path.Combine(OlaDataRoot.DirectoryPath, "data.db"));
    }

    public static WorkerResponse ListNormalProjects(JsonElement parameters)
    {
        try
        {
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT id, name, working_folder, ssh_connection_id, plugin_id, pinned,
                       created_at, updated_at, workspace_id
                  FROM projects
                 WHERE plugin_id IS NULL OR plugin_id = ''
                 ORDER BY pinned DESC, updated_at DESC
                """;

            var rows = new List<PluginProjectRow>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(ReadProjectRow(reader));
            }

            return WorkerResponse.Json(rows, WorkerJsonContext.Default.ListPluginProjectRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse SyncPluginSessionModels(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            var providerId = NormalizeOptional(JsonHelpers.GetString(parameters, "providerId"));
            var modelId = providerId is null
                ? null
                : NormalizeOptional(JsonHelpers.GetString(parameters, "modelId"));
            var workspaceId = NormalizeOptional(JsonHelpers.GetString(parameters, "workspaceId")) ?? "local-personal";
            DbManagedProviderScope.Validate(providerId, workspaceId);
            var modelSource = parameters.TryGetProperty("modelSource", out var modelSourceElement) &&
                modelSourceElement.ValueKind != JsonValueKind.Null
                ? NormalizeModelSource(modelSourceElement.GetString(), workspaceId)
                : null;
            var modelSelectionMode = providerId is not null && modelId is not null
                ? "manual"
                : "inherit";

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE sessions
                   SET provider_id = $providerId,
                       model_id = $modelId,
                       model_source = $modelSource,
                       model_selection_mode = $modelSelectionMode
                 WHERE plugin_id = $pluginId AND workspace_id = $workspaceId
                """,
                new DbSql.SqlParam("$providerId", providerId),
                new DbSql.SqlParam("$modelId", modelId),
                new DbSql.SqlParam("$modelSource", modelSource),
                new DbSql.SqlParam("$modelSelectionMode", modelSelectionMode),
                new DbSql.SqlParam("$pluginId", pluginId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();
            return Mutation(changed, 0);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse SyncPluginSessionProject(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            var projectId = NormalizeOptional(JsonHelpers.GetString(parameters, "projectId"));
            var workspaceId = NormalizeOptional(JsonHelpers.GetString(parameters, "workspaceId")) ?? "local-personal";

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var project = projectId is null ? null : FindProject(connection, transaction, projectId);
            if (project is not null && project.WorkspaceId != workspaceId)
            {
                throw new InvalidOperationException("Project workspace does not match channel workspace.");
            }
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE sessions
                   SET project_id = $projectId,
                       working_folder = $workingFolder,
                       ssh_connection_id = $sshConnectionId
                 WHERE plugin_id = $pluginId AND workspace_id = $workspaceId
                """,
                new DbSql.SqlParam("$projectId", project?.Id),
                new DbSql.SqlParam("$workingFolder", EmptyToNull(project?.WorkingFolder)),
                new DbSql.SqlParam("$sshConnectionId", project?.SshConnectionId),
                new DbSql.SqlParam("$pluginId", pluginId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();
            return Mutation(changed, 0);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse RemovePluginData(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            var workspaceId = WorkspaceId(parameters);

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var deletedMessages = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                DELETE FROM messages
                 WHERE session_id IN (
                   SELECT id FROM sessions
                    WHERE plugin_id = $pluginId AND workspace_id = $workspaceId
                 )
                """,
                new DbSql.SqlParam("$pluginId", pluginId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            var deletedSessions = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM sessions WHERE plugin_id = $pluginId AND workspace_id = $workspaceId",
                new DbSql.SqlParam("$pluginId", pluginId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            var deletedProjects = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                "DELETE FROM projects WHERE plugin_id = $pluginId AND workspace_id = $workspaceId",
                new DbSql.SqlParam("$pluginId", pluginId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();

            return Mutation(deletedSessions + deletedProjects, deletedMessages);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse ListPluginSessions(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            var workspaceId = WorkspaceId(parameters);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var rows = QuerySessionRows(
                connection,
                """
                SELECT id, title, icon, mode, created_at, updated_at, project_id, working_folder,
                       ssh_connection_id, plan_id, pinned, plugin_id, external_chat_id, provider_id,
                       model_id, model_selection_mode, COALESCE(message_count, 0) AS message_count
                  FROM sessions
                 WHERE plugin_id = $pluginId AND workspace_id = $workspaceId
                 ORDER BY updated_at DESC
                """,
                new DbSql.SqlParam("$pluginId", pluginId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            return WorkerResponse.Json(rows, WorkerJsonContext.Default.ListPluginSessionRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse CreatePluginSession(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            var workspaceId = WorkspaceId(parameters);
            var sessionId = NormalizeOptional(JsonHelpers.GetString(parameters, "id")) ?? CreateSessionId();
            var title = RequireString(parameters, "title");
            var mode = NormalizeOptional(JsonHelpers.GetString(parameters, "mode")) ?? "cowork";
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var createdAt = JsonHelpers.GetLong(parameters, "createdAt", now);
            var updatedAt = JsonHelpers.GetLong(parameters, "updatedAt", createdAt);
            var externalChatId = NormalizeOptional(JsonHelpers.GetString(parameters, "externalChatId"));
            var projectId = NormalizeOptional(JsonHelpers.GetString(parameters, "projectId"));
            var providerId = NormalizeOptional(JsonHelpers.GetString(parameters, "providerId"));
            DbManagedProviderScope.Validate(providerId, workspaceId);
            var modelId = providerId is null
                ? null
                : NormalizeOptional(JsonHelpers.GetString(parameters, "modelId"));
            var modelSelectionMode = providerId is not null && modelId is not null
                ? "manual"
                : "inherit";

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var project = projectId is null ? null : FindProject(connection, transaction, projectId);
            if (project is not null && project.WorkspaceId != workspaceId)
            {
                throw new InvalidOperationException("Project workspace does not match channel workspace.");
            }
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                INSERT INTO sessions (
                  id, title, icon, mode, created_at, updated_at, project_id, working_folder,
                  ssh_connection_id, pinned, plugin_id, external_chat_id, provider_id, model_id,
                  model_selection_mode, workspace_id
                ) VALUES (
                  $id, $title, NULL, $mode, $createdAt, $updatedAt, $projectId, $workingFolder,
                  $sshConnectionId, 0, $pluginId, $externalChatId, $providerId, $modelId,
                  $modelSelectionMode, $workspaceId
                )
                """,
                new DbSql.SqlParam("$id", sessionId),
                new DbSql.SqlParam("$title", title),
                new DbSql.SqlParam("$mode", mode),
                new DbSql.SqlParam("$createdAt", createdAt),
                new DbSql.SqlParam("$updatedAt", updatedAt),
                new DbSql.SqlParam("$projectId", project?.Id),
                new DbSql.SqlParam("$workingFolder", EmptyToNull(project?.WorkingFolder)),
                new DbSql.SqlParam("$sshConnectionId", project?.SshConnectionId),
                new DbSql.SqlParam("$pluginId", pluginId),
                new DbSql.SqlParam("$externalChatId", externalChatId),
                new DbSql.SqlParam("$providerId", providerId),
                new DbSql.SqlParam("$modelId", modelId),
                new DbSql.SqlParam("$modelSelectionMode", modelSelectionMode),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();
            return Mutation(changed, 0);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse FindPluginSessionByChat(JsonElement parameters)
    {
        try
        {
            var externalChatId = RequireString(parameters, "externalChatId");
            var workspaceId = WorkspaceId(parameters);
            return WorkerResponse.Json(
                FindPluginSessionRecordByChat(externalChatId, workspaceId, parameters),
                WorkerJsonContext.Default.PluginSessionFindResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new PluginSessionFindResult(false, null, ex.Message),
                WorkerJsonContext.Default.PluginSessionFindResult);
        }
    }

    public static WorkerResponse ListAllPluginSessions(JsonElement parameters)
    {
        try
        {
            var workspaceId = WorkspaceId(parameters);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            var rows = QuerySessionRows(
                connection,
                $"""
                {SessionSelectSql}
                 WHERE plugin_id IS NOT NULL AND plugin_id != ''
                   AND workspace_id = $workspaceId
                 ORDER BY updated_at DESC
                """,
                new DbSql.SqlParam("$workspaceId", workspaceId));
            return WorkerResponse.Json(rows, WorkerJsonContext.Default.ListPluginSessionRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse ListPluginSessionMessages(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var workspaceId = WorkspaceId(parameters);
            var limit = Math.Clamp(JsonHelpers.GetInt(parameters, "limit", 50), 1, 500);
            var offset = Math.Max(0, JsonHelpers.GetInt(parameters, "offset", 0));

            return WorkerResponse.Json(
                ListPluginSessionMessageRecords(sessionId, limit, offset, workspaceId, parameters),
                WorkerJsonContext.Default.ListPluginSessionMessageRow);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Error(ex.Message);
        }
    }

    public static WorkerResponse ClearPluginSession(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var workspaceId = WorkspaceId(parameters);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var deleted = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                DELETE FROM messages WHERE session_id IN (
                  SELECT id FROM sessions
                   WHERE id = $sessionId AND workspace_id = $workspaceId
                     AND plugin_id IS NOT NULL AND plugin_id != ''
                )
                """,
                new DbSql.SqlParam("$sessionId", sessionId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE sessions SET message_count = 0
                 WHERE id = $sessionId AND workspace_id = $workspaceId
                   AND plugin_id IS NOT NULL AND plugin_id != ''
                """,
                new DbSql.SqlParam("$sessionId", sessionId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();
            return Mutation(0, deleted);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse DeletePluginSession(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var workspaceId = WorkspaceId(parameters);
            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var deletedMessages = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                DELETE FROM messages WHERE session_id IN (
                  SELECT id FROM sessions
                   WHERE id = $sessionId AND workspace_id = $workspaceId
                     AND plugin_id IS NOT NULL AND plugin_id != ''
                )
                """,
                new DbSql.SqlParam("$sessionId", sessionId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            var deletedSessions = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                DELETE FROM sessions
                 WHERE id = $sessionId AND workspace_id = $workspaceId
                   AND plugin_id IS NOT NULL AND plugin_id != ''
                """,
                new DbSql.SqlParam("$sessionId", sessionId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();
            return Mutation(deletedSessions, deletedMessages);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse RenamePluginSession(JsonElement parameters)
    {
        try
        {
            var sessionId = RequireString(parameters, "sessionId");
            var workspaceId = WorkspaceId(parameters);
            var title = RequireString(parameters, "title");
            var updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();
            var changed = DbSql.ExecuteNonQuery(
                connection,
                transaction,
                """
                UPDATE sessions SET title = $title, updated_at = $updatedAt
                 WHERE id = $sessionId AND workspace_id = $workspaceId
                   AND plugin_id IS NOT NULL AND plugin_id != ''
                """,
                new DbSql.SqlParam("$title", title),
                new DbSql.SqlParam("$updatedAt", updatedAt),
                new DbSql.SqlParam("$sessionId", sessionId),
                new DbSql.SqlParam("$workspaceId", workspaceId));
            transaction.Commit();
            return Mutation(changed, 0);
        }
        catch (Exception ex)
        {
            return MutationError(ex.Message);
        }
    }

    public static WorkerResponse RoutePluginSession(JsonElement parameters)
    {
        try
        {
            var pluginId = RequireString(parameters, "pluginId");
            var chatId = RequireString(parameters, "chatId");
            var chatName = NormalizeOptional(JsonHelpers.GetString(parameters, "chatName"));
            var senderName = NormalizeOptional(JsonHelpers.GetString(parameters, "senderName"));
            var requestedProjectId = NormalizeOptional(JsonHelpers.GetString(parameters, "projectId"));
            var workspaceId = NormalizeOptional(JsonHelpers.GetString(parameters, "workspaceId")) ?? "local-personal";
            var providerId = NormalizeOptional(JsonHelpers.GetString(parameters, "providerId"));
            DbManagedProviderScope.Validate(providerId, workspaceId);
            var modelId = NormalizeOptional(JsonHelpers.GetString(parameters, "modelId"));
            var modelSource = parameters.TryGetProperty("modelSource", out var modelSourceElement) &&
                modelSourceElement.ValueKind != JsonValueKind.Null
                ? NormalizeModelSource(modelSourceElement.GetString(), workspaceId)
                : null;
            var compositeKey = BuildPluginMessageSessionKey(pluginId, chatId);
            var legacyCompositeKeyPrefix = BuildLegacyPluginMessageSessionKeyPrefix(pluginId, chatId);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            using var connection = DbConnectionFactory.OpenReadWrite(parameters);
            using var transaction = connection.BeginTransaction();

            var project = requestedProjectId is null
                ? null
                : FindProject(connection, transaction, requestedProjectId);
            if (project is not null && project.WorkspaceId != workspaceId)
            {
                throw new InvalidOperationException("Project workspace does not match channel workspace.");
            }
            var session = FindSessionByExternalChatId(connection, transaction, compositeKey);

            if (session is null)
            {
                session = FindLegacyPluginSession(
                    connection,
                    transaction,
                    pluginId,
                    legacyCompositeKeyPrefix);

                if (session is not null)
                {
                    DbSql.ExecuteNonQuery(
                        connection,
                        transaction,
                        "UPDATE sessions SET external_chat_id = $externalChatId WHERE id = $id",
                        new DbSql.SqlParam("$externalChatId", compositeKey),
                        new DbSql.SqlParam("$id", session.Id));
                }
            }

            var modelSelectionMode = providerId is not null && modelId is not null
                ? "manual"
                : "inherit";

            if (session is not null && session.WorkspaceId != workspaceId)
            {
                throw new InvalidOperationException("Channel session workspace does not match channel workspace.");
            }

            if (session is null)
            {
                var sessionId = CreateSessionId();
                var title = FirstNonEmpty(chatName, senderName, chatId) ?? chatId;

                DbSql.ExecuteNonQuery(
                    connection,
                    transaction,
                    """
                    INSERT INTO sessions (
                      id, title, icon, mode, created_at, updated_at, project_id, working_folder,
                      ssh_connection_id, pinned, plugin_id, external_chat_id, provider_id, model_id,
                      model_selection_mode, workspace_id, model_source
                    ) VALUES (
                      $id, $title, NULL, 'cowork', $createdAt, $updatedAt, $projectId, $workingFolder,
                      $sshConnectionId, 0, $pluginId, $externalChatId, $providerId, $modelId,
                      $modelSelectionMode, $workspaceId, $modelSource
                    )
                    """,
                    new DbSql.SqlParam("$id", sessionId),
                    new DbSql.SqlParam("$title", title),
                    new DbSql.SqlParam("$createdAt", now),
                    new DbSql.SqlParam("$updatedAt", now),
                    new DbSql.SqlParam("$projectId", project?.Id),
                    new DbSql.SqlParam("$workingFolder", EmptyToNull(project?.WorkingFolder)),
                    new DbSql.SqlParam("$sshConnectionId", project?.SshConnectionId),
                    new DbSql.SqlParam("$pluginId", pluginId),
                    new DbSql.SqlParam("$externalChatId", compositeKey),
                    new DbSql.SqlParam("$providerId", providerId),
                    new DbSql.SqlParam("$modelId", modelId),
                    new DbSql.SqlParam("$modelSelectionMode", modelSelectionMode),
                    new DbSql.SqlParam("$workspaceId", workspaceId),
                    new DbSql.SqlParam("$modelSource", modelSource));

                session = new RoutedSession(sessionId, title, project?.Id, workspaceId);
            }
            else
            {
                if (project is not null)
                {
                    DbSql.ExecuteNonQuery(
                        connection,
                        transaction,
                        """
                        UPDATE sessions
                           SET updated_at = $updatedAt,
                               project_id = $projectId,
                               working_folder = $workingFolder,
                               ssh_connection_id = $sshConnectionId
                         WHERE id = $id
                        """,
                        new DbSql.SqlParam("$updatedAt", now),
                        new DbSql.SqlParam("$projectId", project.Id),
                        new DbSql.SqlParam("$workingFolder", EmptyToNull(project.WorkingFolder)),
                        new DbSql.SqlParam("$sshConnectionId", project.SshConnectionId),
                        new DbSql.SqlParam("$id", session.Id));
                    session = session with { ProjectId = project.Id };
                }
                else
                {
                    DbSql.ExecuteNonQuery(
                        connection,
                        transaction,
                        "UPDATE sessions SET updated_at = $updatedAt WHERE id = $id",
                        new DbSql.SqlParam("$updatedAt", now),
                        new DbSql.SqlParam("$id", session.Id));
                }

                if (providerId is not null || modelId is not null || modelSource is not null)
                {
                    DbSql.ExecuteNonQuery(
                        connection,
                        transaction,
                        """
                        UPDATE sessions
                           SET provider_id = $providerId,
                               model_id = $modelId,
                               model_source = $modelSource,
                               model_selection_mode = $modelSelectionMode
                         WHERE id = $id
                        """,
                        new DbSql.SqlParam("$providerId", providerId),
                        new DbSql.SqlParam("$modelId", modelId),
                        new DbSql.SqlParam("$modelSource", modelSource),
                        new DbSql.SqlParam("$modelSelectionMode", modelSelectionMode),
                        new DbSql.SqlParam("$id", session.Id));
                }

                var betterTitle = FirstNonEmpty(chatName, senderName);
                if (ShouldReplaceSessionTitle(session.Title, betterTitle))
                {
                    DbSql.ExecuteNonQuery(
                        connection,
                        transaction,
                        "UPDATE sessions SET title = $title WHERE id = $id",
                        new DbSql.SqlParam("$title", betterTitle),
                        new DbSql.SqlParam("$id", session.Id));
                    session = session with { Title = betterTitle! };
                }
            }

            transaction.Commit();

            return WorkerResponse.Json(
                new PluginRouteSessionResult(
                    true,
                    session.Id,
                    session.Title,
                    project?.Id,
                    EmptyToNull(project?.WorkingFolder),
                    project?.SshConnectionId,
                    null),
                WorkerJsonContext.Default.PluginRouteSessionResult);
        }
        catch (Exception ex)
        {
            return WorkerResponse.Json(
                new PluginRouteSessionResult(false, null, null, null, null, null, ex.Message),
                WorkerJsonContext.Default.PluginRouteSessionResult);
        }
    }

    private const string SessionSelectSql = """
        SELECT id, title, icon, mode, created_at, updated_at, project_id, working_folder,
               ssh_connection_id, plan_id, pinned, plugin_id, external_chat_id, provider_id,
               model_id, model_selection_mode, COALESCE(message_count, 0) AS message_count
          FROM sessions
        """;

    internal static PluginSessionFindResult FindPluginSessionRecordByChat(
        string externalChatId,
        string? workspaceId = null,
        JsonElement? dbParameters = null)
    {
        try
        {
            using var connection = dbParameters.HasValue
                ? DbConnectionFactory.OpenReadWrite(dbParameters.Value)
                : OpenDefaultConnection();
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                {SessionSelectSql}
                 WHERE external_chat_id = $externalChatId
                   AND plugin_id IS NOT NULL AND plugin_id != ''
                   AND ($workspaceId IS NULL OR workspace_id = $workspaceId)
                 LIMIT 1
                """;
            command.Parameters.AddWithValue("$externalChatId", externalChatId);
            command.Parameters.AddWithValue("$workspaceId", (object?)workspaceId ?? DBNull.Value);

            using var reader = command.ExecuteReader();
            var session = reader.Read() ? ReadSessionRow(reader) : null;
            return new PluginSessionFindResult(true, session, null);
        }
        catch (Exception ex)
        {
            return new PluginSessionFindResult(false, null, ex.Message);
        }
    }

    internal static List<PluginSessionMessageRow> ListPluginSessionMessageRecords(
        string sessionId,
        int limit,
        int offset = 0,
        string? workspaceId = null,
        JsonElement? dbParameters = null)
    {
        using var connection = dbParameters.HasValue
            ? DbConnectionFactory.OpenReadWrite(dbParameters.Value)
            : OpenDefaultConnection();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT id, role, content, created_at
              FROM messages
             WHERE session_id = $sessionId
               AND EXISTS (
                 SELECT 1 FROM sessions
                  WHERE id = $sessionId
                    AND plugin_id IS NOT NULL AND plugin_id != ''
                    AND ($workspaceId IS NULL OR workspace_id = $workspaceId)
               )
             ORDER BY sort_order ASC
             LIMIT $limit OFFSET $offset
            """;
        command.Parameters.AddWithValue("$sessionId", sessionId);
        command.Parameters.AddWithValue("$workspaceId", (object?)workspaceId ?? DBNull.Value);
        command.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 500));
        command.Parameters.AddWithValue("$offset", Math.Max(0, offset));

        var rows = new List<PluginSessionMessageRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(new PluginSessionMessageRow
            {
                Id = reader.GetString(0),
                Role = reader.GetString(1),
                Content = reader.GetString(2),
                CreatedAt = reader.GetInt64(3)
            });
        }

        return rows;
    }

    private static List<PluginSessionRow> QuerySessionRows(
        SqliteConnection connection,
        string commandText,
        params DbSql.SqlParam[] parameters)
    {
        using var command = connection.CreateCommand();
        command.CommandText = commandText;
        foreach (var parameter in parameters)
        {
            command.Parameters.AddWithValue(parameter.Name, parameter.Value ?? DBNull.Value);
        }

        var rows = new List<PluginSessionRow>();
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
            rows.Add(ReadSessionRow(reader));
        }

        return rows;
    }

    private static PluginSessionRow ReadSessionRow(SqliteDataReader reader)
    {
        return new PluginSessionRow
        {
            Id = reader.GetString(0),
            Title = reader.IsDBNull(1) ? string.Empty : reader.GetString(1),
            Icon = GetNullableString(reader, 2),
            Mode = reader.IsDBNull(3) ? "chat" : reader.GetString(3),
            CreatedAt = reader.GetInt64(4),
            UpdatedAt = reader.GetInt64(5),
            ProjectId = GetNullableString(reader, 6),
            WorkingFolder = GetNullableString(reader, 7),
            SshConnectionId = GetNullableString(reader, 8),
            PlanId = GetNullableString(reader, 9),
            Pinned = reader.IsDBNull(10) ? 0 : reader.GetInt32(10),
            PluginId = GetNullableString(reader, 11),
            ExternalChatId = GetNullableString(reader, 12),
            ProviderId = GetNullableString(reader, 13),
            ModelId = GetNullableString(reader, 14),
            ModelSelectionMode = GetNullableString(reader, 15),
            MessageCount = reader.IsDBNull(16) ? 0 : reader.GetInt32(16)
        };
    }

    private static PluginProjectRow ReadProjectRow(SqliteDataReader reader)
    {
        return new PluginProjectRow
        {
            Id = reader.GetString(0),
            Name = reader.GetString(1),
            WorkingFolder = GetNullableString(reader, 2),
            SshConnectionId = GetNullableString(reader, 3),
            PluginId = GetNullableString(reader, 4),
            Pinned = reader.IsDBNull(5) ? 0 : reader.GetInt32(5),
            CreatedAt = reader.GetInt64(6),
            UpdatedAt = reader.GetInt64(7),
            WorkspaceId = reader.IsDBNull(8) ? "local-personal" : reader.GetString(8)
        };
    }

    private static ProjectRef? FindProject(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string projectId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT id, working_folder, ssh_connection_id, workspace_id
              FROM projects
             WHERE id = $id
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$id", projectId);

        using var reader = command.ExecuteReader();
        return reader.Read()
            ? new ProjectRef(
                reader.GetString(0),
                GetNullableString(reader, 1),
                GetNullableString(reader, 2),
                reader.IsDBNull(3) ? "local-personal" : reader.GetString(3))
            : null;
    }

    private static RoutedSession? FindSessionByExternalChatId(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string externalChatId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT id, title, project_id, workspace_id
              FROM sessions
             WHERE external_chat_id = $externalChatId
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$externalChatId", externalChatId);
        return ReadRoutedSession(command);
    }

    private static RoutedSession? FindLegacyPluginSession(
        SqliteConnection connection,
        SqliteTransaction transaction,
        string pluginId,
        string legacyCompositeKeyPrefix)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT id, title, project_id, workspace_id
              FROM sessions
             WHERE plugin_id = $pluginId
               AND external_chat_id LIKE $externalChatIdPrefix
             ORDER BY updated_at DESC
             LIMIT 1
            """;
        command.Parameters.AddWithValue("$pluginId", pluginId);
        command.Parameters.AddWithValue("$externalChatIdPrefix", $"{legacyCompositeKeyPrefix}%");
        return ReadRoutedSession(command);
    }

    private static RoutedSession? ReadRoutedSession(SqliteCommand command)
    {
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? new RoutedSession(
                reader.GetString(0),
                reader.IsDBNull(1) ? string.Empty : reader.GetString(1),
                GetNullableString(reader, 2),
                reader.IsDBNull(3) ? "local-personal" : reader.GetString(3))
            : null;
    }

    private static WorkerResponse Mutation(int changed, int deleted)
    {
        return WorkerResponse.Json(
            new PluginSessionMutationResult(true, changed, deleted, null),
            WorkerJsonContext.Default.PluginSessionMutationResult);
    }

    private static WorkerResponse MutationError(string error)
    {
        return WorkerResponse.Json(
            new PluginSessionMutationResult(false, 0, 0, error),
            WorkerJsonContext.Default.PluginSessionMutationResult);
    }

    private static string RequireString(JsonElement parameters, string name)
    {
        return JsonHelpers.GetString(parameters, name) is { Length: > 0 } value
            ? value
            : throw new InvalidOperationException($"Missing required plugin session field: {name}");
    }

    private static string BuildPluginMessageSessionKey(string pluginId, string chatId)
    {
        return $"plugin:{pluginId}:chat:{EncodeSessionKeyPart(chatId)}";
    }

    private static string BuildLegacyPluginMessageSessionKeyPrefix(string pluginId, string chatId)
    {
        return $"{BuildPluginMessageSessionKey(pluginId, chatId)}:message:";
    }

    private static string CreateSessionId()
    {
        return $"oc_{Guid.NewGuid():N}";
    }

    private static string EncodeSessionKeyPart(string value)
    {
        return Uri.EscapeDataString(value)
            .Replace("%21", "!", StringComparison.OrdinalIgnoreCase)
            .Replace("%27", "'", StringComparison.OrdinalIgnoreCase)
            .Replace("%28", "(", StringComparison.OrdinalIgnoreCase)
            .Replace("%29", ")", StringComparison.OrdinalIgnoreCase)
            .Replace("%2A", "*", StringComparison.OrdinalIgnoreCase);
    }

    private static bool ShouldReplaceSessionTitle(string? currentTitle, string? nextTitle)
    {
        var current = NormalizeOptional(currentTitle);
        var next = NormalizeOptional(nextTitle);
        if (next is null || string.Equals(current, next, StringComparison.Ordinal))
        {
            return false;
        }

        return current is null ||
            current == PlaceholderNewConversation ||
            current == PlaceholderNewChat ||
            current.StartsWith("oc_", StringComparison.OrdinalIgnoreCase) ||
            current.StartsWith("Plugin ", StringComparison.OrdinalIgnoreCase);
    }

    private static string? FirstNonEmpty(params string?[] values)
    {
        foreach (var value in values)
        {
            if (NormalizeOptional(value) is { } normalized)
            {
                return normalized;
            }
        }

        return null;
    }

    private static string? NormalizeOptional(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static string WorkspaceId(JsonElement parameters)
    {
        var value = JsonHelpers.GetString(parameters, "workspaceId");
        if (value is null) return "local-personal";
        if (value.Length == 0 || value.Length > 1024 || value != value.Trim())
        {
            throw new InvalidOperationException("Invalid channel workspace.");
        }
        return value;
    }

    // Channel model bindings are public identifiers only. Do not allow this
    // compatibility boundary to accept a provider credential or account ticket.
    private static string? NormalizeModelSource(string? value, string workspaceId)
    {
        var trimmed = NormalizeOptional(value);
        if (trimmed is null) return null;
        if (trimmed.Length > 4096) throw new InvalidOperationException("Invalid model source.");
        using var document = JsonDocument.Parse(trimmed);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Invalid model source.");
        var kind = JsonHelpers.GetString(root, "kind");
        var valid = kind == "local"
            ? IsModelSourceIdentifier(JsonHelpers.GetString(root, "providerId")) &&
              IsModelSourceIdentifier(JsonHelpers.GetString(root, "modelId")) &&
              root.EnumerateObject().Count() == 3
            : (kind == "ola-personal" || kind == "ola-team") &&
              IsModelSourceIdentifier(JsonHelpers.GetString(root, "workspaceId")) &&
              JsonHelpers.GetString(root, "workspaceId") == workspaceId &&
              IsModelSourceIdentifier(JsonHelpers.GetString(root, "resourceId")) &&
              root.EnumerateObject().Count() == 3;
        if (!valid) throw new InvalidOperationException("Invalid model source.");
        return root.GetRawText();
    }

    private static bool IsModelSourceIdentifier(string? value) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= 1024 && !value.Any(char.IsControl);

    private static string? EmptyToNull(string? value)
    {
        return string.IsNullOrEmpty(value) ? null : value;
    }

    private static string? GetNullableString(SqliteDataReader reader, int ordinal)
    {
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private sealed record ProjectRef(string Id, string? WorkingFolder, string? SshConnectionId, string WorkspaceId);

    private sealed record RoutedSession(string Id, string Title, string? ProjectId, string WorkspaceId);
}
