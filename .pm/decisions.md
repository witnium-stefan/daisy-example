# Decisions

| date | decision | rationale | who |
| --- | --- | --- | --- |
| 2026-09-09 | Repository created public under witnium-stefan (Stefan approved the account 2026-09-08; public sources acceptable for now, private repositories are a P1 feature of Daisy). Images publish to ghcr.io/witnium. | Per the spec; the intake accepts GHCR only. | PM |
| 2026-09-09 | Package visibility is set once by the owner in GitHub package settings (no API exists); CI verifies it with anonymous manifest fetches and fails loudly on mismatch. | The same limit hit with the canary mirror on 2026-09-08. | PM |
