using System.Runtime.InteropServices;
using Google.Protobuf.WellKnownTypes;
using Ltsc.Mgmt.V1;

namespace Ltsc.Agent.Platform;

/// <summary>Collects hardware + software asset inventory (design §10).</summary>
public interface IInventoryCollector
{
    InventoryReport Collect(bool uwfEnabled);
}

/// <summary>
/// Cross-platform inventory using the BCL (works on Linux/macOS/Windows). The
/// Windows build can enrich `apps` from the registry uninstall keys; the base
/// fields here are genuinely accurate on every platform.
/// </summary>
public class DefaultInventoryCollector : IInventoryCollector
{
    public virtual InventoryReport Collect(bool uwfEnabled)
    {
        var sysDrive = DriveInfo.GetDrives().FirstOrDefault(d => d.IsReady && d.DriveType == DriveType.Fixed);
        var report = new InventoryReport
        {
            Hostname = Environment.MachineName,
            OsBuild = RuntimeInformation.OSDescription,
            Arch = RuntimeInformation.OSArchitecture.ToString(),
            CpuCount = Environment.ProcessorCount,
            TotalMemoryBytes = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes,
            FreeDiskBytes = sysDrive?.AvailableFreeSpace ?? 0,
            TotalDiskBytes = sysDrive?.TotalSize ?? 0,
            UptimeSeconds = Environment.TickCount64 / 1000,
            AgentVersion = "0.1.0",
            UwfEnabled = uwfEnabled,
            CollectedAt = Timestamp.FromDateTimeOffset(DateTimeOffset.UtcNow),
        };
        return report;
    }
}
