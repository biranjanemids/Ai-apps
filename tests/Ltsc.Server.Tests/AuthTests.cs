using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Ltsc.Server.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Ltsc.Server.Tests;

public class AuthTests
{
    private const string Secret = "test-oidc-secret-0123456789";

    private static AdminAuth Build() =>
        new(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Ltsc:Oidc:Secret"] = Secret })
            .Build());

    private static HttpContext WithToken(string token)
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Headers.Authorization = "Bearer " + token;
        return ctx;
    }

    private static string Jwt(string role, string tenant, long? exp = null)
    {
        static string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var header = B64(Encoding.UTF8.GetBytes("""{"alg":"HS256","typ":"JWT"}"""));
        var claims = new Dictionary<string, object> { ["sub"] = "alice", ["role"] = role, ["tenant"] = tenant, ["exp"] = exp ?? DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds() };
        var payload = B64(JsonSerializer.SerializeToUtf8Bytes(claims));
        var sig = B64(HMACSHA256.HashData(Encoding.UTF8.GetBytes(Secret), Encoding.ASCII.GetBytes($"{header}.{payload}")));
        return $"{header}.{payload}.{sig}";
    }

    [Fact]
    public void StaticToken_StillResolves()
    {
        var (actor, role, tenant) = Build().Resolve(WithToken("admin-token"));
        Assert.Equal(Role.Admin, role);
        Assert.Equal("tenant-a", tenant);
    }

    [Fact]
    public void ValidJwt_ResolvesRoleAndTenant()
    {
        var (actor, role, tenant) = Build().Resolve(WithToken(Jwt("Operator", "tenant-b")));
        Assert.Equal("alice", actor);
        Assert.Equal(Role.Operator, role);
        Assert.Equal("tenant-b", tenant);
    }

    [Fact]
    public void TamperedJwt_Rejected()
    {
        var jwt = Jwt("Admin", "tenant-a");
        var tampered = jwt[..^4] + "AAAA"; // corrupt signature
        Assert.Equal(Role.None, Build().Resolve(WithToken(tampered)).role);
    }

    [Fact]
    public void ExpiredJwt_Rejected()
    {
        var expired = Jwt("Admin", "tenant-a", DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeSeconds());
        Assert.Equal(Role.None, Build().Resolve(WithToken(expired)).role);
    }
}
