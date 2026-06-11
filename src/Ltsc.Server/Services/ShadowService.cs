using System.Collections.Concurrent;
using Grpc.Core;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Ca;
using Ltsc.Server.Registry;

namespace Ltsc.Server.Services;

/// <summary>Latest shadow frame + session status per device (design §10).</summary>
public sealed class ShadowStore
{
    public sealed record Session(string SessionId, int Width, int Height, string Mime, long LastSeq, int Frames, DateTimeOffset StartedUtc, bool Active);

    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    public void Update(string deviceId, Session s) => _sessions[deviceId] = s;
    public Session? Get(string deviceId) => _sessions.TryGetValue(deviceId, out var s) ? s : null;
}

/// <summary>
/// Receives a device's shadow framebuffer stream (design §10), mTLS only. Stores
/// the latest frame/status for the console and audits the session lifecycle.
/// Could stream back a stop control; here it lets the agent finish its budget.
/// </summary>
public sealed class ShadowService : Shadow.ShadowBase
{
    private readonly ShadowStore _store;
    private readonly ServerStore _audit;
    private readonly CertAuthority _ca;
    private readonly ILogger<ShadowService> _log;

    public ShadowService(ShadowStore store, ServerStore audit, CertAuthority ca, ILogger<ShadowService> log)
    {
        _store = store;
        _audit = audit;
        _ca = ca;
        _log = log;
    }

    public override async Task Stream(
        IAsyncStreamReader<ShadowFrame> requestStream,
        IServerStreamWriter<ShadowControl> responseStream,
        ServerCallContext context)
    {
        DeviceAuth.RequireDeviceCertificate(context, _ca);

        string device = "", session = "";
        var frames = 0;
        var start = DateTimeOffset.UtcNow;
        await foreach (var f in requestStream.ReadAllAsync(context.CancellationToken))
        {
            device = f.DeviceId;
            session = f.SessionId;
            frames++;
            _store.Update(device, new ShadowStore.Session(session, f.Width, f.Height, f.Mime, f.Seq, frames, start, Active: !f.Last));
        }

        if (device.Length > 0)
        {
            _store.Update(device, _store.Get(device)! with { Active = false });
            _audit.AddAudit($"device:{device}", "shadow:session", device, $"session {session}, {frames} frame(s)");
            _log.LogInformation("[{Device}] shadow session {Session} ended: {Frames} frame(s)", device, session, frames);
        }
    }
}
