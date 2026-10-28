# SystemFabric 0.5.1 — Release Readiness Fixes

This patch makes three limited corrections:

1. Ensures the browser-and-accessibility GitHub Actions job configures Node.js in `actions/setup-node` and runs `npm ci` as a separate step.
2. Includes migration `0009_fix_content_item_slug_constraint.sql` in the release-readiness migration artifact check.
3. Aligns the release evidence contract with the current migration range, `0001`–`0009`.

No evidence gate is marked passed by this patch. The readiness report must still remain `NOT_PRODUCTION_CERTIFIED` until required evidence is collected and reviewed.
