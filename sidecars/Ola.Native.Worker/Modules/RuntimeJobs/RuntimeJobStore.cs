using Microsoft.Data.Sqlite;
using System.Text.Json;

internal static class RuntimeJobStore
{
    public static RuntimeJobMutationResult SubmitRun(string runId, string sessionId, JsonElement parameters)
    {
        var json = $"{{\"jobId\":{Quote(runId)},\"runId\":{Quote(runId)},\"sessionId\":{Quote(sessionId)},\"method\":\"agent/run\",\"idempotencyKey\":{Quote(runId)},\"laneKey\":{Quote(sessionId)},\"params\":{parameters.GetRawText()}}}";
        using var document = JsonDocument.Parse(json);
        return Submit(document.RootElement);
    }

    public static RuntimeJobRecord? SetState(string jobId, string state, string? errorCode = null, string? errorMessage = null)
    {
        var json = $"{{\"jobId\":{Quote(jobId)},\"state\":{Quote(state)}" +
            (errorCode is null ? string.Empty : $",\"errorCode\":{Quote(errorCode)}") +
            (errorMessage is null ? string.Empty : $",\"errorMessage\":{Quote(errorMessage)}") + "}";
        using var document = JsonDocument.Parse(json);
        return SetState(document.RootElement);
    }

    public static RuntimeJobRecord? Cancel(string jobId)
    {
        return SetState(jobId, "cancelled", "cancelled", "Job cancellation requested.");
    }

