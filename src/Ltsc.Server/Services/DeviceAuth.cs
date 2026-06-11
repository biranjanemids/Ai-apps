using Grpc.Core;
using Ltsc.Server.Ca;

namespace Ltsc.Server.Services;

/// <summary>
/// mTLS enforcement for device-facing RPCs (design §13). Enrollment is the only
/// anonymous call; everything else must present a CA-issued client certificate.
/// </summary>
public static class DeviceAuth
{
    public static void RequireDeviceCertificate(ServerCallContext context, CertAuthority ca)
    {
        var cert = context.GetHttpContext().Connection.ClientCertificate;
        if (cert is null)
            throw new RpcException(new Status(StatusCode.Unauthenticated, "device certificate required"));
        if (!ca.ValidateDeviceCertificate(cert))
            throw new RpcException(new Status(StatusCode.Unauthenticated, "device certificate not issued by this CA"));
    }
}
