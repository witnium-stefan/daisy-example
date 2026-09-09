# Decisions

| date | decision | rationale | who |
| --- | --- | --- | --- |
| 2026-09-09 | Repository created public under witnium-stefan (Stefan approved the account 2026-09-08; public sources acceptable for now, private repositories are a P1 feature of Daisy). Images publish to ghcr.io/witnium. | Per the spec; the intake accepts GHCR only. | PM |
| 2026-09-09 | Package visibility is set once by the owner in GitHub package settings (no API exists); CI verifies it with anonymous manifest fetches and fails loudly on mismatch. | The same limit hit with the canary mirror on 2026-09-08. | PM |
| 2026-09-09 | Slice 1 landed (item 0001, 35 tests): services web/api/worker, Dockerfiles pinned by base digest, publish workflow, compose generator (release asset), visibility verification, README. First dispatch failed to parse: `runner.temp` in job-level env (item 0002, L1). No image published yet; after the first publish the OWNER sets package visibility once (web, api, postgres public; worker private) and CI verifies it. | Live publishing is the acceptance, not the unit tests. | PM |
| 2026-09-09 | First live publish (run 34382823298): unit tests, authentication, build and push of web/api/worker (and the postgres mirror) to ghcr.io/witnium succeeded; the visibility verification failed as designed — packages are created private, and the owner sets web, api and postgres public once; worker stays private. A watch re-dispatches the workflow when the three answer anonymous manifest fetches. | The loud one-time owner action the spec asked for. | PM |
