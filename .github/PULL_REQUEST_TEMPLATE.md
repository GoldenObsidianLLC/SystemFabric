## Summary

Describe the problem and the intended change.

## Change category

- [ ] Bug fix
- [ ] Feature
- [ ] Security / hardening
- [ ] Documentation
- [ ] Dependency / build / CI
- [ ] Other

## Implementation

- Main paths/components changed:
- Important design choices:
- Database/configuration/API compatibility impact:

## Validation

| Command/check | Result | Notes |
|---|---|---|
| `npm run check` | Not run / pass / fail | |
| `npm --prefix vendor/enginex test` | Not run / pass / fail | |
| `npm run test:e2e -- --workers=1` | Not run / pass / fail | |
| `npm run test:integration:live` | Not run / pass / fail | State whether PostgreSQL/Memgraph were live. |
| Secret scan / dependency audit | Not run / pass / fail | |

List any additional checks and clearly state what was not tested.

## Risk and rollout

- Security or tenant-isolation implications:
- Migration/deployment/rollback notes:
- External services or credentials required (never include actual secrets):

## Documentation and release

- [ ] Documentation updated where behavior/setup changed.
- [ ] Tests added or updated where appropriate.
- [ ] No real secrets, private data, or unrelated generated artifacts are included.
- [ ] Third-party license and copyright notices are preserved.
- [ ] Any release-readiness impact is stated.
