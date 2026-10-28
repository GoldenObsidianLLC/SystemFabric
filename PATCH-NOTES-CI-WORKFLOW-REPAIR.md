# SystemFabric 0.5.1 — CI Workflow Repair v4

Replace `.github/workflows/ci.yml` with the corrected workflow included in this patch.

This version repairs the malformed PostgreSQL/Memgraph wait step, creates the isolated `systemfabric_test` database expected by the live integration job, and keeps the browser job and CodeQL job as separate valid jobs. The browser job explicitly configures Node.js, installs the lockfile dependency graph, materializes optional assets, installs Chromium, runs Playwright, and uploads its report.

## Apply

From the repository root in PowerShell:

```powershell
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\SystemFabric-0.5.1-ci-workflow-repair-v4.zip" -DestinationPath "$PWD" -Force
```

Review the workflow diff before committing. This patch does not establish that GitHub Actions or CodeQL passes; an actual CI run is still required. It does not certify production readiness.
