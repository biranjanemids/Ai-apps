using Microsoft.Data.Sqlite;

namespace Ltsc.Server.Registry;

/// <summary>
/// Durable server state (design §12.3). SQLite so a single-node deployment
/// survives restarts with no external dependencies; the schema mirrors the
/// PostgreSQL design tables so swapping in EF Core + Postgres for multi-node
/// is a storage change, not a model change.
/// </summary>
public sealed class ServerStore : IDisposable
{
    private readonly SqliteConnection _conn;
    private readonly object _lock = new();

    public ServerStore(string path)
    {
        _conn = new SqliteConnection($"Data Source={path}");
        _conn.Open();
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS devices (
                device_id      TEXT PRIMARY KEY,
                group_id       TEXT NOT NULL,
                model          TEXT NOT NULL DEFAULT '',
                os_build       TEXT NOT NULL DEFAULT '',
                arch           TEXT NOT NULL DEFAULT '',
                agent_version  TEXT NOT NULL DEFAULT '',
                cert_thumbprint TEXT NOT NULL DEFAULT '',
                enrolled_utc   TEXT NOT NULL,
                last_seen_utc  TEXT NOT NULL,
                policy_version TEXT NOT NULL DEFAULT '',
                reboot_pending INTEGER NOT NULL DEFAULT 0
            );
        """;
        cmd.ExecuteNonQuery();
    }

    public void UpsertDevice(DeviceRegistry.DeviceRecord r, string certThumbprint = "")
    {
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = """
                INSERT INTO devices(device_id, group_id, model, os_build, arch, agent_version,
                                    cert_thumbprint, enrolled_utc, last_seen_utc, policy_version, reboot_pending)
                VALUES($id, $grp, $model, $os, $arch, $ver, $thumb, $enr, $seen, $pol, $reboot)
                ON CONFLICT(device_id) DO UPDATE SET
                    group_id=$grp, model=$model, os_build=$os, arch=$arch, agent_version=$ver,
                    cert_thumbprint=CASE WHEN $thumb='' THEN cert_thumbprint ELSE $thumb END,
                    last_seen_utc=$seen, policy_version=$pol, reboot_pending=$reboot
            """;
            cmd.Parameters.AddWithValue("$id", r.DeviceId);
            cmd.Parameters.AddWithValue("$grp", r.GroupId);
            cmd.Parameters.AddWithValue("$model", r.Facts?.Model ?? "");
            cmd.Parameters.AddWithValue("$os", r.Facts?.OsBuild ?? "");
            cmd.Parameters.AddWithValue("$arch", r.Facts?.Arch ?? "");
            cmd.Parameters.AddWithValue("$ver", r.Facts?.AgentVersion ?? "");
            cmd.Parameters.AddWithValue("$thumb", certThumbprint);
            cmd.Parameters.AddWithValue("$enr", r.EnrolledAt.ToString("o"));
            cmd.Parameters.AddWithValue("$seen", r.LastSeen.ToString("o"));
            cmd.Parameters.AddWithValue("$pol", r.PolicyVersion);
            cmd.Parameters.AddWithValue("$reboot", r.RebootPending ? 1 : 0);
            cmd.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<DeviceRegistry.DeviceRecord> LoadDevices()
    {
        var result = new List<DeviceRegistry.DeviceRecord>();
        lock (_lock)
        {
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "SELECT device_id, group_id, model, os_build, arch, agent_version, enrolled_utc, last_seen_utc, policy_version, reboot_pending FROM devices";
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                var rec = new DeviceRegistry.DeviceRecord(
                    r.GetString(0), r.GetString(1),
                    new Ltsc.Mgmt.V1.DeviceFacts
                    {
                        HardwareUuid = r.GetString(0),
                        Model = r.GetString(2),
                        OsBuild = r.GetString(3),
                        Arch = r.GetString(4),
                        AgentVersion = r.GetString(5),
                    },
                    DateTimeOffset.Parse(r.GetString(6)))
                {
                    LastSeen = DateTimeOffset.Parse(r.GetString(7)),
                    PolicyVersion = r.GetString(8),
                    RebootPending = r.GetInt32(9) == 1,
                };
                result.Add(rec);
            }
        }
        return result;
    }

    public void Dispose() => _conn.Dispose();
}
