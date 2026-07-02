using System.Diagnostics;

internal sealed class SystemModule : IWorkerModule
{
    public string Name => "system";

    public void Register(WorkerModuleContext context)
    {
        context.Register("worker/ping", _ =>
            WorkerResponse.Json(
                new StatusResult(true, Environment.ProcessId),
                WorkerJsonContext.Default.StatusResult));
        context.Register("worker/routes", _ =>
            WorkerResponse.Json(
                new WorkerRoutesResult(context.GetRegisteredMethods()),
                WorkerJsonContext.Default.WorkerRoutesResult));
        context.Register("worker/memory", _ =>
            WorkerResponse.Json(
                SystemMemorySnapshot.Capture(),
                WorkerJsonContext.Default.SystemMemorySnapshot));
    }
}

internal sealed record SystemMemorySnapshot(
    bool Success,
    int Pid,
    long ManagedBytes,
    long HeapBytes,
    long FragmentedBytes,
    long WorkingSetBytes,
    string? Error)
{
    public static SystemMemorySnapshot Capture()
    {
        try
        {
            var gcInfo = GC.GetGCMemoryInfo();
            using var process = Process.GetCurrentProcess();
            return new SystemMemorySnapshot(
                true,
                Environment.ProcessId,
                GC.GetTotalMemory(forceFullCollection: false),
                gcInfo.HeapSizeBytes,
                gcInfo.FragmentedBytes,
                process.WorkingSet64,
                null);
        }
        catch (Exception ex)
        {
            return new SystemMemorySnapshot(
                false,
                Environment.ProcessId,
                0,
                0,
                0,
                0,
                ex.Message);
        }
    }
}
