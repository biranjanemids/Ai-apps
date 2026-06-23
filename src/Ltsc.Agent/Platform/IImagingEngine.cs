using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Platform;

/// <summary>
/// OS imaging / bare-metal recovery (design §11). Windows production uses DISM
/// FFU/WIM (`/Capture-FFU`, `/Apply-FFU`) from a WinPE recovery context; this
/// cross-platform default simulates capture (writes a small artifact) and apply
/// (logs) so the BMR state machine is runnable and testable off Windows.
/// </summary>
public interface IImagingEngine
{
    /// <summary>Captures the disk to a local image file; returns its path.</summary>
    Task<string> CaptureAsync(string format, string targetDrive, CancellationToken ct);

    /// <summary>Applies a downloaded image to the disk (wipe per policy).</summary>
    Task<bool> ApplyAsync(string imagePath, string format, string wipePolicy, CancellationToken ct);

    /// <summary>This device's hardware model, for image compatibility gating.</summary>
    string Model { get; }
}

public sealed class DefaultImagingEngine : IImagingEngine
{
    private readonly ILogger<DefaultImagingEngine> _log;
    public DefaultImagingEngine(ILogger<DefaultImagingEngine> log) => _log = log;

    public string Model => "GenericThinClient";

    public async Task<string> CaptureAsync(string format, string targetDrive, CancellationToken ct)
    {
        var dir = Path.Combine(Path.GetTempPath(), "ltsc-images");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, $"capture-{DateTime.UtcNow:yyyyMMddHHmmss}.{format}");
        // Simulated image payload; production runs DISM /Capture-FFU.
        await File.WriteAllBytesAsync(path, System.Text.Encoding.UTF8.GetBytes($"FFU-STUB model={Model} fmt={format}"), ct);
        _log.LogInformation("[stub] captured {Format} image -> {Path}", format, path);
        return path;
    }

    public Task<bool> ApplyAsync(string imagePath, string format, string wipePolicy, CancellationToken ct)
    {
        _log.LogWarning("[stub] applying {Format} image {Path} (wipe={Wipe}) — DISM /Apply-FFU on Windows", format, imagePath, wipePolicy);
        return Task.FromResult(true);
    }
}
