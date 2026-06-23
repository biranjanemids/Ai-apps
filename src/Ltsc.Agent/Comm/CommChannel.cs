using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Threading.Channels;
using Google.Protobuf;
using Grpc.Core;
using Grpc.Net.Client;
using Ltsc.Agent.Platform;
using Ltsc.Agent.Storage;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging;

namespace Ltsc.Agent.Comm;

/// <summary>
/// gRPC link to the MgmtServer (design §4.2, §5, §6): CSR-based enrollment that
/// yields a CA-signed device certificate, an mTLS channel that presents it and
/// pins the CA for server validation, the long-lived DeviceLink stream with an
/// offline outbox, and verified artifact downloads.
///
/// Identity storage: the device key+cert persist as PFX in LocalStore. On
/// Windows production hardware the key belongs in TPM/CNG (design §6) — this
/// file-based storage is the cross-platform fallback.
/// </summary>
public sealed class CommChannel : IAsyncDisposable, IArtifactFetcher, IArtifactUploader, IShadowUplink
{
    private readonly string _serverAddress;
    private readonly LocalStore _store;
    private readonly ILogger<CommChannel> _log;
    private readonly Channel<AgentMessage> _outbox =
        Channel.CreateUnbounded<AgentMessage>(new UnboundedChannelOptions { SingleReader = true });

    private GrpcChannel? _channel;
    private X509Certificate2? _clientCert;

    public string DeviceId { get; private set; } = "";
    public X509Certificate2? CaCertificate { get; private set; }
    public Func<CommandEnvelope, Task>? OnCommand { get; set; }
    public Func<string, Task>? OnSyncPolicy { get; set; }   // arg = server's expected policy version
    public Func<string, string, byte[], Task>? OnAgentRelease { get; set; } // version, artifactId, sha256

    public CommChannel(string serverAddress, LocalStore store, ILogger<CommChannel> log)
    {
        _serverAddress = serverAddress;
        _store = store;
        _log = log;
        LoadIdentity();
    }

    private void LoadIdentity()
    {
        DeviceId = _store.GetIdentity("device_id") ?? "";
        var pfx = _store.GetIdentity("device_pfx");
        if (pfx is not null)
            _clientCert = new X509Certificate2(Convert.FromBase64String(pfx), (string?)null,
                X509KeyStorageFlags.Exportable | X509KeyStorageFlags.EphemeralKeySet);
        var caDer = _store.GetIdentity("ca_cert");
        if (caDer is not null)
            CaCertificate = new X509Certificate2(Convert.FromBase64String(caDer));
    }

    /// <summary>
    /// (Re)builds the channel for the current identity. Before enrollment there
    /// is no client cert and server trust is TOFU; after enrollment the device
    /// cert is presented and the server must chain to the pinned CA.
    /// </summary>
    private GrpcChannel BuildChannel()
    {
        var ssl = new SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = (_, cert, _, _) =>
            {
                if (CaCertificate is null) return true; // bootstrap TOFU (enrollment only)
                if (cert is null) return false;
                using var chain = new X509Chain();
                chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
                chain.ChainPolicy.CustomTrustStore.Add(CaCertificate);
                chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                return chain.Build(new X509Certificate2(cert));
            },
        };
        if (_clientCert is not null)
            ssl.ClientCertificates = new X509Certificate2Collection(_clientCert);

