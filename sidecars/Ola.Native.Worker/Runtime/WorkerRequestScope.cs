// The shared dispatcher carries request identity without depending on any Agent module.
internal sealed record WorkerRequestScope(WorkerRequestContext Context, string? SessionId)
{
    internal static readonly AsyncLocal<WorkerRequestScope?> Current = new();
}
