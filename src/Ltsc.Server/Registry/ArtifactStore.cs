using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Ltsc.Server.Registry;

/// <summary>
/// Artifact source for Transfer downloads (design §5). Production streams from
/// MinIO/S3; this scaffold serves deterministic synthetic payloads, but the
/// contract is real: every artifact has a SHA-256 the job spec carries and the
/// agent must verify before use. One source of truth so the hash the
/// JobOrchestrator advertises always matches the bytes Transfer serves.
/// </summary>
public sealed class ArtifactStore
{
    private readonly ConcurrentDictionary<string, byte[]> _cache = new();

    public byte[] GetBytes(string artifactId) =>
        _cache.GetOrAdd(artifactId, id =>
        {
            var seed = BitConverter.ToInt32(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(id)), 0);
            var rng = new Random(seed);
            var buf = new byte[256 * 1024];
            rng.NextBytes(buf);
            return buf;
        });

    public byte[] GetSha256(string artifactId) => SHA256.HashData(GetBytes(artifactId));
}
