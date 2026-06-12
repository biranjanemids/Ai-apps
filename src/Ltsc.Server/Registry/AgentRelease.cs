using Google.Protobuf;

namespace Ltsc.Server.Registry;

/// <summary>
/// The agent release the server advertises to devices in ServerHello (agent
/// lifecycle). Configure via Ltsc:AgentRelease:Version (and the artifact is served
/// by the ArtifactStore as `agent-pkg-{version}`). When the advertised version is
/// newer than a device's running agent, the device self-updates.
/// </summary>
public sealed class AgentRelease
{
    public string Version { get; }
    public string ArtifactId { get; }
    public ByteString Sha256 { get; }
    public bool Mandatory { get; }

    public AgentRelease(IConfiguration config, ArtifactStore artifacts)
    {
        Version = config["Ltsc:AgentRelease:Version"] ?? "0.1.0";
        ArtifactId = $"agent-pkg-{Version}";
        Sha256 = ByteString.CopyFrom(artifacts.GetSha256(ArtifactId));
        Mandatory = config.GetValue("Ltsc:AgentRelease:Mandatory", false);
    }
}
