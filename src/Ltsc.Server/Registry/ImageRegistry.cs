using Google.Protobuf;
using Ltsc.Mgmt.V1;

namespace Ltsc.Server.Registry;

/// <summary>
/// Assignable OS images for BMR (design §11/§12). Production stores FFU/WIM in
/// object storage with model + hash metadata; this scaffold seeds one demo image
/// backed by the ArtifactStore so trigger_bmr resolves to a real, hash-verified
/// artifact end to end.
/// </summary>
public sealed class ImageRegistry
{
    private readonly ArtifactStore _artifacts;
    public ImageRegistry(ArtifactStore artifacts) => _artifacts = artifacts;

    public ImageSpec ForModel(string model) => new()
    {
        ImageId = "image-ltsc-base-2024",
        Format = "ffu",
        WipePolicy = "full",
        Sha256 = ByteString.CopyFrom(_artifacts.GetSha256("image-ltsc-base-2024")),
        Model = string.IsNullOrEmpty(model) ? "GenericThinClient" : model,
    };
}
