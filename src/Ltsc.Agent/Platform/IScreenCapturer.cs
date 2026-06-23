namespace Ltsc.Agent.Platform;

public sealed record ScreenFrame(int Width, int Height, string Mime, byte[] Data);

/// <summary>
/// Captures the device screen for remote shadow (design §10). Windows production
/// uses DXGI Desktop Duplication / BitBlt; this cross-platform default emits a
/// small synthetic frame so the shadow pipeline is runnable and testable.
/// </summary>
public interface IScreenCapturer
{
    ScreenFrame Capture(long seq);
}

public sealed class DefaultScreenCapturer : IScreenCapturer
{
    private const int W = 64, H = 48;

    public ScreenFrame Capture(long seq)
    {
        // Synthetic RGB frame with a moving band so successive frames differ.
        var data = new byte[W * H * 3];
        var band = (int)(seq % H);
        for (var y = 0; y < H; y++)
            for (var x = 0; x < W; x++)
            {
                var i = (y * W + x) * 3;
                data[i] = (byte)(y == band ? 255 : x * 4);
                data[i + 1] = (byte)(y * 5);
                data[i + 2] = (byte)(seq * 7);
            }
        return new ScreenFrame(W, H, "application/x-rgb24", data);
    }
}

/// <summary>
/// Streams captured frames to the server over the Shadow gRPC stream until the
/// frame budget is hit or the server sends stop. Implemented by CommChannel.
/// </summary>
public interface IShadowUplink
{
    Task<int> RunAsync(IScreenCapturer capturer, string sessionId, int maxFrames, int fps, CancellationToken ct);
}
