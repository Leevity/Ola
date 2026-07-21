using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

internal enum PermissionCommandOutcome
{
    RequireApproval,
    Allow,
    Deny
}

internal readonly record struct PermissionCommandDecision(
    PermissionCommandOutcome Outcome,
    string? MatchedPattern,
    bool DenyEvaluationUnreliable = false);

/// <summary>
/// User-configured permission whitelist/blacklist evaluated at the tool-dispatch chokepoint.
/// Mirrors src/shared/permission-policy.ts — keep the matching semantics in sync.
/// Precedence: deny rules > tool whitelist / allow rules > normal approval flow.
/// Command matching is case-insensitive; tool-name matching is Ordinal case-sensitive.
/// Allow rules must describe the entire command (anchored; every compound segment must
/// match); deny regex rules are unanchored so a substring hit is enough to reject.
/// </summary>
internal sealed class AgentRuntimePermissionPolicy
{
    private const int MaxPatternLength = 1000;
    private static readonly TimeSpan MatchTimeout = TimeSpan.FromMilliseconds(100);

    public static readonly AgentRuntimePermissionPolicy Disabled = new(
        false,
        new HashSet<string>(StringComparer.Ordinal),
        new List<Regex>(),
        new List<CompiledRule>(),
        new List<CompiledRule>());

    private static readonly ConcurrentDictionary<string, AgentRuntimePermissionPolicy> Cache =
        new(StringComparer.Ordinal);

    private sealed record CompiledRule(Regex Matcher, string Pattern, bool IsWildcard);

    private readonly bool enabled;
    private readonly HashSet<string> whitelistedTools;
    private readonly List<Regex> whitelistedToolMatchers;
    private readonly List<CompiledRule> allowRules;
    private readonly List<CompiledRule> denyRules;

    private AgentRuntimePermissionPolicy(
        bool enabled,
        HashSet<string> whitelistedTools,
        List<Regex> whitelistedToolMatchers,
        List<CompiledRule> allowRules,
        List<CompiledRule> denyRules)
    {
        this.enabled = enabled;
        this.whitelistedTools = whitelistedTools;
        this.whitelistedToolMatchers = whitelistedToolMatchers;
        this.allowRules = allowRules;
        this.denyRules = denyRules;
    }

    public bool Enabled => enabled;

    public static bool IsCommandTool(string toolName)
    {
        return toolName is "Bash" or "Shell" or "Monitor" or "PowerShell";
    }

