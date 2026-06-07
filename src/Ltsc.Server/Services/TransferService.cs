using System.Security.Cryptography;
using Google.Protobuf;
using Grpc.Core;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Services;

/// <summary>
/// Chunked, resumable artifact transfer (design §5). Production streams from the
/// object store (MinIO/S3) with per-chunk + whole-artifact hashing and signature
/// verification on the agent. This scaffold serves a synthetic payload so the
/// download path is exercisable.
/// </summary>
public sealed class TransferService : Transfer.TransferBase
{
    private const int ChunkSize = 64 * 1024;

    public override async Task Download(
        DownloadRequest request,
        IServerStreamWriter<Chunk> responseStream,
        ServerCallContext context)
    {
        // Synthetic 256 KB artifact, deterministic by id, honoring resume offset.
        var payload = SyntheticArtifact(request.ArtifactId, 256 * 1024);
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

    private static byte[] SyntheticArtifact(string id, int size)
    {
        var seed = BitConverter.ToInt32(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(id)), 0);
        var rng = new Random(seed);
        var buf = new byte[size];
        rng.NextBytes(buf);
        return buf;
    }
}
