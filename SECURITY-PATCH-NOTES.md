# SystemFabric 0.5.1 dependency security patch

## Changes

- Upgrade direct dependency `zod` from `4.2.1` to `4.6.6` to address GHSA-mrhx-c7xc-m3w5.
- Upgrade optional dependency `sharp` from `0.35.4` to `0.35.5` to address GHSA-wq5f-xc86-pv6w.
- Keep `sharp` in `optionalDependencies`; image optimization remains optional.

## Apply

1. Extract the included `SystemFabric-0.5.1/package.json` over the project's root `package.json`.
2. From the project root, run `npm install` to reconcile and update the already-generated `package-lock.json` and install the patched versions. Do not use `npm ci` until after the lockfile has been refreshed.
3. Verify versions: `npm ls zod sharp`.
4. Run `npm audit` and `npm audit --omit=dev`.
5. Run `npm run check`, `npm run test:e2e -- --workers=1`, and `npm run test:integration:live`.

Do not use `npm audit fix --force`. The fix explicitly updates the two pinned package versions while preserving the optional nature of `sharp`.

## Release note

This patch updates declared package versions only. The lockfile must be regenerated on the recipient machine and the verification commands must pass before claiming that the vulnerabilities are remediated. The supplied patch does not itself prove audit clearance or production readiness.
