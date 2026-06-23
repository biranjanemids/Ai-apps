namespace Ltsc.Server.Registry;

/// <summary>
/// Energy / carbon-aware scheduling (futuristic use case). Defers deferrable work
/// (updates, big installs, imaging) into low-carbon / off-peak windows. This is a
/// deterministic local-time model (green = overnight off-peak window); a real
/// deployment plugs a grid carbon-intensity API behind <see cref="IsGreen"/>.
/// </summary>
public static class CarbonScheduler
{
    public const int DefaultStartHour = 22; // 22:00 local
    public const int DefaultEndHour = 6;    // 06:00 local

    public static bool IsGreen(DateTimeOffset now, int startHour = DefaultStartHour, int endHour = DefaultEndHour)
    {
        var h = now.Hour;
        return startHour <= endHour ? (h >= startHour && h < endHour) : (h >= startHour || h < endHour);
    }

    public static DateTimeOffset NextGreen(DateTimeOffset now, int startHour = DefaultStartHour, int endHour = DefaultEndHour)
    {
        if (IsGreen(now, startHour, endHour)) return now;
        var candidate = new DateTimeOffset(now.Year, now.Month, now.Day, startHour, 0, 0, now.Offset);
        return candidate <= now ? candidate.AddDays(1) : candidate;
    }

    /// <summary>Proxy grid carbon intensity (gCO2/kWh-ish): low in the green window.</summary>
    public static int IntensityProxy(DateTimeOffset now) => IsGreen(now) ? 20 : 70;
}
