using Google.Protobuf;
using Ltsc.Agent.Modules;
using Ltsc.Mgmt.V1;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Ltsc.Agent.Tests;

public class ShadowTests
{
    private static CommandEnvelope Start() =>
        new() { CommandId = "s1", Capability = "shadow", Action = "start", Spec = ByteString.Empty };

    [Fact]
    public async Task Shadow_WithConsent_StreamsFrames()
    {
        var uplink = new FakeShadowUplink();
        var session = new FakeSession { ShadowConsent = true };
        using var ctx = new RecordingContext(new FakeUwf(), new FakeInstaller(), new FakeDetection(), session, shadow: uplink);

        await new ShadowModule(NullLogger<ShadowModule>.Instance).ApplyAsync(Start(), ctx, default);

        Assert.Equal(1, uplink.Calls);
        Assert.Contains(ctx.Events, e => e.Type == "shadow.consent_granted");
        Assert.Equal("Succeeded", ctx.Results.Single().Status);
    }

    [Fact]
    public async Task Shadow_WithoutConsent_StreamsNothing()
    {
        var uplink = new FakeShadowUplink();
        var session = new FakeSession { ShadowConsent = false };
        using var ctx = new RecordingContext(new FakeUwf(), new FakeInstaller(), new FakeDetection(), session, shadow: uplink);

        await new ShadowModule(NullLogger<ShadowModule>.Instance).ApplyAsync(Start(), ctx, default);

        Assert.Equal(0, uplink.Calls);                          // no frames without consent
        Assert.Contains(ctx.Events, e => e.Type == "shadow.consent_denied");
        Assert.Equal("Failed", ctx.Results.Single().Status);
    }
}
