using Npgsql;

namespace Ltsc.Server.Registry;

/// <summary>
/// PostgreSQL-backed server state for multi-node deployments (design §12.3): all
/// server nodes share one fleet/audit/policy database, so a device can enroll on
/// one node and be commanded from another. Schema mirrors the SQLite store.
/// </summary>
public sealed class PostgresServerStore : IServerStore
{
    private readonly string _conn;

    public PostgresServerStore(string connectionString)
    {
        _conn = connectionString;
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
                os_build TEXT NOT NULL DEFAULT '', arch TEXT NOT NULL DEFAULT '', agent_version TEXT NOT NULL DEFAULT '',
                cert_thumbprint TEXT NOT NULL DEFAULT '', enrolled_utc TEXT NOT NULL, last_seen_utc TEXT NOT NULL,
                policy_version TEXT NOT NULL DEFAULT '', reboot_pending BOOLEAN NOT NULL DEFAULT FALSE);
            CREATE TABLE IF NOT EXISTS audit (
                id BIGSERIAL PRIMARY KEY, ts_utc TEXT NOT NULL, actor TEXT NOT NULL,
                action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
            CREATE TABLE IF NOT EXISTS policies (group_id TEXT PRIMARY KEY, json TEXT NOT NULL);
        """;
        cmd.ExecuteNonQuery();
    }

    private NpgsqlConnection Open() { var c = new NpgsqlConnection(_conn); c.Open(); return c; }

    public void UpsertDevice(DeviceRegistry.DeviceRecord r, string certThumbprint = "")
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = """
            INSERT INTO devices(device_id, group_id, model, os_build, arch, agent_version, cert_thumbprint,
                                enrolled_utc, last_seen_utc, policy_version, reboot_pending)
            VALUES(@id,@grp,@model,@os,@arch,@ver,@thumb,@enr,@seen,@pol,@reboot)
            ON CONFLICT(device_id) DO UPDATE SET group_id=@grp, model=@model, os_build=@os, arch=@arch,
                agent_version=@ver, cert_thumbprint=CASE WHEN @thumb='' THEN devices.cert_thumbprint ELSE @thumb END,
                last_seen_utc=@seen, policy_version=@pol, reboot_pending=@reboot
        """;
        cmd.Parameters.AddWithValue("id", r.DeviceId);
        cmd.Parameters.AddWithValue("grp", r.GroupId);
        cmd.Parameters.AddWithValue("model", r.Facts?.Model ?? "");
        cmd.Parameters.AddWithValue("os", r.Facts?.OsBuild ?? "");
        cmd.Parameters.AddWithValue("arch", r.Facts?.Arch ?? "");
        cmd.Parameters.AddWithValue("ver", r.Facts?.AgentVersion ?? "");
        cmd.Parameters.AddWithValue("thumb", certThumbprint);
        cmd.Parameters.AddWithValue("enr", r.EnrolledAt.ToString("o"));
        cmd.Parameters.AddWithValue("seen", r.LastSeen.ToString("o"));
        cmd.Parameters.AddWithValue("pol", r.PolicyVersion);
        cmd.Parameters.AddWithValue("reboot", r.RebootPending);
        cmd.ExecuteNonQuery();
    }

    public IReadOnlyList<DeviceRegistry.DeviceRecord> LoadDevices()
    {
        var result = new List<DeviceRegistry.DeviceRecord>();
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT device_id, group_id, model, os_build, arch, agent_version, enrolled_utc, last_seen_utc, policy_version, reboot_pending FROM devices";
        using var r = cmd.ExecuteReader();
        while (r.Read())
            result.Add(new DeviceRegistry.DeviceRecord(r.GetString(0), r.GetString(1),
                new Ltsc.Mgmt.V1.DeviceFacts { HardwareUuid = r.GetString(0), Model = r.GetString(2), OsBuild = r.GetString(3), Arch = r.GetString(4), AgentVersion = r.GetString(5) },
                DateTimeOffset.Parse(r.GetString(6)))
            { LastSeen = DateTimeOffset.Parse(r.GetString(7)), PolicyVersion = r.GetString(8), RebootPending = r.GetBoolean(9) });
        return result;
    }

    public void AddAudit(string actor, string action, string target, string detail)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT INTO audit(ts_utc, actor, action, target, detail) VALUES(@ts,@a,@act,@t,@d)";
        cmd.Parameters.AddWithValue("ts", DateTimeOffset.UtcNow.ToString("o"));
        cmd.Parameters.AddWithValue("a", actor);
        cmd.Parameters.AddWithValue("act", action);
        cmd.Parameters.AddWithValue("t", target);
        cmd.Parameters.AddWithValue("d", detail);
        cmd.ExecuteNonQuery();
    }

    public IReadOnlyList<(string Ts, string Actor, string Action, string Target, string Detail)> LoadAudit(int limit = 200)
    {
        var rows = new List<(string, string, string, string, string)>();
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT ts_utc, actor, action, target, detail FROM audit ORDER BY id DESC LIMIT @n";
        cmd.Parameters.AddWithValue("n", limit);
        using var r = cmd.ExecuteReader();
        while (r.Read()) rows.Add((r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4)));
        return rows;
    }

    public void UpsertPolicy(string groupId, string json)
    {
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "INSERT INTO policies(group_id, json) VALUES(@g,@j) ON CONFLICT(group_id) DO UPDATE SET json=@j";
        cmd.Parameters.AddWithValue("g", groupId);
        cmd.Parameters.AddWithValue("j", json);
        cmd.ExecuteNonQuery();
    }

    public IReadOnlyDictionary<string, string> LoadPolicies()
    {
        var map = new Dictionary<string, string>();
        using var c = Open();
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT group_id, json FROM policies";
        using var r = cmd.ExecuteReader();
        while (r.Read()) map[r.GetString(0)] = r.GetString(1);
        return map;
    }
}
