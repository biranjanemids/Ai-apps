using Ltsc.Server.Registry;

namespace Ltsc.Server.Services;

/// <summary>
/// Batches write-behind device state to the durable store. Heartbeats at fleet
/// scale would otherwise issue one synchronous write each, serialising the whole
/// control plane behind the store lock; instead they mark the record dirty and
/// this flushes them on an interval, and once more on shutdown so nothing is lost
/// on a clean stop.
/// </summary>
public sealed class DeviceStateFlusher : BackgroundService
{
    private readonly DeviceRegistry _devices;
    private readonly TimeSpan _interval;
    private readonly ILogger<DeviceStateFlusher> _log;

    public DeviceStateFlusher(DeviceRegistry devices, IConfiguration config, ILogger<DeviceStateFlusher> log)
    {
        _devices = devices;
        _interval = TimeSpan.FromSeconds(Math.Max(1, config.GetValue("Ltsc:FlushSeconds", 5)));
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(_interval, stoppingToken); }
            catch (OperationCanceledException) { break; }

            try
            {
                var n = _devices.FlushDirty();
                if (n > 0) _log.LogDebug("Flushed {Count} device state rows", n);
            }
            catch (Exception ex) { _log.LogWarning(ex, "Device state flush failed"); }
        }

        try { _devices.FlushDirty(); } catch { /* best effort on shutdown */ }
    }
}
