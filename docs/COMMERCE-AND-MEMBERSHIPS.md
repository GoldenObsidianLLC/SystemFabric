# Commerce, Billing, and Memberships

## Current scope

The commerce platform includes product records, inventory quantity/status, order and line-item snapshots, checkout idempotency keys, Stripe Checkout creation, timestamped webhook signature verification, payment status updates, membership plans with one-time/month/year intervals, and paid-membership states. The 0.5.1 development increment adds tenant-scoped Stripe refunds with durable order-scoped idempotency, integer minor-unit balance reservations, ambiguous-outcome preservation, refund webhook binding, and partial/full refund state transitions.

All money is represented in integer minor units (for example cents), never floating point. The checkout code re-reads published product rows inside a transaction, reserves finite stock, writes order snapshots, and releases reserved stock when checkout creation fails. Webhooks use timestamp tolerance and HMAC verification and are recorded by provider/event ID for deduplication.

## Important limits

This implementation does not yet provide the complete operational feature set expected of WooCommerce or a mature billing platform. Before production, complete taxes, shipping calculation, regional rules, coupons/discount calculation and atomic redemption, refund reconciliation/customer workflows and test-mode provider acceptance, returns, invoice/receipt generation, product variation management, digital-entitlement delivery, fulfilment workflows, stock reservation expiry, dispute handling, payment reconciliation, subscription plan changes, billing portal, dunning/retries, cancellation/renewal tests, and customer service/admin experiences.

The coupon table is groundwork only and must not be exposed as supported checkout discount functionality until its lifecycle and race-safe usage counters are implemented.

## Stripe configuration

Configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CHECKOUT_SUCCESS_URL`, and `STRIPE_CHECKOUT_CANCEL_URL` as deployment secrets/configuration. Use test-mode keys and a private test webhook before any live test. Never store raw card details in SystemFabric. Card collection belongs to Stripe-hosted Checkout; the application stores references and status only.

The refund API requires `commerce:manage` on the target site and accepts `amountMinor`, an optional `reason` (`duplicate`, `fraudulent`, or `requested_by_customer`), and a caller-generated `Idempotency-Key` header (the body `idempotencyKey` is also accepted for compatibility). Reuse the same key and parameters after a timeout or unknown outcome; a different amount, currency, or reason under the same key is rejected. Requested/pending/succeeded refunds reserve balance. A full refund changes the order to `refunded` only when succeeded refunds cumulatively cover the order total. Refunds do not automatically restock inventory.

The webhook endpoint must be reachable by the provider in a real test environment. Test duplicate delivery, out-of-order events, signature failures, delayed/failed payments, checkout expiration, refund creation/update/failure, unknown refund outcomes, and process restarts. A mocked unit suite is not a substitute for an independent Stripe test-mode run with webhook delivery evidence. Do not grant access based solely on a redirect from the checkout page; update access only after verified provider events/state reconciliation.

## Data privacy and access control

Orders, customer emails, billing/shipping addresses, membership status, and activity are tenant-scoped personal data. Enforce capability checks, least privilege, retention, export/deletion rules, and audit trails. Never rely on a client-supplied total, product price, discount, or role.


## 0.5.0 status note

Migration 0007 adds data-model foundations for stock reservations, coupon-redemption records, refunds and downloadable-product entitlements. These tables do not mean the full order, tax, shipping, refund, entitlement delivery or recurring billing state machines are complete. Those remain acceptance-test and implementation gates in `FEATURE-PARITY.md` and `RELEASE-GATE.md`.
