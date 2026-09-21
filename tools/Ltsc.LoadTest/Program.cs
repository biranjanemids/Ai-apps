using System.Diagnostics;
using System.Net.Security;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Google.Protobuf;
using Grpc.Core;
using Grpc.Net.Client;
using Ltsc.Mgmt.V1;

// Fleet load harness — the scale evidence a buyer asks for first.
//
// Simulates N independent devices doing exactly what a real agent does: generate
// a keypair, enroll with a CSR, reconnect over mTLS with the issued certificate,
// hold an open DeviceLink stream, pull policy, and heartbeat. Reports enrollment
// throughput, concurrent streams sustained, and policy-pull latency percentiles.
//
//   dotnet run --project tools/Ltsc.LoadTest -- --devices 300 --duration 20

var server = Arg("--server") ?? "https://localhost:8443";
var devices = int.Parse(Arg("--devices") ?? "200");
var duration = int.Parse(Arg("--duration") ?? "20");
var token = Arg("--token") ?? "demo-token";
var concurrency = int.Parse(Arg("--concurrency") ?? "50");

Console.WriteLine($"Load test -> {server}  devices={devices} duration={duration}s enrollConcurrency={concurrency}");

var enrollMs = new List<double>();
var enrollDoneAtMs = new List<double>();   // when each enroll finished, relative to start
var policyMs = new List<double>();
var connected = 0;
var enrollFailures = 0;
var streamFailures = 0;
long heartbeats = 0;
var gate = new SemaphoreSlim(concurrency);
var stopAll = new CancellationTokenSource();
var sync = new object();

var swTotal = Stopwatch.StartNew();
var agents = Enumerable.Range(0, devices).Select(i => RunAgent($"LOAD-{i:D5}")).ToArray();

// Let enrollment + connect settle, then hold the fleet open for `duration`.
await Task.Delay(TimeSpan.FromSeconds(duration));
stopAll.Cancel();
try { await Task.WhenAll(agents); } catch { /* cancellation */ }
swTotal.Stop();

Report();
return;

async Task RunAgent(string hwId)
{
    GrpcChannel? channel = null;
    try
    {
        // ---- enroll (CSR -> CA-signed device cert) ----
        await gate.WaitAsync();
        X509Certificate2 clientCert;
        X509Certificate2 caCert;
        try
        {
            var sw = Stopwatch.StartNew();
            using var bootstrap = Channel(null, null);
            var enroll = new Enrollment.EnrollmentClient(bootstrap);
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var csr = new CertificateRequest($"CN={hwId}", key, HashAlgorithmName.SHA256).CreateSigningRequest();

            var resp = await enroll.EnrollAsync(new EnrollRequest
            {
                EnrollmentToken = token,
                Csr = ByteString.CopyFrom(csr),
                Facts = new DeviceFacts { HardwareUuid = hwId, Model = "LoadSim", Arch = "X64", AgentVersion = "0.1.0" },
            });
            sw.Stop();

            using var pub = new X509Certificate2(resp.DeviceCertificate.ToByteArray());
            using var withKey = pub.CopyWithPrivateKey(key);
            clientCert = new X509Certificate2(withKey.Export(X509ContentType.Pfx), (string?)null,
                X509KeyStorageFlags.Exportable | X509KeyStorageFlags.EphemeralKeySet);
            caCert = new X509Certificate2(resp.CaChain.ToByteArray());
            lock (sync) { enrollMs.Add(sw.Elapsed.TotalMilliseconds); enrollDoneAtMs.Add(swTotal.Elapsed.TotalMilliseconds); }
        }
        catch
        {
            Interlocked.Increment(ref enrollFailures);
            return;
        }
        finally { gate.Release(); }

        // ---- reconnect with mTLS and hold the stream ----
        channel = Channel(clientCert, caCert);

        var swPolicy = Stopwatch.StartNew();
        var policy = new PolicyService.PolicyServiceClient(channel);
        await policy.GetPolicyAsync(new GetPolicyRequest { DeviceId = hwId });
        swPolicy.Stop();
        lock (sync) policyMs.Add(swPolicy.Elapsed.TotalMilliseconds);

        var link = new DeviceLink.DeviceLinkClient(channel);
        using var call = link.Connect(cancellationToken: stopAll.Token);
        await call.RequestStream.WriteAsync(new AgentMessage { DeviceId = hwId });
        Interlocked.Increment(ref connected);

        // Drain server messages so the stream stays healthy.
        var reader = Task.Run(async () =>
        {
            try { await foreach (var _ in call.ResponseStream.ReadAllAsync(stopAll.Token)) { } }
            catch { /* closed */ }
        });

        while (!stopAll.IsCancellationRequested)
        {
            await call.RequestStream.WriteAsync(new AgentMessage
            {
                DeviceId = hwId,
                Heartbeat = new Heartbeat
                {
                    AgentVersion = "0.1.0",
                    PolicyVersion = "0",
                    Health = new Health { UwfEnabled = true },
                },
            });
            Interlocked.Increment(ref heartbeats);
            await Task.Delay(5000, stopAll.Token);
        }
        await reader;
    }
    catch (OperationCanceledException) { /* shutting down */ }
    catch { Interlocked.Increment(ref streamFailures); }
    finally { channel?.Dispose(); }
}

