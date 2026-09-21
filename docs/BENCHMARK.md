# Scale benchmark

Reproducible with `scripts/loadtest-run.sh` (harness: `tools/Ltsc.LoadTest`). The
harness runs real devices, not mocks: each simulated device generates its own
ECDSA keypair, enrolls with a PKCS#10 CSR, reconnects over **mTLS with its issued
certificate**, pulls policy, opens a DeviceLink stream and heartbeats.

## Result — 500 devices, single node

| Metric | Result |
|---|---|
| Devices enrolled | **500 / 500** (0 failures) |
| Concurrent mTLS streams | **500 / 500** (0 failures) |
| Enrollment throughput | **53 devices/s** (500 enrolled in 9.4 s) |
| Enroll latency p50 / p95 | 920 ms / 2070 ms |
| Policy pull p50 / p95 | 768 ms / 1697 ms |
| Heartbeats processed | 2180 |
| Server memory (RSS) | **99 MB** (~0.2 MB/device) |
| `/healthz`, `/readyz` | 200 |

Config: single server process, SQLite store, in-process routing, `Ltsc:DemoInstall=false`.

### Reading these honestly
- **The load generator shares the same container and CPU as the server.** Client-side
  ECDSA keygen and 500 TLS handshakes compete directly with the server for cores, so
  the latency percentiles are pessimistic — they are *not* clean server-side numbers.
- Enrollment is the heaviest path (keygen + CSR + CA signature + durable write);
  steady-state heartbeat/stream cost is far lower, which is why 500 held streams fit
  in 99 MB.
- These are single-node SQLite numbers. Multi-node (PostgreSQL + Redis) is a
  horizontal-scale path, not measured here.

## What this benchmark already caught

Running it found two real defects that unit tests and small e2e runs missed:

1. **Fresh-install crash.** The durable store was constructed before anything created
   the state directory, so a brand-new deployment died on first start. Any existing
   dev box passed because the folder already existed.
2. **Heartbeat write amplification.** Every heartbeat issued a synchronous durable
   write behind a global store lock, serialising the control plane at fleet scale.
   Fixed with write-behind batching (`DeviceRegistry.FlushDirty` +
   `DeviceStateFlusher`) plus SQLite WAL, so heartbeat cost is O(dirty devices per
   flush interval) instead of O(heartbeats).

## Next scale steps (not yet measured)
- Multi-replica run behind a load balancer with shared PostgreSQL + Redis.
- Separate load-generator host, to get clean server-side percentiles.
- Sustained soak (hours) to observe stream churn, reconnect storms, and memory drift.
