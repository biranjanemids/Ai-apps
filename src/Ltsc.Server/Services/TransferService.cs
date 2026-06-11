using System.Security.Cryptography;
using Google.Protobuf;
using Grpc.Core;
using Ltsc.Mgmt.V1;
using Ltsc.Server.Ca;
using Ltsc.Server.Registry;

namespace Ltsc.Server.Services;

/// <summary>
/// Chunked, resumable artifact transfer (design §5), mTLS-only. Serves from the
/// ArtifactStore (single source of truth for bytes + hashes) with per-chunk
/// SHA-256 so the agent can verify integrity end to end before installing.
/// </summary>
public sealed class TransferService : Transfer.TransferBase
{
    private const int ChunkSize = 64 * 1024;
    private readonly ArtifactStore _artifacts;
    private readonly CertAuthority _ca;

    public TransferService(ArtifactStore artifacts, CertAuthority ca)
    {
        _artifacts = artifacts;
        _ca = ca;
    }

    public override async Task Download(
        DownloadRequest request,
        IServerStreamWriter<Chunk> responseStream,
        ServerCallContext context)
    {
        DeviceAuth.RequireDeviceCertificate(context, _ca);

        var payload = _artifacts.GetBytes(request.ArtifactId);
        var offset = (int)Math.Min(request.Offset, payload.Length);

        while (offset < payload.Length && !context.CancellationToken.IsCancellationRequested)
        {
            var size = Math.Min(ChunkSize, payload.Length - offset);
            var slice = payload.AsSpan(offset, size).ToArray();
            var last = offset + size >= payload.Length;

            await responseStream.WriteAsync(new Chunk
            {
                TransferId = request.ArtifactId,
                Offset = offset,
                Data = ByteString.CopyFrom(slice),
                Sha256 = ByteString.CopyFrom(SHA256.HashData(slice)),
                Last = last,
            });
            offset += size;
        }
    }

    public override async Task<UploadResult> Upload(
        IAsyncStreamReader<Chunk> requestStream,
        ServerCallContext context)
    {
        DeviceAuth.RequireDeviceCertificate(context, _ca);

        long total = 0;
        using var sha = SHA256.Create();
        await foreach (var chunk in requestStream.ReadAllAsync(context.CancellationToken))
        {
            var bytes = chunk.Data.ToByteArray();
            sha.TransformBlock(bytes, 0, bytes.Length, null, 0);
            total += bytes.Length;
        }
        sha.TransformFinalBlock(Array.Empty<byte>(), 0, 0);

        return new UploadResult
        {
            ArtifactId = Guid.NewGuid().ToString("n"),
            TotalBytes = total,
            Sha256 = ByteString.CopyFrom(sha.Hash ?? Array.Empty<byte>()),
        };
    }
}
