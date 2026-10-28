# SystemFabric 0.5.1 E2E accessibility patch

This patch addresses the current Playwright failure reported by the Windows development environment.

Changes:
- Align the Platform Hub E2E assertion with the actual page H1 (`One platform, connected services.`) and independently assert the document title (`SystemFabric Platform Hub`).
- Add accessible names to the library search, library type filter, expected asset version, and icon search controls. These were the four controls identified by the existing accessibility assertion as lacking labels.

Apply by extracting the ZIP into the existing project root and allowing these files to be overwritten:
- `apps/admin/platform.html`
- `test/e2e/accessibility.spec.js`

Then run:
```powershell
npm run test:e2e -- --workers=1
```

The test run should be treated as evidence only if it completes successfully in the target Windows environment. This patch does not alter DNS settings and does not establish that Chromium's bundled-browser download problem is solved.
