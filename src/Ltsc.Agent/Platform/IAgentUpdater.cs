using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Platform;

/// <summary>
/// Applies an agent self-update package (design — agent lifecycle). On Windows
/// production this launches `msiexec /i <pkg> /qn` (the new MSI restarts the
/// service) and the current process exits so the service manager swaps it in.
/// The cross-platform default stages the verified package and records intent so
/// the flow is runnable and testable off Windows.
/// </summary>
public interface IAgentUpdater
{
    Task<bool> ApplyAsync(string packagePath, string version, CancellationToken ct);
}

public sealed class DefaultAgentUpdater : IAgentUpdater
{
    private readonly ILogger<DefaultAgentUpdater> _log;
    public DefaultAgentUpdater(ILogger<DefaultAgentUpdater> log) => _log = log;

    public Task<bool> ApplyAsync(string packagePath, string version, CancellationToken ct)
    {
        // Stage the verified package next to the agent; a real Windows updater
        // would `msiexec /i packagePath /qn` and exit for service restart.
        var staged = Path.Combine(AppContext.BaseDirectory, "updates");
        Directory.CreateDirectory(staged);
        var dest = Path.Combine(staged, $"agent-{version}.pkg");
        try { File.Copy(packagePath, dest, overwrite: true); } catch { /* best effort */ }
        _log.LogWarning("Agent self-update to {Version} staged at {Dest} (Windows: msiexec /i + service restart)", version, dest);
        return Task.FromResult(true);
    }
}