    public static AgentRuntimePermissionPolicy Resolve(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("permissionPolicy", out var policy) ||
            policy.ValueKind != JsonValueKind.Object)
        {
            return Disabled;
        }
        var key = policy.GetRawText();
        if (Cache.Count > 64)
        {
            Cache.Clear();
        }
        return Cache.GetOrAdd(key, static (_, element) => Compile(element), policy);
    }

    public bool SkipsApproval(string toolName, JsonElement input)
    {
        if (!enabled)
        {
            return false;
        }
        if (IsCommandTool(toolName))
        {
            var command = JsonHelpers.GetString(input, "command") ?? string.Empty;
            var decision = EvaluateCommand(command);
            if (decision.Outcome == PermissionCommandOutcome.Deny || decision.DenyEvaluationUnreliable)
            {
                return false;
            }
            if (decision.Outcome == PermissionCommandOutcome.Allow)
            {
                return true;
            }
            return IsToolWhitelisted(toolName);
        }
        return IsToolWhitelisted(toolName);
    }

    public string? EvaluateDenyReason(string toolName, JsonElement input)
    {
        if (!enabled || !IsCommandTool(toolName))
        {
            return null;
        }
        var command = JsonHelpers.GetString(input, "command") ?? string.Empty;
        var decision = EvaluateCommand(command);
        if (decision.Outcome != PermissionCommandOutcome.Deny)
        {
            return null;
        }
        WorkerLog.Debug($"permission policy denied tool={toolName} rule={decision.MatchedPattern}");
        return "Command rejected by the user's permission blacklist " +
            $"(rule: {decision.MatchedPattern}). This command must not be executed and will " +
            "always be rejected. Do not retry it or trivially rephrase it; choose a different " +
            "approach or ask the user.";
    }

    public bool IsToolWhitelisted(string toolName)
    {
        if (!enabled)
        {
            return false;
        }
        var name = toolName?.Trim() ?? string.Empty;
        if (name.Length == 0)
        {
            return false;
        }
        if (whitelistedTools.Contains(name))
        {
            return true;
        }
        foreach (var matcher in whitelistedToolMatchers)
        {
            try
            {
                if (matcher.IsMatch(name))
                {
                    return true;
                }
            }
            catch (RegexMatchTimeoutException)
            {
                // A timed-out tool-name matcher simply does not whitelist.
            }
        }
        return false;
    }

    public PermissionCommandDecision EvaluateCommand(string command)
    {
        if (!enabled)
        {
            return new PermissionCommandDecision(PermissionCommandOutcome.RequireApproval, null);
        }
        var text = command?.Trim() ?? string.Empty;
        if (text.Length == 0)
        {
            return new PermissionCommandDecision(PermissionCommandOutcome.RequireApproval, null);
        }

        string[]? segments = null;
        var denyEvaluationFailed = false;
        foreach (var rule in denyRules)
        {
            try
            {
                if (rule.Matcher.IsMatch(text))
                {
                    return new PermissionCommandDecision(PermissionCommandOutcome.Deny, rule.Pattern);
                }
                if (rule.IsWildcard)
                {
                    segments ??= SplitCommandSegments(text);
                    foreach (var segment in segments)
                    {
                        if (rule.Matcher.IsMatch(segment))
                        {
                            return new PermissionCommandDecision(
                                PermissionCommandOutcome.Deny,
                                rule.Pattern);
                        }
                    }
                }
            }
            catch (RegexMatchTimeoutException)
            {
                // Never auto-allow a command whose deny evaluation failed.
                denyEvaluationFailed = true;
                WorkerLog.Warn($"permission policy deny rule timed out pattern={rule.Pattern}");
            }
        }
        if (denyEvaluationFailed)
        {
            return new PermissionCommandDecision(
                PermissionCommandOutcome.RequireApproval,
                null,
                DenyEvaluationUnreliable: true);
        }

        if (allowRules.Count == 0 || HasShellExpansion(text))
        {
            return new PermissionCommandDecision(PermissionCommandOutcome.RequireApproval, null);
        }
        segments ??= SplitCommandSegments(text);
        if (segments.Length == 0)
        {
            return new PermissionCommandDecision(PermissionCommandOutcome.RequireApproval, null);
        }
        foreach (var segment in segments)
        {
            var matched = false;
            foreach (var rule in allowRules)
            {
                try
                {
                    if (rule.Matcher.IsMatch(segment))
                    {
                        matched = true;
                        break;
                    }
                }
                catch (RegexMatchTimeoutException)
                {
                    // A timed-out allow rule contributes nothing.
                }
            }
            if (!matched)
            {
                return new PermissionCommandDecision(PermissionCommandOutcome.RequireApproval, null);
            }
        }
        return new PermissionCommandDecision(PermissionCommandOutcome.Allow, null);
    }

    /// <summary>
    /// Command/process/variable substitution can smuggle arbitrary execution past a
    /// prefix-style allow rule, so such commands always fall back to confirmation.
    /// Deny rules are evaluated before this check and still apply.
    /// </summary>
    private static bool HasShellExpansion(string command)
    {
        return command.Contains("$(", StringComparison.Ordinal) ||
            command.Contains('`') ||
            command.Contains("${", StringComparison.Ordinal) ||
            command.Contains("<(", StringComparison.Ordinal) ||
            command.Contains(">(", StringComparison.Ordinal);
    }

    /// <summary>
    /// Split a compound command on shell separators (&amp;&amp;, ||, ;, |, &amp;, newline) so every
    /// segment must independently match an allow rule. Redirections like 2>&amp;1 / &amp;> are kept
    /// intact. Not quote-aware — quoted separators over-split, which fails safe (falls back
    /// to the confirmation dialog).
    /// </summary>
    private static string[] SplitCommandSegments(string command)
    {
        var segments = new List<string>();
        var current = new StringBuilder();
        var index = 0;
        void Push()
        {
            var trimmed = current.ToString().Trim();
            if (trimmed.Length > 0)
            {
                segments.Add(trimmed);
            }
            current.Clear();
        }
        while (index < command.Length)
        {
            var ch = command[index];
            var next = index + 1 < command.Length ? command[index + 1] : '\0';
            var prev = index > 0 ? command[index - 1] : '\0';
            if (ch == '\n' || ch == ';')
            {
                Push();
                index += 1;
            }
            else if (ch == '|')
            {
                Push();
                index += next == '|' || next == '&' ? 2 : 1;
            }
            else if (ch == '&')
            {
                if (next == '&')
                {
                    Push();
                    index += 2;
                }
                else if (prev == '>' || next == '>')
                {
                    current.Append(ch);
                    index += 1;
                }
                else
                {
                    Push();
                    index += 1;
                }
            }
            else
            {
                current.Append(ch);
                index += 1;
            }
        }
        Push();
        return segments.ToArray();
    }

    private static string WildcardToRegexSource(string pattern)
    {
        var escaped = Regex.Escape(pattern)
            .Replace("\\*", "[\\s\\S]*", StringComparison.Ordinal)
            .Replace("\\?", "[\\s\\S]", StringComparison.Ordinal);
        return $"^{escaped}$";
    }

    private static AgentRuntimePermissionPolicy Compile(JsonElement policy)
    {
        if (!JsonHelpers.GetBool(policy, "enabled", false))
        {
            return Disabled;
        }
        var tools = new HashSet<string>(StringComparer.Ordinal);
        var toolMatchers = new List<Regex>();
        if (policy.TryGetProperty("whitelistedTools", out var toolsElement) &&
            toolsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in toolsElement.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.String)
                {
                    continue;
                }
                var name = entry.GetString()?.Trim();
                if (string.IsNullOrEmpty(name) || name.Length > MaxPatternLength)
                {
                    continue;
                }
                if (name.Contains('*') || name.Contains('?'))
                {
                    try
                    {
                        toolMatchers.Add(new Regex(
                            WildcardToRegexSource(name),
                            RegexOptions.CultureInvariant,
                            MatchTimeout));
                    }
                    catch (ArgumentException error)
                    {
                        WorkerLog.Warn(
                            $"permission policy tool entry skipped entry={name} error={error.Message}");
                    }
                }
                else
                {
                    tools.Add(name);
                }
            }
        }
        return new AgentRuntimePermissionPolicy(
            true,
            tools,
            toolMatchers,
            CompileRules(policy, "bashAllowRules", isDeny: false),
            CompileRules(policy, "bashDenyRules", isDeny: true));
    }

    private static List<CompiledRule> CompileRules(JsonElement policy, string property, bool isDeny)
    {
        var rules = new List<CompiledRule>();
        if (!policy.TryGetProperty(property, out var rulesElement) ||
            rulesElement.ValueKind != JsonValueKind.Array)
        {
            return rules;
        }
        foreach (var entry in rulesElement.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object)
            {
                continue;
            }
            if (!JsonHelpers.GetBool(entry, "enabled", true))
            {
                continue;
            }
            var pattern = JsonHelpers.GetString(entry, "pattern");
            if (string.IsNullOrWhiteSpace(pattern) || pattern.Length > MaxPatternLength)
            {
                continue;
            }
            var isWildcard = JsonHelpers.GetString(entry, "mode") != "regex";
            // Allow regex rules must describe the whole command; deny regex rules hit on any
            // substring. Wildcard rules are always anchored by translation.
            var source = isWildcard
                ? WildcardToRegexSource(pattern)
                : isDeny
                    ? pattern
                    : $"^(?:{pattern})$";
            try
            {
                rules.Add(new CompiledRule(
                    new Regex(
                        source,
                        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Singleline,
                        MatchTimeout),
                    pattern,
                    isWildcard));
            }
            catch (ArgumentException error)
            {
                WorkerLog.Warn(
                    $"permission policy rule skipped list={property} pattern={pattern} error={error.Message}");
            }
        }
        return rules;
    }
}
