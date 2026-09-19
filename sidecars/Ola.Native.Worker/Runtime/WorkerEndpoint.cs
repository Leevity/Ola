internal sealed record WorkerEndpoint(string Address, string? AuthenticationToken)
{
    public static WorkerEndpoint Parse(string[] args)
    {
        string? token = null;
        for (var i = 0; i < args.Length; i++)
        {
            if (string.Equals(args[i], "--ipc-token", StringComparison.Ordinal) && i + 1 < args.Length)
            {
                token = args[i + 1];
            }
        }
        for (var i = 0; i < args.Length; i++)
        {
            if (!string.Equals(args[i], "--ipc", StringComparison.Ordinal))
            {
                continue;
            }

            if (i + 1 >= args.Length || string.IsNullOrWhiteSpace(args[i + 1]))
            {
                throw new ArgumentException("Missing value for --ipc.");
            }

            return new WorkerEndpoint(args[i + 1], token);
        }

        throw new ArgumentException("Native worker requires --ipc <unix-socket-path|named-pipe-path>.");
    }
}
