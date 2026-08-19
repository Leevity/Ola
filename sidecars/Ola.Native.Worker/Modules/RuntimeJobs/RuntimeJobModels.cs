internal sealed record RuntimeJobRecord(
    string JobId, string? RunId, string? SessionId, string Method, string State,
    string? IdempotencyKey, string? LaneKey, string? ErrorCode, string? ErrorMessage,
    long CreatedAt, long UpdatedAt, long? FinishedAt);

internal sealed record RuntimeJobMutationResult(bool Accepted, bool Duplicate, RuntimeJobRecord? Job);
internal sealed record RuntimeJobStateResult(bool Found, RuntimeJobRecord? Job);
internal sealed record RuntimeJobEventRecord(string JobId, long Seq, string PayloadJson, bool Terminal, long CreatedAt);
