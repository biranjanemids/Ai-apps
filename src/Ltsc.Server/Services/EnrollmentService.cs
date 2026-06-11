using Google.Protobuf;
using Google.Protobuf.WellKnownTypes;
using Grpc.Core;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Ca;
using Ltsc.Server.Registry;
using System.Security.Cryptography.X509Certificates;

namespace Ltsc.Server.Services;

/// <summary>
/// CSR-based enrollment (design §6). The agent submits a group token + PKCS#10
/// CSR; a valid token yields a CA-signed 90-day device certificate plus the CA
/// chain the agent pins for server validation. Every subsequent RPC is mTLS
/// with that certificate — this is the only service callable without one.
/// </summary>
public sealed class EnrollmentService : Enrollment.EnrollmentBase
{
    private readonly CertAuthority _ca;
    private readonly DeviceRegistry _devices;
    private readonly Registry.ServerStore _store;
    private readonly ILogger<EnrollmentService> _log;

    public EnrollmentService(CertAuthority ca, DeviceRegistry devices, Registry.ServerStore store, ILogger<EnrollmentService> log)
    {
        _ca = ca;
        _devices = devices;
        _store = store;
        _log = log;
    }

    public override Task<EnrollResponse> Enroll(EnrollRequest request, ServerCallContext context)
    {
        if (!_ca.TryResolveGroup(request.EnrollmentToken, out var groupId))
            throw new RpcException(new Status(StatusCode.PermissionDenied, "invalid enrollment token"));
        if (request.Csr.IsEmpty)
            throw new RpcException(new Status(StatusCode.InvalidArgument, "missing CSR"));

        X509Certificate2 deviceCert;
        DateTimeOffset notAfter;
        try
        {
            deviceCert = _ca.SignDeviceCsr(request.Csr.ToByteArray(), out notAfter);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "CSR rejected");
            throw new RpcException(new Status(StatusCode.InvalidArgument, "malformed CSR"));
        }

        var device = _devices.Enroll(request.Facts, groupId, deviceCert.Thumbprint);
        _store.AddAudit($"device:{device.DeviceId}", "enroll", device.DeviceId, $"group {groupId}, cert {deviceCert.Thumbprint}");
        _log.LogInformation("Enrolled device {DeviceId} (model={Model}) into {Group}, cert {Thumb} valid to {NotAfter:u}",
            device.DeviceId, request.Facts?.Model, groupId, deviceCert.Thumbprint, notAfter);

        return Task.FromResult(new EnrollResponse
        {
            DeviceId = device.DeviceId,
            GroupId = groupId,
            DeviceCertificate = ByteString.CopyFrom(deviceCert.Export(X509ContentType.Cert)),
            CaChain = ByteString.CopyFrom(_ca.CaCertificate.Export(X509ContentType.Cert)),
            NotAfter = Timestamp.FromDateTimeOffset(notAfter),
        });
    }

    public override Task<EnrollResponse> RenewCertificate(RenewRequest request, ServerCallContext context)
    {
        // Renewal requires the current (still valid) device cert on the channel.
        var current = context.GetHttpContext().Connection.ClientCertificate;
        if (current is null || !_ca.ValidateDeviceCertificate(current))
            throw new RpcException(new Status(StatusCode.Unauthenticated, "valid device certificate required"));
        if (!_devices.TryGet(request.DeviceId, out var device))
            throw new RpcException(new Status(StatusCode.NotFound, "unknown device"));

        var renewed = _ca.SignDeviceCsr(request.Csr.ToByteArray(), out var notAfter);
        return Task.FromResult(new EnrollResponse
        {
            DeviceId = device.DeviceId,
            GroupId = device.GroupId,
            DeviceCertificate = ByteString.CopyFrom(renewed.Export(X509ContentType.Cert)),
            CaChain = ByteString.CopyFrom(_ca.CaCertificate.Export(X509ContentType.Cert)),
            NotAfter = Timestamp.FromDateTimeOffset(notAfter),
        });
    }
}
