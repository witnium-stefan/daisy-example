# Features

| feature | priority | state | why |
| --- | --- | --- | --- |
| Repository and CI publishing digest-pinned GHCR images (web, api, postgres public; worker private) | P0 | slice 1 | the intake accepts only GHCR images by digest |
| Services and state (web, api, worker, PostgreSQL writes, files, config, secret, health/version) | P0 | planned | the aspects table of the spec |
| Failure switches per service and isolated disk/database/certificate faults | P0 | planned | Daisy must have something to investigate |
| Live campaign reusing the 0068 drivers | P0 | planned | evidence, not claims |
