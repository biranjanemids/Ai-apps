using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Google.Protobuf;

namespace Ltsc.Mgmt.V1;

/// <summary>
/// Server-side signing / agent-side verification of CommandEnvelopes
/// (design §13). The signature covers every semantic field, so a tampered
/// command (different action, spec, target window) fails verification even if
/// the transport is compromised. ECDSA P-256 / SHA-256.
/// </summary>
public static class CommandSigning
{
    public static byte[] Sign(CommandEnvelope cmd, ECDsa key) =>
        key.SignData(Payload(cmd), HashAlgorithmName.SHA256);

    public static bool Verify(CommandEnvelope cmd, X509Certificate2 signerCert)
    {
        using var key = signerCert.GetECDsaPublicKey();
        if (key is null) return false;
        return key.VerifyData(Payload(cmd), cmd.Signature.ToByteArray(), HashAlgorithmName.SHA256);
    }

    private static byte[] Payload(CommandEnvelope cmd)
    {
        // Canonical byte layout independent of the signature field itself.
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write(cmd.CommandId);
        w.Write(cmd.Capability);
        w.Write(cmd.Action);
        w.Write(cmd.NotAfterUnix);
        var spec = cmd.Spec.ToByteArray();
        w.Write(spec.Length);
        w.Write(spec);
        w.Flush();
        return ms.ToArray();
    }
}
