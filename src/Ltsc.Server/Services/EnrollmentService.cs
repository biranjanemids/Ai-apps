using Google.Protobuf.WellKnownTypes;
using Grpc.Core;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Ca;
using Ltsc.Server.Registry;

namespace Ltsc.Server.Services;

public sealed class EnrollmentService : Enrollment.EnrollmentBase
{
    private readonly DevCertAuthority _ca;
    private readonly DeviceRegistry _devices;
    private readonly ILogger<EnrollmentService> _log;

    public EnrollmentService(DevCertAuthority ca, DeviceRegistry devices, ILogger<EnrollmentService> log)
    {
        _ca = ca;
        _devices = devices;
        _log = log;
    }

    public override Task<EnrollResponse> Enroll(EnrollRequest request, ServerCallContext context)
    {
        if (!_ca.TryResolveGroup(request.EnrollmentToken, out var groupId))
            throw new RpcException(new Status(StatusCode.PermissionDenied, "invalid enrollment token"));

        var device = _devices.Enroll(request.Facts, groupId);
        var (session, notAfter) = _ca.IssueSession(device.DeviceId);

        _log.LogInformation("Enrolled device {DeviceId} (model={Model}) into {Group}",
            device.DeviceId, request.Facts?.Model, groupId);

        return Task.FromResult(new EnrollResponse
        {
            DeviceId = device.DeviceId,
            GroupId = groupId,
            SessionToken = session,
            NotAfter = Timestamp.FromDateTimeOffset(notAfter),
        });
    }

    public override Task<EnrollResponse> RenewCertificate(RenewRequest request, ServerCallContext context)
    {
        if (!_devices.TryGet(request.DeviceId, out var device))
            throw new RpcException(new Status(StatusCode.NotFound, "unknown device"));

        var (session, notAfter) = _ca.IssueSession(device.DeviceId);
        return Task.FromResult(new EnrollResponse
        {
            DeviceId = device.DeviceId,
            GroupId = device.GroupId,
            SessionToken = session,
            NotAfter = Timestamp.FromDateTimeOffset(notAfter),
        });
    }
}
