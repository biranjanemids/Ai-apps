using System.Text.Json;
using Ltsc.Agent.Models;
using Microsoft.Data.Sqlite;

namespace Ltsc.Agent.Storage;

/// <summary>
/// SQLite-backed local state (design §4.2). Lives on a UWF-excluded path so it
/// survives the write filter. Holds device identity and resumable install jobs,
/// which is what lets an install continue across the reboots a UWF disable-cycle
/// or a required reboot introduces (design §8.4).
/// </summary>
public sealed class LocalStore : IDisposable
{
    private readonly SqliteConnection _conn;

    public LocalStore(string path)
    {
        _conn = new SqliteConnection($"Data Source={path};");
        _conn.Open();
        Exec("""
            CREATE TABLE IF NOT EXISTS identity (k TEXT PRIMARY KEY, v TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS install_jobs (
                command_id TEXT PRIMARY KEY,
                json TEXT NOT NULL,
                updated_utc TEXT NOT NULL
            );
        """);
    }

    // ---- identity ----------------------------------------------------------
    public string? GetIdentity(string key)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = "SELECT v FROM identity WHERE k = $k";
        cmd.Parameters.AddWithValue("$k", key);
        return cmd.ExecuteScalar() as string;
    }

    public void SetIdentity(string key, string value)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = "INSERT INTO identity(k,v) VALUES($k,$v) ON CONFLICT(k) DO UPDATE SET v=$v";
        cmd.Parameters.AddWithValue("$k", key);
        cmd.Parameters.AddWithValue("$v", value);
        cmd.ExecuteNonQuery();
    }

    public void ClearIdentity() => Exec("DELETE FROM identity");

    // ---- install jobs (resumable) ------------------------------------------
    public void SaveJob(InstallJob job)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO install_jobs(command_id, json, updated_utc)
            VALUES($id, $json, $ts)
            ON CONFLICT(command_id) DO UPDATE SET json=$json, updated_utc=$ts
        """;
        cmd.Parameters.AddWithValue("$id", job.CommandId);
        cmd.Parameters.AddWithValue("$json", JsonSerializer.Serialize(job));
        cmd.Parameters.AddWithValue("$ts", DateTimeOffset.UtcNow.ToString("o"));
        cmd.ExecuteNonQuery();
    }

    public void DeleteJob(string commandId)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = "DELETE FROM install_jobs WHERE command_id = $id";
        cmd.Parameters.AddWithValue("$id", commandId);
        cmd.ExecuteNonQuery();
    }

    /// <summary>In-flight jobs to resume on startup (not in a terminal state).</summary>
    public IReadOnlyList<InstallJob> LoadResumableJobs()
    {
        var result = new List<InstallJob>();
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = "SELECT json FROM install_jobs ORDER BY updated_utc";
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            var job = JsonSerializer.Deserialize<InstallJob>(r.GetString(0));
            if (job is null) continue;
            if (job.State is InstallState.Succeeded or InstallState.Failed
                or InstallState.RolledBack or InstallState.AlreadyInstalled)
                continue;
            result.Add(job);
        }
        return result;
    }

    private void Exec(string sql)
    {
        using var cmd = _conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    public void Dispose() => _conn.Dispose();
}
