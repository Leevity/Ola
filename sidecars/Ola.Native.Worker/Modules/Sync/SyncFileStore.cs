using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class SyncFileStore
{
    private const string FileDomain = "file";
    private const string PromptCacheInstallIdConfigKey = "ola-prompt-cache-install-id";

    // Configuration, channel plugins, prompts, and memory can carry credentials or user-provided
    // secrets. The sync transport intentionally carries only sanitized UI/settings state.
    private static readonly string[] DataFileIncludes = ["settings.json"];
    private static readonly string[] DataDirectoryIncludes = [];
    private static readonly string[] LocalOnlyConfigKeys = [PromptCacheInstallIdConfigKey];

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = true
    };

    private static readonly JsonSerializerOptions StableJsonOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };

    public static async Task<WorkerResponse> CaptureAsync(JsonElement parameters)
    {
        try
        {
            var records = await CaptureRecordsAsync();
            return ToResponse(new JsonObject
            {
                ["success"] = true,
                ["records"] = new JsonArray(records.Select(record => (JsonNode?)record).ToArray())
            });
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"sync file capture failed error={ex.GetType().Name}: {ex.Message}");
            return ToResponse(Mutation(false, 0, false, ex.Message));
        }
    }

    public static async Task<WorkerResponse> ApplyAsync(JsonElement parameters)
    {
        var changed = 0;
        var settingsChanged = false;

        try
        {
            foreach (var record in ReadRecords(parameters))
            {
                if (!string.Equals(ReadString(record, "domain"), FileDomain, StringComparison.Ordinal))
                {
                    continue;
                }

                if (record["value"] is not JsonObject)
                {
                    throw new InvalidOperationException(
                        $"Invalid file sync record: {ReadString(record, "recordId") ?? "<unknown>"}");
                }

                var relativePath = ReadRecordRelativePath(record);
                if (!ShouldIncludeDataRelativePath(relativePath))
                {
                    throw new InvalidOperationException($"Refusing to write unsupported sync file: {relativePath}");
                }

                await ApplyRecordAsync(record, relativePath);
                changed += 1;
                settingsChanged = settingsChanged || string.Equals(relativePath, "settings.json", StringComparison.Ordinal);
            }

            WorkerLog.Debug($"sync files apply changed={changed} settingsChanged={settingsChanged}");
            return ToResponse(Mutation(true, changed, settingsChanged, null));
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"sync files apply failed error={ex.GetType().Name}: {ex.Message}");
            return ToResponse(Mutation(false, changed, settingsChanged, ex.Message));
        }
    }

    public static Task<WorkerResponse> DeleteAsync(JsonElement parameters)
    {
        var changed = 0;
        var settingsChanged = false;

        try
        {
            foreach (var recordId in ReadRecordIds(parameters))
            {
                var relativePath = NormalizeRelativePath(recordId);
                if (!ShouldIncludeDataRelativePath(relativePath))
                {
                    continue;
                }

                if (string.Equals(relativePath, "plugins.json", StringComparison.Ordinal))
                {
                    ChannelConfigStore.ReplacePluginsFromSync([]);
                    changed += 1;
                    continue;
                }

                if (string.Equals(relativePath, "config.json", StringComparison.Ordinal))
                {
                    var localOnlyRoot = BuildLocalOnlyConfigRoot();
                    if (localOnlyRoot.Count > 0)
                    {
                        ConfigStore.ReplaceRootFromSync(localOnlyRoot);
                    }
                    else if (ResolveDataRelativePath(relativePath) is { } configPath &&
                        File.Exists(configPath))
                    {
                        File.Delete(configPath);
                    }
                    changed += 1;
                    continue;
                }

                var targetPath = ResolveDataRelativePath(relativePath);
                if (targetPath is null || !File.Exists(targetPath))
                {
                    continue;
                }

                File.Delete(targetPath);
                changed += 1;
                settingsChanged = settingsChanged ||
                    string.Equals(relativePath, "settings.json", StringComparison.Ordinal);
            }

            WorkerLog.Debug($"sync files delete changed={changed} settingsChanged={settingsChanged}");
            return Task.FromResult(ToResponse(Mutation(true, changed, settingsChanged, null)));
        }
        catch (Exception ex)
        {
            WorkerLog.Warn($"sync files delete failed error={ex.GetType().Name}: {ex.Message}");
            return Task.FromResult(ToResponse(Mutation(false, changed, settingsChanged, ex.Message)));
        }
    }

    private static async Task<List<JsonObject>> CaptureRecordsAsync()
    {
        var dataDir = GetDataDir();
        var candidates = DataFileIncludes
            .Select(fileName => Path.Combine(dataDir, fileName))
            .Concat(DataDirectoryIncludes.Select(dirName => Path.Combine(dataDir, dirName)));
        var filePaths = candidates.SelectMany(WalkFiles).Distinct(StringComparer.Ordinal).ToArray();
        var records = new List<JsonObject>();

        foreach (var filePath in filePaths)
        {
            var relativePath = GetDataRelativePath(filePath);
            if (relativePath is null || !ShouldIncludeDataRelativePath(relativePath))
            {
                continue;
            }

            var data = Convert.ToBase64String(await ReadFileBytesForSyncAsync(relativePath, filePath));
            var value = new JsonObject
            {
                ["path"] = relativePath,
                ["data"] = data
            };
            var updatedAt = (long)Math.Floor(
                (File.GetLastWriteTimeUtc(filePath) - DateTime.UnixEpoch).TotalMilliseconds);

            records.Add(new JsonObject
            {
                ["domain"] = FileDomain,
                ["recordId"] = relativePath,
                ["hash"] = HashValue(value),
                ["value"] = value.DeepClone(),
                ["updatedAt"] = updatedAt
            });
        }

        WorkerLog.Debug($"sync file capture records={records.Count}");
        return records;
    }

    private static async Task ApplyRecordAsync(JsonObject record, string relativePath)
    {
        var targetPath = ResolveDataRelativePath(relativePath);
        if (targetPath is null)
        {
            throw new InvalidOperationException($"Invalid sync file path: {relativePath}");
        }

        var data = ReadRecordData(record);
        var buffer = string.IsNullOrEmpty(data) ? Array.Empty<byte>() : Convert.FromBase64String(data);

        if (string.Equals(relativePath, "settings.json", StringComparison.Ordinal))
        {
            if (JsonNode.Parse(Encoding.UTF8.GetString(buffer)) is not JsonObject settingsRoot)
            {
                throw new InvalidOperationException("Invalid settings sync file");
            }

            RemoveSensitiveValues(settingsRoot);
            PreserveLocalSensitiveValues(settingsRoot, SettingsStore.ReadRootSnapshot());
            SettingsStore.ReplaceRootFromSync(settingsRoot);
            return;
        }

        if (string.Equals(relativePath, "config.json", StringComparison.Ordinal))
        {
            if (JsonNode.Parse(Encoding.UTF8.GetString(buffer)) is not JsonObject configRoot)
            {
                throw new InvalidOperationException("Invalid config sync file");
            }

            PreserveLocalConfigValues(configRoot);
            ConfigStore.ReplaceRootFromSync(configRoot);
            return;
        }

        if (string.Equals(relativePath, "plugins.json", StringComparison.Ordinal))
        {
            if (JsonNode.Parse(Encoding.UTF8.GetString(buffer)) is not JsonArray plugins)
            {
                throw new InvalidOperationException("Invalid channel plugin sync file");
            }

            ChannelConfigStore.ReplacePluginsFromSync(plugins);
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
        var tempPath = $"{targetPath}.{Guid.NewGuid():N}.tmp";
        await File.WriteAllBytesAsync(tempPath, buffer);
        File.Move(tempPath, targetPath, true);
    }

    private static async Task<byte[]> ReadFileBytesForSyncAsync(string relativePath, string filePath)
    {
        var bytes = await File.ReadAllBytesAsync(filePath);
        if (!string.Equals(relativePath, "settings.json", StringComparison.Ordinal))
        {
            return bytes;
        }

        if (JsonNode.Parse(Encoding.UTF8.GetString(bytes)) is not JsonObject settingsRoot)
        {
            throw new InvalidOperationException("Invalid settings sync file");
        }

        RemoveSensitiveValues(settingsRoot);
        return Encoding.UTF8.GetBytes(settingsRoot.ToJsonString(JsonOptions));
    }

    private static void PreserveLocalConfigValues(JsonObject nextConfig)
    {
        var localConfig = ConfigStore.ReadRootSnapshot();
        PreserveLocalSyncDeviceId(nextConfig, localConfig);

        RemoveLocalOnlyConfigValues(nextConfig);
        CopyLocalOnlyConfigValues(localConfig, nextConfig);
    }

    private static void PreserveLocalSyncDeviceId(JsonObject nextConfig, JsonObject localConfig)
    {
        if (nextConfig["sync"] is not JsonObject nextSync)
        {
            return;
        }

        var localDeviceId = ReadNodeString(localConfig["sync"] as JsonObject, "deviceId");
        nextSync["deviceId"] = string.IsNullOrWhiteSpace(localDeviceId)
            ? Guid.NewGuid().ToString()
            : localDeviceId;
    }

    private static JsonObject BuildLocalOnlyConfigRoot()
    {
        var root = new JsonObject();
        CopyLocalOnlyConfigValues(ConfigStore.ReadRootSnapshot(), root);
        return root;
    }

    private static void RemoveLocalOnlyConfigValues(JsonObject config)
    {
        foreach (var key in LocalOnlyConfigKeys)
        {
            config.Remove(key);
        }
    }

    private static void CopyLocalOnlyConfigValues(JsonObject source, JsonObject target)
    {
        foreach (var key in LocalOnlyConfigKeys)
        {
            if (source.TryGetPropertyValue(key, out var value) && value is not null)
            {
                target[key] = value.DeepClone();
            }
        }
    }

    private static void RemoveSensitiveValues(JsonNode node)
    {
        if (node is JsonObject obj)
        {
            foreach (var property in obj.ToList())
            {
                if (IsSensitivePropertyName(property.Key))
                {
                    obj.Remove(property.Key);
                    continue;
                }

                if (property.Value is not null)
                {
                    RemoveSensitiveValues(property.Value);
                }
            }
            return;
        }

        if (node is JsonArray array)
        {
            foreach (var item in array)
            {
                if (item is not null)
                {
                    RemoveSensitiveValues(item);
                }
            }
        }
    }

    private static bool IsSensitivePropertyName(string propertyName)
    {
        return propertyName.ToLowerInvariant() switch
        {
            "apikey" or "api_key" or "password" or "passphrase" or "secret" or
            "clientsecret" or "client_secret" or "token" or "accesstoken" or
            "access_token" or "refreshtoken" or "refresh_token" or "bearertoken" or
            "bearer_token" or "sessiontoken" or "session_token" or "idtoken" or
            "id_token" or "authorization" or
            "privatekey" or "private_key" or "credentials" or "encryptedpassword" or
            "encrypted_password" or "webdavpassword" or "webdav_password" => true,
            _ => false
        };
    }

    private static void PreserveLocalSensitiveValues(JsonNode next, JsonNode local)
    {
        if (next is JsonObject nextObject && local is JsonObject localObject)
        {
            foreach (var property in localObject)
            {
                if (IsSensitivePropertyName(property.Key))
                {
                    nextObject[property.Key] = property.Value?.DeepClone();
                    continue;
                }

                if (property.Value is not null &&
                    nextObject[property.Key] is { } nextValue)
                {
                    PreserveLocalSensitiveValues(nextValue, property.Value);
                }
            }
            return;
        }

        if (next is JsonArray nextArray && local is JsonArray localArray)
        {
            var length = Math.Min(nextArray.Count, localArray.Count);
            for (var index = 0; index < length; index += 1)
            {
                if (nextArray[index] is { } nextItem && localArray[index] is { } localItem)
                {
                    PreserveLocalSensitiveValues(nextItem, localItem);
                }
            }
        }
    }

    private static IEnumerable<string> WalkFiles(string rootPath)
    {
        if (File.Exists(rootPath))
        {
            yield return rootPath;
            yield break;
        }

        if (!Directory.Exists(rootPath))
        {
            yield break;
        }

        foreach (var entry in Directory.EnumerateFileSystemEntries(rootPath))
        {
            var attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0)
            {
                continue;
            }

            if ((attributes & FileAttributes.Directory) != 0)
            {
                foreach (var child in WalkFiles(entry))
                {
                    yield return child;
                }
            }
            else
            {
                yield return entry;
            }
        }
    }

    private static IEnumerable<JsonObject> ReadRecords(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("records", out var recordsElement) ||
            recordsElement.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var recordElement in recordsElement.EnumerateArray())
        {
            if (CloneElement(recordElement) is JsonObject record)
            {
                yield return record;
            }
        }
    }

    private static IEnumerable<string> ReadRecordIds(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object ||
            !parameters.TryGetProperty("recordIds", out var idsElement) ||
            idsElement.ValueKind != JsonValueKind.Array)
        {
            yield break;
        }

        foreach (var idElement in idsElement.EnumerateArray())
        {
            if (idElement.ValueKind == JsonValueKind.String &&
                idElement.GetString() is { Length: > 0 } id)
            {
                yield return id;
            }
        }
    }

    private static string ReadRecordRelativePath(JsonObject record)
    {
        var recordId = ReadString(record, "recordId") ?? string.Empty;
        if (record["value"] is JsonObject value &&
            ReadNodeString(value, "path") is { Length: > 0 } path)
        {
            return NormalizeRelativePath(path);
        }

        return NormalizeRelativePath(recordId);
    }

    private static string ReadRecordData(JsonObject record)
    {
        return record["value"] is JsonObject value
            ? ReadNodeString(value, "data") ?? string.Empty
            : string.Empty;
    }

    private static string? GetDataRelativePath(string filePath)
    {
        var relativePath = Path.GetRelativePath(GetDataDir(), filePath);
        if (string.IsNullOrEmpty(relativePath) ||
            relativePath.StartsWith("..", StringComparison.Ordinal) ||
            Path.IsPathRooted(relativePath))
        {
            return null;
        }

        return NormalizeRelativePath(relativePath);
    }

    private static string? ResolveDataRelativePath(string relativePath)
    {
        if (Path.IsPathRooted(relativePath))
        {
            return null;
        }

        var normalized = NormalizeRelativePath(relativePath);
        if (string.IsNullOrEmpty(normalized) ||
            normalized.StartsWith("/", StringComparison.Ordinal) ||
            normalized.Split('/').Any(part => part == ".."))
        {
            return null;
        }

        return Path.Combine(new[] { GetDataDir() }.Concat(normalized.Split('/')).ToArray());
    }

    private static bool ShouldIncludeDataRelativePath(string relativePath)
    {
        var normalized = NormalizeRelativePath(relativePath);
        if (DataFileIncludes.Contains(normalized, StringComparer.Ordinal))
        {
            return true;
        }

        return DataDirectoryIncludes.Any(dir =>
            string.Equals(normalized, dir, StringComparison.Ordinal) ||
            normalized.StartsWith($"{dir}/", StringComparison.Ordinal));
    }

    private static string NormalizeRelativePath(string relativePath)
    {
        return relativePath.Replace('\\', '/');
    }

    private static string GetDataDir()
    {
        return OlaDataRoot.DirectoryPath;
    }

    private static string HashValue(JsonNode? value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(StableStringify(value)));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static string StableStringify(JsonNode? value)
    {
        if (value is null)
        {
            return "null";
        }

        if (value is JsonArray array)
        {
            return $"[{string.Join(",", array.Select(StableStringify))}]";
        }

        if (value is JsonObject obj)
        {
            return "{" + string.Join(
                ",",
                obj.OrderBy(property => property.Key, StringComparer.Ordinal)
                    .Select(property => $"{QuoteString(property.Key)}:{StableStringify(property.Value)}")) + "}";
        }

        return value.ToJsonString(StableJsonOptions);
    }

    private static string QuoteString(string value)
    {
        using var stream = new MemoryStream();
        using var writer = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        });
        writer.WriteStringValue(value);
        writer.Flush();
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static JsonNode? CloneElement(JsonElement element)
    {
        return JsonNode.Parse(element.GetRawText());
    }

    private static string? ReadString(JsonObject obj, string name)
    {
        return ReadNodeString(obj, name);
    }

    private static string? ReadNodeString(JsonObject? obj, string name)
    {
        return obj is not null &&
            obj.TryGetPropertyValue(name, out var value) &&
            value is JsonValue jsonValue &&
            jsonValue.TryGetValue<string>(out var text)
                ? text
                : null;
    }

    private static JsonObject Mutation(bool success, int changed, bool settingsChanged, string? error)
    {
        var result = new JsonObject
        {
            ["success"] = success,
            ["changed"] = changed,
            ["settingsChanged"] = settingsChanged
        };
        if (!string.IsNullOrWhiteSpace(error))
        {
            result["error"] = error;
        }
        return result;
    }

    private static WorkerResponse ToResponse(JsonNode node)
    {
        return WorkerResponse.RawJson(node.ToJsonString(JsonOptions));
    }
}
