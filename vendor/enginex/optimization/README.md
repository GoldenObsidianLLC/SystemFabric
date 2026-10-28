# EnginEx optimization evidence

Every optimization is evaluated independently where practical. An optimization is not promoted because a local microbenchmark sounds plausible or because a backend feature exists.

## Required evidence package

For each candidate, retain:

- The stable baseline and candidate artifact hashes.
- Correctness and security results, including output equivalence.
- The workload fixture, profile, Node/PHP versions, OS/architecture and CPU model.
- Raw runs, paired summary, sample count, warm-up policy and statistical summary.
- Throughput, mean/median and tail latency where available, memory/GC metrics where relevant.
- Known limitations and evidence class.
- A feature-flag or version-based rollback action.

## Promotion states

`proposed` -> `tested` -> `shadow` -> `canary` -> `enabled` -> `retired`.

Promotion may skip a state only with a documented reason. Any missed correctness condition, security regression, output mismatch, or failure of the declared performance target blocks promotion. Rollback must restore the prior renderer/cache/backend configuration without requiring a schema-breaking data migration.

## Current 6.2 evidence boundary

The CLI benchmark in `bench/enginex-php-twig-comparison.json` is a local exploratory measurement. It is not a PHP-FPM or production certification. Twig is marked unavailable if its Composer package is not installed. The runtime and host details are recorded with the result. The AST manifest contains source hashes and compiler/grammar metadata; it is not yet a standalone precompiled JavaScript render module.
