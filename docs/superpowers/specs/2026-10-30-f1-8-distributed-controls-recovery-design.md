# F1.8 Distributed Controls and Recovery — Design

**Date:** 2026-10-30  
**Status:** Implementation baseline for the F1.8 developer-preview slice

## Intent
Add authenticated duplex transport and distributed connection controls while preserving SSE as the one-way fallback. Make relay degradation visible and define reconnect semantics without treating ephemeral Redis Pub/Sub as a durable replay log.

## Goals
- Add authenticated site-scoped WebSocket for the existing presence topic; retain SSE.
- Enforce global, per-site, and per-principal connection quotas with renewable leases. Redis is shared; memory is development/test only.
- Bound frame size, message rate, outbound buffering and lease lifetime.
- Reauthorize inbound commands and periodic heartbeats.
- Recover presence by reconnecting and fetching the authoritative REST snapshot; do not promise event replay.
- Add bounded fan-out, transport, quota and relay telemetry.
- Test relay interruption, quota expiry/release, queue overflow, authorization revocation and reconnect behavior.

## Non-goals
No OT/CRDT, collaborative editing, durable event broker, multi-region guarantees, generic client publish, production certification, database migration, or primary-database access.

## Approaches considered
1. **WebSocket plus existing SSE:** use the maintained `ws` server adapter on the existing HTTP server. One narrow duplex protocol; SSE remains the fallback.
2. **Split HTTP:** SSE outbound plus authenticated POST commands inbound. Avoids a WebSocket dependency but makes clients manage two channels.
3. **Custom WebSocket framing:** implement RFC 6455 with Node core. Rejected because protocol/security maintenance becomes project-owned.

**Selected:** approach 1. `ws@8.22.0` supports `WebSocketServer({ noServer: true })`, so the existing HTTP server retains routing and authentication.

## Protocol and authorization
- Path: `GET /api/v1/sites/:siteId/realtime/ws`.
- Require session/development-token authentication, strict same-origin `Origin`, and existing `content:read` capability. No credentials in query strings.
- Only `presence` is supported. Client messages are limited to `ping`, `presence.heartbeat`, and `presence.leave`; identity and site scope come from authentication.
- Reauthorize each command and periodically. Bound payload to 4 KiB, messages to 60/minute/connection, outbound buffering to 1 MiB; disable per-message compression.
- SSE and WebSocket share a connection quota contract.

## Distributed quotas
Interface: `acquire({ siteId, principalId }) -> { renew(), release() }`. Redis Lua atomically accounts for global, site and principal sorted-set leases. Expiry handles process crashes. Redis quota failure is fail-closed for new connections; memory quotas are development/test only.

Defaults: 10,000 global, 500/site, 4/principal, 45-second lease, 15-second renewal. Bounds are configurable and validated.

## Relay degradation and reconnect
- Redis Pub/Sub remains ephemeral for presence refresh and authorization invalidation; PostgreSQL remains the durable business-event source.
- Presence refresh is delivered locally even when Redis is unavailable, and remote fan-out degradation is returned and measured. Authorization revokes locally first, then reports relay failure; periodic reauthorization is the remote fallback.
- Reconnect policy: exponential backoff with full jitter, 1-second minimum, 30-second maximum, 8 attempts. After reconnect, clients fetch the presence snapshot. No Pub/Sub replay guarantee.
- SSE advertises retry timing and sends a ready frame; WebSocket sends the same recovery contract. Slow consumers close with retryable signals.

## Constraints
Node.js `>=22.23.4`; existing Redis dependency; pinned direct `ws@8.22.0`; no `.env` edits, database access, or migrations. Production real-time still requires injected distributed hub, presence and quota adapters.
