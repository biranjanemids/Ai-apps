#if WINDOWS
using System.Runtime.Versioning;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.DependencyInjection;

namespace Ltsc.Agent.Platform.Windows;

/// <summary>
/// DI registration for the real Windows implementations (design §A4). Only
/// compiled for the net8.0-windows TFM; selected at runtime when the agent is
/// actually running on Windows. These call WMI / registry / system tools and are
/// validated on a Windows device + the windows-latest CI build leg — they are not
/// exercised by the cross-platform Linux build/tests.
/// </summary>
[SupportedOSPlatform("windows")]
public static class WindowsPlatform
{
    public static void Register(IServiceCollection services)
    {
        services.AddSingleton<IWriteFilterGuard, WindowsWriteFilterGuard>();

        services.AddSingleton<ISettingApplier, WindowsRegistryApplier>();
        services.AddSingleton<ISettingApplier, WindowsUwfApplier>();
        services.AddSingleton<ISettingApplier, WindowsKioskApplier>();
        services.AddSingleton<ISettingApplier, WindowsNetworkApplier>();
        services.AddSingleton<ISettingApplier, WindowsPowerApplier>();
        services.AddSingleton<ISettingApplier, WindowsTimeApplier>();
        services.AddSingleton<ISettingApplier, WindowsCertApplier>();
        services.AddSingleton<ISettingApplier, WindowsAppLockerApplier>();
        services.AddSingleton<ISettingApplier, WindowsKeyboardFilterApplier>();
    }
}
#endif
