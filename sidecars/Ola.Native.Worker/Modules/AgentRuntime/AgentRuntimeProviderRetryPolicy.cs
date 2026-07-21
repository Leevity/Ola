using System.Net;

internal sealed class AgentRuntimeProviderHttpException : InvalidOperationException
{
    private const int MaxResponseSummaryChars = 2_048;
    public AgentRuntimeProviderHttpException(
        string providerName,
        HttpStatusCode statusCode,
        string responseBody,
        TimeSpan? retryAfter)
        : base($"{providerName} request failed HTTP {(int)statusCode}: {responseBody}")
    {
        StatusCode = (int)statusCode;
        RetryAfter = retryAfter;
    }

    public int StatusCode { get; }

    public TimeSpan? RetryAfter { get; }

    public static async Task<AgentRuntimeProviderHttpException> CreateAsync(
        string providerName,
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
        var responseSummary = responseBody.Length <= MaxResponseSummaryChars
            ? responseBody
            : $"{responseBody[..MaxResponseSummaryChars]}…";
        var retryAfter = response.Headers.RetryAfter?.Delta;
        if (!retryAfter.HasValue && response.Headers.RetryAfter?.Date is { } retryDate)
        {
            retryAfter = retryDate - DateTimeOffset.UtcNow;
        }
        return new AgentRuntimeProviderHttpException(
            providerName,
            response.StatusCode,
            responseSummary,
            retryAfter);
    }
}

internal static class AgentRuntimeProviderRetryPolicy
{
    // Reserved extension seam for request lifecycle instrumentation. No hook is registered in
    // this release, so provider requests keep their existing behavior and data boundary.
    internal interface IRequestLifecycleHook
    {
        Task BeforeAttemptAsync(int attempt, CancellationToken cancellationToken);

        Task AfterAttemptAsync(
            int attempt,
            int? statusCode,
            Exception? error,
            CancellationToken cancellationToken);
    }

    internal const int DefaultMaxAttempts = 4;
    internal const int MinMaxAttempts = 1;
    internal const int MaxMaxAttempts = 6;
    private const int InitialRetryDelayMs = 1_000;
    private const int MaxBackoffMs = 30_000;
    private const int MaxRetryAfterMs = 60_000;

    public static async Task<AgentRuntimeProviderTurnResult> ExecuteAsync(
        Func<Task<AgentRuntimeProviderTurnResult>> execute,
        AgentRuntimeTools.AgentRuntimeRunState state,
        WorkerRequestContext context,
        IRequestLifecycleHook? lifecycleHook = null)
    {
        var maxAttempts = Math.Clamp(
            JsonHelpers.GetInt(state.Parameters, "providerRetryMaxAttempts", DefaultMaxAttempts),
            MinMaxAttempts,
            MaxMaxAttempts);
        var previousDelayMs = 0;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                if (lifecycleHook is not null)
                {
                    await lifecycleHook.BeforeAttemptAsync(attempt, state.CancellationToken);
                }
                var result = await execute();
                if (lifecycleHook is not null)
                {
                    await lifecycleHook.AfterAttemptAsync(
                        attempt,
                        null,
                        null,
                        state.CancellationToken);
                }
                return result;
            }
            catch (AgentRuntimeProviderHttpException ex) when (
                IsRetryableStatus(ex.StatusCode) &&
                attempt < maxAttempts &&
                !state.IsCancellationRequested)
            {
                if (lifecycleHook is not null)
                {
                    await lifecycleHook.AfterAttemptAsync(
                        attempt,
                        ex.StatusCode,
                        ex,
                        state.CancellationToken);
                }
                var delayMs = ComputeDelayMs(attempt, previousDelayMs, ex.RetryAfter);
                previousDelayMs = delayMs;
                var nextAttempt = attempt + 1;
                WorkerLog.Warn(
                    $"provider request HTTP {ex.StatusCode}; retrying in {delayMs}ms " +
                    $"attempt={nextAttempt}/{maxAttempts}");
                await AgentRuntimeTools.EmitAsync(
                    state,
                    context,
                    new AgentRuntimeStreamEvent(
                        "request_retry",
                        Reason: $"HTTP {ex.StatusCode}",
                        Attempt: nextAttempt,
                        MaxAttempts: maxAttempts,
                        DelayMs: delayMs,
                        StatusCode: ex.StatusCode));
                await Task.Delay(delayMs, state.CancellationToken);
            }
        }
    }

    private static bool IsRetryableStatus(int statusCode)
    {
        return statusCode == 429 || statusCode >= 500;
    }

    private static int ComputeDelayMs(int attempt, int previousDelayMs, TimeSpan? retryAfter)
    {
        var exponentialDelayMs = (int)Math.Min(
            MaxBackoffMs,
            InitialRetryDelayMs * Math.Pow(2, Math.Max(0, attempt - 1)));
        var retryAfterMs = retryAfter.HasValue
            ? (int)Math.Clamp(retryAfter.Value.TotalMilliseconds, 0, MaxRetryAfterMs)
            : 0;
        return Math.Max(
            Math.Max(exponentialDelayMs, retryAfterMs),
            previousDelayMs);
    }
}
