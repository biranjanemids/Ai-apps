# Build
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY proto/ proto/
COPY src/Ltsc.Contracts/ src/Ltsc.Contracts/
COPY src/Ltsc.Server/ src/Ltsc.Server/
RUN dotnet publish src/Ltsc.Server/Ltsc.Server.csproj -c Release -o /app

# Run
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
EXPOSE 8443
ENTRYPOINT ["dotnet", "Ltsc.Server.dll"]