GrpcChannel Channel(X509Certificate2? clientCert, X509Certificate2? ca)
{
    var ssl = new SslClientAuthenticationOptions
    {
        RemoteCertificateValidationCallback = (_, cert, _, _) =>
        {
            if (ca is null || cert is null) return true;   // bootstrap enroll: TOFU
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(ca);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            return chain.Build(new X509Certificate2(cert));
        },
    };
    if (clientCert is not null) ssl.ClientCertificates = new X509Certificate2Collection(clientCert);
    return GrpcChannel.ForAddress(server, new GrpcChannelOptions
    {
        HttpHandler = new SocketsHttpHandler { SslOptions = ssl, EnableMultipleHttp2Connections = true },
    });
}

void Report()
{
    static double Pct(List<double> xs, double p)
    {
        if (xs.Count == 0) return 0;
        var s = xs.OrderBy(x => x).ToList();
        return s[Math.Min(s.Count - 1, (int)(p / 100.0 * s.Count))];
    }

    var enrolled = enrollMs.Count;
    // Enrollment window = start .. last enrollment completing (NOT total wall
    // clock, which includes the hold phase) so throughput is the real rate.
    var enrollWindowS = enrollDoneAtMs.Count > 0 ? enrollDoneAtMs.Max() / 1000.0 : 0;
    Console.WriteLine();
    Console.WriteLine("================ RESULTS ================");
    Console.WriteLine($"devices requested      : {devices}");
    Console.WriteLine($"enrolled OK            : {enrolled}  (failures: {enrollFailures})");
    Console.WriteLine($"streams connected      : {connected}  (failures: {streamFailures})");
    Console.WriteLine($"heartbeats sent        : {heartbeats}");
    Console.WriteLine($"enroll p50 / p95 (ms)  : {Pct(enrollMs, 50):F1} / {Pct(enrollMs, 95):F1}");
    Console.WriteLine($"policy pull p50/p95(ms): {Pct(policyMs, 50):F1} / {Pct(policyMs, 95):F1}");
    Console.WriteLine($"enroll window (s)      : {enrollWindowS:F1}   (total wall clock {swTotal.Elapsed.TotalSeconds:F1}s incl. hold)");
    Console.WriteLine($"enrollment throughput  : {(enrollWindowS > 0 ? enrolled / enrollWindowS : 0):F1} devices/s");
    Console.WriteLine($"peak concurrent streams: {connected}");
    Console.WriteLine("=========================================");
}

string? Arg(string name)
{
    var a = Environment.GetCommandLineArgs();
    var i = System.Array.IndexOf(a, name);
    return i >= 0 && i + 1 < a.Length ? a[i + 1] : null;
}