        var handler = new SocketsHttpHandler
        {
            SslOptions = ssl,
            KeepAlivePingDelay = TimeSpan.FromSeconds(30),
            KeepAlivePingTimeout = TimeSpan.FromSeconds(10),
        };
        return GrpcChannel.ForAddress(_serverAddress, new GrpcChannelOptions { HttpHandler = handler });
    }

    private GrpcChannel Rpc => _channel ??= BuildChannel();

    private void ResetChannel()
    {
        _channel?.Dispose();
        _channel = null;
    }

    public async Task EnsureEnrolledAsync(string enrollmentToken, DeviceFacts facts, CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(DeviceId) && _clientCert is not null)
        {
            _log.LogInformation("Already enrolled as {DeviceId} (cert {Thumb}, expires {NotAfter:u})",
                DeviceId, _clientCert.Thumbprint, _clientCert.NotAfter);
            return;
        }

        // Fresh keypair + PKCS#10 CSR; the CA signs it into our device cert.
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var req = new CertificateRequest($"CN={facts.HardwareUuid}", key, HashAlgorithmName.SHA256);
        var csr = req.CreateSigningRequest();

        var client = new Enrollment.EnrollmentClient(Rpc);
        var resp = await client.EnrollAsync(new EnrollRequest
        {
            EnrollmentToken = enrollmentToken,
            Csr = ByteString.CopyFrom(csr),
            Facts = facts,
        }, cancellationToken: ct);

        using var pub = new X509Certificate2(resp.DeviceCertificate.ToByteArray());
        using var withKey = pub.CopyWithPrivateKey(key);
        var pfx = withKey.Export(X509ContentType.Pfx);

        DeviceId = resp.DeviceId;
        _store.SetIdentity("device_id", resp.DeviceId);
        _store.SetIdentity("group_id", resp.GroupId);
        _store.SetIdentity("device_pfx", Convert.ToBase64String(pfx));
        _store.SetIdentity("ca_cert", Convert.ToBase64String(resp.CaChain.ToByteArray()));
        LoadIdentity();
        ResetChannel(); // reconnect WITH the client certificate

        _log.LogInformation("Enrolled as {DeviceId} in {Group}; device cert valid to {NotAfter:u}, CA pinned",
            resp.DeviceId, resp.GroupId, resp.NotAfter.ToDateTimeOffset());
    }

    /// <summary>Enqueue a message for the server (buffered when offline).</summary>
    public ValueTask SendAsync(AgentMessage msg) => _outbox.Writer.WriteAsync(msg);

    /// <summary>Pull the effective desired-state policy snapshot for this device (design §7).</summary>
    public async Task<PolicySnapshot> PullPolicyAsync(CancellationToken ct)
    {
        var client = new PolicyService.PolicyServiceClient(Rpc);
        return await client.GetPolicyAsync(new GetPolicyRequest { DeviceId = DeviceId }, cancellationToken: ct);
    }

    /// <summary>
    /// Downloads an artifact via the chunked Transfer service, verifying each
    /// chunk hash and the whole-artifact SHA-256 before handing the path to the
    /// caller (design §5, §8.6). Throws InvalidDataException on any mismatch.
    /// </summary>
    public async Task<string> FetchAsync(string artifactId, byte[] expectedSha256, CancellationToken ct)
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "artifacts");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, artifactId);

        var client = new Transfer.TransferClient(Rpc);
        using var call = client.Download(new DownloadRequest { ArtifactId = artifactId, Offset = 0 }, cancellationToken: ct);

        await using (var file = File.Create(path))
        {
            await foreach (var chunk in call.ResponseStream.ReadAllAsync(ct))
            {
                var data = chunk.Data.ToByteArray();
                if (!SHA256.HashData(data).AsSpan().SequenceEqual(chunk.Sha256.ToByteArray()))
                    throw new InvalidDataException($"artifact {artifactId}: chunk hash mismatch at offset {chunk.Offset}");
                await file.WriteAsync(data, ct);
            }
        }

        if (expectedSha256.Length > 0)
        {
            await using var verify = File.OpenRead(path);
            var actual = await SHA256.HashDataAsync(verify, ct);
            if (!actual.AsSpan().SequenceEqual(expectedSha256))
            {
                File.Delete(path);
                throw new InvalidDataException($"artifact {artifactId}: SHA-256 mismatch; refusing to install");
            }
        }

        _log.LogInformation("Artifact {Id} downloaded and verified ({Bytes} bytes)", artifactId, new FileInfo(path).Length);
        return path;
    }

    /// <summary>Uploads a local file via the chunked Transfer service (design §5, §11).</summary>
    public async Task<string> UploadAsync(string path, CancellationToken ct)
    {
        var client = new Transfer.TransferClient(Rpc);
        using var call = client.Upload(cancellationToken: ct);
        var transferId = Guid.NewGuid().ToString("n");
        await using (var file = File.OpenRead(path))
        {
            var buffer = new byte[64 * 1024];
            long offset = 0;
            int read;
            while ((read = await file.ReadAsync(buffer, ct)) > 0)
            {
                var slice = buffer.AsSpan(0, read).ToArray();
                await call.RequestStream.WriteAsync(new Chunk
                {
                    TransferId = transferId,
                    Offset = offset,
                    Data = ByteString.CopyFrom(slice),
                    Sha256 = ByteString.CopyFrom(SHA256.HashData(slice)),
                    Last = file.Position >= file.Length,
                }, ct);
                offset += read;
            }
        }
        await call.RequestStream.CompleteAsync();
        var result = await call.ResponseAsync;
        _log.LogInformation("Uploaded {Path} ({Bytes} bytes) as {Id}", path, result.TotalBytes, result.ArtifactId);
        return result.ArtifactId;
    }

    /// <summary>Streams captured frames over the Shadow service until budget/stop (design §10).</summary>
    public async Task<int> RunAsync(IScreenCapturer capturer, string sessionId, int maxFrames, int fps, CancellationToken ct)
    {
        var client = new Shadow.ShadowClient(Rpc);
        using var call = client.Stream(cancellationToken: ct);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);

        // Watch for a server stop control.
        var watcher = Task.Run(async () =>
        {
            try
            {
                await foreach (var c in call.ResponseStream.ReadAllAsync(stop.Token))
                    if (c.Stop) { stop.Cancel(); break; }
            }
            catch (OperationCanceledException) { }
        }, stop.Token);

        var sent = 0;
        var delay = TimeSpan.FromMilliseconds(1000.0 / Math.Max(fps, 1));
        for (var seq = 0; seq < maxFrames && !stop.IsCancellationRequested; seq++)
        {
            var f = capturer.Capture(seq);
            await call.RequestStream.WriteAsync(new ShadowFrame
            {
                DeviceId = DeviceId,
                SessionId = sessionId,
                Seq = seq,
                Width = f.Width,
                Height = f.Height,
                Mime = f.Mime,
                Data = ByteString.CopyFrom(f.Data),
                Last = seq == maxFrames - 1,
            }, ct);
            sent++;
            try { await Task.Delay(delay, stop.Token); } catch (OperationCanceledException) { break; }
        }
        await call.RequestStream.CompleteAsync();
        stop.Cancel();
        await watcher;
        _log.LogInformation("Shadow session {Session} sent {Frames} frame(s)", sessionId, sent);
        return sent;
    }

    /// <summary>
    /// Open the bidi stream and pump both directions until cancelled/faulted.
    /// The caller wraps this in a reconnect-with-backoff loop.
    /// </summary>
    public async Task RunStreamAsync(CancellationToken ct)
    {
        var client = new DeviceLink.DeviceLinkClient(Rpc);
        using var call = client.Connect(cancellationToken: ct);

        // Stops the outbound pump when the inbound stream ends, without
        // completing the shared outbox (it must survive across reconnects).
        using var link = CancellationTokenSource.CreateLinkedTokenSource(ct);

        // Identify the device on the first frame.
        await call.RequestStream.WriteAsync(new AgentMessage { DeviceId = DeviceId });

        var writer = Task.Run(async () =>
        {
            try
            {
                await foreach (var msg in _outbox.Reader.ReadAllAsync(link.Token))
                {
                    msg.DeviceId = DeviceId;
                    await call.RequestStream.WriteAsync(msg);
                }
            }
            catch (OperationCanceledException) { /* stream ended; messages stay buffered */ }
        }, link.Token);

        try
        {
            await foreach (var server in call.ResponseStream.ReadAllAsync(ct))
            {
                switch (server.PayloadCase)
                {
                    case ServerMessage.PayloadOneofCase.Hello:
                        _log.LogInformation("ServerHello: heartbeat every {N}s", server.Hello.HeartbeatIntervalSeconds);
                        if (OnAgentRelease is not null && !string.IsNullOrEmpty(server.Hello.LatestAgentVersion))
                            _ = OnAgentRelease(server.Hello.LatestAgentVersion, server.Hello.AgentArtifactId, server.Hello.AgentSha256.ToByteArray());
                        break;
                    case ServerMessage.PayloadOneofCase.Command:
                        if (OnCommand is not null) _ = OnCommand(server.Command);
                        break;
                    case ServerMessage.PayloadOneofCase.Sync:
                        if (OnSyncPolicy is not null) _ = OnSyncPolicy(server.Sync.ExpectedPolicyVersion);
                        break;
                }
            }
        }
        finally
        {
            link.Cancel();
            await writer;
        }
    }

    public async ValueTask DisposeAsync()
    {
        _outbox.Writer.TryComplete();
        if (_channel is not null) await _channel.ShutdownAsync();
    }
}
