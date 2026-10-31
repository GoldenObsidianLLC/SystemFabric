# F1.11 collaboration resilience qualification — design

## Problem

F1.10 demonstrates two-node delivery and recovery correctness, but it does not provide sustained relay load evidence, prove recovery after a transient publish attempt fails, or test a multi-session reconnect storm against a surviving API node.

## Design

### Relay recovery

Use the real Redis client and a unique channel namespace. Wrap only the publisher client's `publish` method to throw for one document PUBLISH. The first operation must still arrive at the publishing node's local hub and return `degraded=true`. The next publication passes through the real client, reaches the remote hub, and returns `degraded=false`; bridge readiness/degraded gauges must return to ready.

This simulates a transient publish-call interruption while the Redis connection remains established. It is not a TCP partition, client reconnect, Redis process restart or Cluster failover test.

### Sustained bounded fan-out

Use two real Redis bridges, two independent local hubs, one site/document channel and 2–40 independently authorized subscribers on the receiving hub. Publish a paced sequence (default 2,000 operations at 5 ms between sends). Each subscriber consumes concurrently and must observe exactly sequences 1..N, strictly ordered, with no missing/duplicate operation. Assert the Redis document ingress queue drains and both ingress and slow-consumer overflow metrics remain zero.

Record publisher throughput and per-recipient delivery p50/p95/p99 using monotonic local timing. No thresholds are declared as production SLOs. Defaults and environment overrides are bounded to avoid accidental unbounded test resource use.

### Node-loss reconnect storm

Start two independent API instances and ten separate cookie-authenticated WebSocket protocol sessions. Seed 24 operations into the shared test collaboration store without relying on ephemeral Pub/Sub. Stop API node A, reconnect all sessions concurrently to node B from sequence zero, and assert each receives the full ordered history in sequence order with the expected operation payloads. Submit one additional operation after recovery, assert its acknowledgement and matching operation payload reach every peer, and verify the shared in-memory test store contains the final title.

The reconnect-storm fixture uses direct WebSocket clients, an in-memory collaboration store and a test identity adapter. This verifies gateway/replay behavior under a local simulated node loss; it does not validate a real deployment orchestrator, PostgreSQL failover, autoscaling or rolling update behavior.

## Safety and operational limits

- Real Redis tests accept only loopback `redis://` or `rediss://` URLs without credentials, query or fragment.
- Every test uses an unpredictable, unique Pub/Sub channel prefix and closes local bridges, hubs and subscriptions.
- Do not flush Redis, enumerate keys, stop the shared Redis service or touch application database credentials.
- PostgreSQL remains the durable source of collaborative operation sequence/history in the production design; tests here use the in-memory test store except the Redis bridge relay test, which tests transport only.
- The results are developer-preview resilience evidence, not release certification. Production still requires deployment-specific Redis Cluster/failover/partition tests, real orchestrator node-loss and rolling-deploy rehearsal, representative peak load and multi-hour soak, independent security/accessibility review, and owned runbooks/alerts.
