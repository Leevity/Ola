using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;

// The reserved origin is an IPC route. It must never reach DNS or carry credentials.
internal sealed class ManagedModelHttpHandler : DelegatingHandler
{

    public ManagedModelHttpHandler(HttpMessageHandler inner) : base(inner) { }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (request.RequestUri?.Host != "ola.invalid")
            return await base.SendAsync(request, cancellationToken);
        var scope = WorkerRequestScope.Current.Value ?? throw new InvalidOperationException("Ola model request requires a worker context");
        var bytes = request.Content is null ? Array.Empty<byte>() : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        var opened = await Reverse(scope.Context, "ola/model-open", new JsonObject
        {
            ["url"] = request.RequestUri.ToString(),
            ["sessionId"] = scope.SessionId,
            ["body"] = Convert.ToBase64String(bytes),
            ["contentType"] = request.Content?.Headers.ContentType?.ToString() ?? "application/json"
        }, cancellationToken);
        var handle = JsonHelpers.GetString(opened, "handle") ?? throw new InvalidOperationException("Missing Ola stream handle");
        var response = new HttpResponseMessage((HttpStatusCode)(JsonHelpers.GetIntNullable(opened, "status") ?? 200))
        {
            Content = new StreamContent(new ReverseStream(scope.Context, handle)),
            RequestMessage = request
        };
        response.Content.Headers.TryAddWithoutValidation("Content-Type", JsonHelpers.GetString(opened, "contentType"));
        return response;
    }

    private static Task<JsonElement> Reverse(WorkerRequestContext context, string method, JsonObject input, CancellationToken token)
    {
        using var document = JsonDocument.Parse(input.ToJsonString());
        return AgentRuntimeReverseRequests.RequestAsync(context, method, document.RootElement.Clone(), token);
    }

    private sealed class ReverseStream(WorkerRequestContext context, string handle) : Stream
    {
        private byte[] pending = [];
        private int offset;
        private bool done;
        private bool closed;
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count).GetAwaiter().GetResult();
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (buffer.Length == 0) return 0;
            while (offset == pending.Length && !done)
            {
                var chunk = await Reverse(context, "ola/model-read", new JsonObject { ["handle"] = handle }, cancellationToken);
                done = chunk.TryGetProperty("done", out var finished) && finished.ValueKind == JsonValueKind.True;
                pending = Convert.FromBase64String(JsonHelpers.GetString(chunk, "data") ?? "");
                offset = 0;
            }
            var count = Math.Min(buffer.Length, pending.Length - offset);
            pending.AsMemory(offset, count).CopyTo(buffer);
            offset += count;
            return count;
        }

        protected override void Dispose(bool disposing)
        {
            if (!closed)
            {
                closed = true;
                _ = CloseAsync();
            }
            base.Dispose(disposing);
        }

        private async Task CloseAsync()
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await Reverse(context, "ola/model-close", new JsonObject { ["handle"] = handle }, timeout.Token);
            }
            catch { /* Main also expires abandoned streams. */ }
        }
    }
}
