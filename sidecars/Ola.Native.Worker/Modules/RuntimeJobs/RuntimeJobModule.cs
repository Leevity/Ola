using System.Text.Json;

internal sealed class RuntimeJobModule : IWorkerModule
{
    public string Name => "runtime-jobs";
    public void Register(WorkerModuleContext context)
    {
        context.Register("runtime/jobs-submit", Submit);
        context.Register("runtime/jobs-list", List);
        context.Register("runtime/jobs-state", SetState);
        context.Register("runtime/jobs-cancel", Cancel);
        context.Register("runtime/jobs-get", Get);
    }
    private static WorkerResponse Get(JsonElement p)
    {
        var id = JsonHelpers.GetString(p, "jobId")?.Trim(); if (string.IsNullOrEmpty(id)) return WorkerResponse.Error("jobId is required");
        var job = RuntimeJobStore.Get(id, p); return WorkerResponse.Json(new RuntimeJobStateResult(job is not null, job), WorkerJsonContext.Default.RuntimeJobStateResult);
    }

    private static WorkerResponse Submit(JsonElement p) => WorkerResponse.Json(RuntimeJobStore.Submit(p), WorkerJsonContext.Default.RuntimeJobMutationResult);
    private static WorkerResponse List(JsonElement p) => WorkerResponse.Json(RuntimeJobStore.List(p), WorkerJsonContext.Default.ListRuntimeJobRecord);
    private static WorkerResponse SetState(JsonElement p) => WorkerResponse.Json(RuntimeJobStore.SetState(p), WorkerJsonContext.Default.RuntimeJobRecord);
    private static WorkerResponse Cancel(JsonElement p)
    {
        var id = JsonHelpers.GetString(p, "jobId")?.Trim();
        if (string.IsNullOrEmpty(id)) return WorkerResponse.Error("jobId is required");
        return WorkerResponse.Json(RuntimeJobStore.Cancel(id), WorkerJsonContext.Default.RuntimeJobRecord);
    }
}
