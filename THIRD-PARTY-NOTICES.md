# Third-Party Notices

## EnginEx 7.0.0

VirgoScorpio Hub links EnginEx 7.0.0 as a Git submodule at **vendor/enginex/**. The canonical source repository is [GoldenObsidianLLC/EnginEx](https://github.com/GoldenObsidianLLC/EnginEx). Current original EnginEx project materials controlled by the maintainers are licensed under GNU GPL-2.0-or-later; see the submodule's LICENSE, COPYRIGHT, and NOTICE.md files.

The direct dependencies listed in the Hub package manifest are third-party software and retain their respective licenses. A release build must generate and review a package lockfile, produce a software bill of materials (SBOM), and run a license and vulnerability scan before distribution.

The submodule is pinned to an exact commit in the Hub Git tree. CI and automated source checkouts must initialize submodules recursively so the renderer, tests, schemas, and release evidence are present.