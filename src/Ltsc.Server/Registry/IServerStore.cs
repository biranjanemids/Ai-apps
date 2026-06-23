namespace Ltsc.Server.Registry;

/// <summary>
/// Durable server state (design §12.3). Implemented by SQLite (single-node) and
/// PostgreSQL (multi-node shared state). Selected by config: a Ltsc:Postgres
/// connection string switches the whole fleet/audit/policy state to Postgres so
/// multiple server nodes share it.
/// </summary>
public interface IServerStore
{
    void UpsertDevice(DeviceRegistry.DeviceRecord r, string certThumbprint = "");
    IReadOnlyList<DeviceRegistry.DeviceRecord> LoadDevices();

    void AddAudit(string tenantId, string actor, string action, string target, string detail);
    IReadOnlyList<(string Ts, string Actor, string Action, string Target, string Detail)> LoadAudit(string tenantId, int limit = 200);

    void UpsertPolicy(string tenantId, string groupId, string json);
    IReadOnlyList<(string Tenant, string Group, string Json)> LoadPolicies();

    // Certificate revocation (design §13). Revoked device-cert thumbprints persist
    // so a compromised device stays locked out across restarts.
    void RevokeCert(string thumbprint);
    IReadOnlyCollection<string> LoadRevokedCerts();
}
