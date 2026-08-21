using System.Text.Json;

/// <summary>
/// Indicates that a provider did not return response headers before the configured deadline.
/// This is safe to retry because no provider event could have reached the runtime yet.
/// </summary>
internal sealed class AgentRuntimeProviderRequestTimeoutException : TimeoutException
{
    public AgentRuntimeProviderRequestTimeoutException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

internal static class AgentRuntimeRequestTimeout
{
    public const int DefaultTimeoutSeconds = 100;

    public static TimeSpan? Resolve(JsonElement provider)
    {
        var seconds = JsonHelpers.GetIntNullable(provider, "requestTimeoutSeconds")
            ?? DefaultTimeoutSeconds;
        return seconds > 0 ? TimeSpan.FromSeconds(seconds) : null;
    }

    public static async Task<HttpResponseMessage> SendAsync(
        HttpClient http,
        HttpRequestMessage request,
        JsonElement provider,
        string providerLabel,
        CancellationToken cancellationToken)
    {
        var configured = Resolve(provider);
        if (configured is not { } timeout)
        {
            return await http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
        }

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        try
        {
            return await http.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                deadline.Token);
        }
        catch (OperationCanceledException ex)
            when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new AgentRuntimeProviderRequestTimeoutException(
                $"{providerLabel} did not return response headers within {timeout.TotalSeconds:0}s. " +
                "Increase the API request timeout in Settings, or set it to 0 to wait indefinitely.",
                ex);
        }
    }
}