    public static void AppendEvent(string jobId, long seq, string payloadJson, bool terminal)
    {
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbConnectionFactory.ResolveDbPath(default));
        using var command = connection.CreateCommand();
        command.CommandText = "INSERT OR REPLACE INTO runtime_job_events(job_id,seq,payload_json,terminal,created_at) VALUES($jobId,$seq,$payload,$terminal,$now)";
        Add(command, "$jobId", jobId); Add(command, "$seq", seq); Add(command, "$payload", payloadJson); Add(command, "$terminal", terminal ? 1 : 0); Add(command, "$now", Now()); command.ExecuteNonQuery();
    }

    public static List<RuntimeJobEventRecord> ReplayEvents(JsonElement p)
    {
        var jobId = Required(p, "jobId"); var after = p.TryGetProperty("afterSeq", out var raw) && raw.TryGetInt64(out var value) ? value : 0;
        var limit = p.TryGetProperty("limit", out var limitRaw) && limitRaw.TryGetInt32(out var parsed) ? Math.Clamp(parsed, 1, 4096) : 1024;
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbConnectionFactory.ResolveDbPath(p)); using var command = connection.CreateCommand();
        command.CommandText = "SELECT job_id,seq,payload_json,terminal,created_at FROM runtime_job_events WHERE job_id=$jobId AND seq>$after ORDER BY seq LIMIT $limit";
        Add(command, "$jobId", jobId); Add(command, "$after", after); Add(command, "$limit", limit); using var reader = command.ExecuteReader();
        var result = new List<RuntimeJobEventRecord>(); while (reader.Read()) result.Add(new(reader.GetString(0), reader.GetInt64(1), reader.GetString(2), reader.GetInt32(3) != 0, reader.GetInt64(4))); return result;
    }

    public static RuntimeJobMutationResult Submit(JsonElement p)
    {
        var jobId = Required(p, "jobId");
        var method = Required(p, "method");
        var idempotencyKey = Optional(p, "idempotencyKey");
        var now = Now();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbConnectionFactory.ResolveDbPath(p));
        using var tx = connection.BeginTransaction();
        RuntimeJobRecord? existing = null;
        if (idempotencyKey is not null)
            existing = Read(connection, tx, "SELECT job_id,run_id,session_id,method,state,idempotency_key,lane_key,error_code,error_message,created_at,updated_at,finished_at FROM runtime_jobs WHERE idempotency_key=$key", new DbSql.SqlParam("$key", idempotencyKey));
        if (existing is not null) { tx.Commit(); return new(false, true, existing); }

        using var command = connection.CreateCommand();
        command.Transaction = tx;
        command.CommandText = "INSERT INTO runtime_jobs(job_id,run_id,session_id,method,state,idempotency_key,lane_key,params_json,created_at,updated_at) VALUES($jobId,$runId,$sessionId,$method,'queued',$key,$laneKey,$params,$now,$now)";
        Add(command, "$jobId", jobId); Add(command, "$runId", Optional(p, "runId")); Add(command, "$sessionId", Optional(p, "sessionId"));
        Add(command, "$method", method); Add(command, "$key", idempotencyKey); Add(command, "$laneKey", Optional(p, "laneKey"));
        Add(command, "$params", p.TryGetProperty("params", out var body) ? body.GetRawText() : "{}"); Add(command, "$now", now);
        command.ExecuteNonQuery(); tx.Commit();
        return new(true, false, Get(jobId, p));
    }

    public static RuntimeJobRecord? Get(string jobId, JsonElement p)
    {
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbConnectionFactory.ResolveDbPath(p));
        return Read(connection, null, "SELECT job_id,run_id,session_id,method,state,idempotency_key,lane_key,error_code,error_message,created_at,updated_at,finished_at FROM runtime_jobs WHERE job_id=$jobId", new DbSql.SqlParam("$jobId", jobId));
    }

    public static List<RuntimeJobRecord> List(JsonElement p)
    {
        var limit = p.TryGetProperty("limit", out var raw) && raw.TryGetInt32(out var value) ? Math.Clamp(value, 1, 500) : 100;
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbConnectionFactory.ResolveDbPath(p));
        using var command = connection.CreateCommand(); command.CommandText = "SELECT job_id,run_id,session_id,method,state,idempotency_key,lane_key,error_code,error_message,created_at,updated_at,finished_at FROM runtime_jobs ORDER BY created_at DESC LIMIT $limit"; command.Parameters.AddWithValue("$limit", limit);
        using var reader = command.ExecuteReader(); var result = new List<RuntimeJobRecord>(); while (reader.Read()) result.Add(Read(reader)); return result;
    }

    public static RuntimeJobRecord? SetState(JsonElement p)
    {
        var jobId = Required(p, "jobId"); var state = Required(p, "state"); var now = Now();
        using var connection = DbConnectionFactory.OpenReadWriteCreate(DbConnectionFactory.ResolveDbPath(p)); using var command = connection.CreateCommand();
        command.CommandText = "UPDATE runtime_jobs SET state=$state,error_code=$errorCode,error_message=$errorMessage,updated_at=$now,finished_at=CASE WHEN $terminal=1 THEN COALESCE(finished_at,$now) ELSE finished_at END WHERE job_id=$jobId";
        Add(command, "$state", state); Add(command, "$errorCode", Optional(p, "errorCode")); Add(command, "$errorMessage", Optional(p, "errorMessage")); Add(command, "$now", now); Add(command, "$terminal", state is "succeeded" or "failed" or "cancelled" ? 1 : 0); Add(command, "$jobId", jobId); command.ExecuteNonQuery();
        return Get(jobId, p);
    }

    private static RuntimeJobRecord? Read(SqliteConnection c, SqliteTransaction? tx, string sql, params DbSql.SqlParam[] parameters)
    { using var command = c.CreateCommand(); command.Transaction = tx; command.CommandText = sql; foreach (var p in parameters) Add(command, p.Name, p.Value); using var reader = command.ExecuteReader(); return reader.Read() ? Read(reader) : null; }
    private static RuntimeJobRecord Read(SqliteDataReader r) => new(r.GetString(0), StringOrNull(r,1), StringOrNull(r,2), r.GetString(3), r.GetString(4), StringOrNull(r,5), StringOrNull(r,6), StringOrNull(r,7), StringOrNull(r,8), r.GetInt64(9), r.GetInt64(10), r.IsDBNull(11) ? null : r.GetInt64(11));
    private static string? StringOrNull(SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
    private static string Required(JsonElement p, string name) => Optional(p, name) ?? throw new ArgumentException($"{name} is required");
    private static string? Optional(JsonElement p, string name) => JsonHelpers.GetString(p, name)?.Trim() is { Length: > 0 } value ? value : null;
    private static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private static void Add(SqliteCommand c, string n, object? v) => c.Parameters.AddWithValue(n, v ?? DBNull.Value);
    private static string Quote(string value) => $"\"{JsonEncodedText.Encode(value ?? string.Empty).ToString()}\"";
}
