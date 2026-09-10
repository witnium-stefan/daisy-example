# daisy-example

Synthetic application for Opsie Daisy's operational acceptance examples. The
reviewed specification is `docs/architecture/example-application.md` in
`witnium-stefan/opsie-daisy-repo`. This repository implements slices 1–3: Repository and CI, Services and
state, and Failure switches. Local fixture tests are not evidence of a live deployment, database-server
restart, backup system, or off-site recovery.

## Local development

Use Node 24 and install the locked dependencies:

```sh
fnm exec --using 24 -- npm ci --ignore-scripts
fnm exec --using 24 -- npm test
```

Tests use Node's standard test runner, fake registry responses, temporary files,
loopback HTTP listeners, and an in-memory transaction stand-in. Docker is not
required. If `DATABASE_URL` is present, the same command also runs PostgreSQL
commit, independent-session readback, rollback, concurrent retry, and application
process restart tests. Supply it through the environment to an **empty disposable
PostgreSQL database**; there is no default URL. An empty or invalid supplied value
fails. These tests retain their rows and refuse an already populated fixture;
they never erase an existing database. Without the binding, the PostgreSQL test
explicitly reports skipped/unavailable, not passed. Server restart and live
storage evidence remain for the runbook.

Heavy integration, e2e, demo, rehearsal, and full CI gates are **DEFERRED** to the
runbook after the build, not reported as passing.

The only runtime dependency is the existing `pg@8.16.3`. The lockfile was resolved
with `--before=2026-08-26`, enforcing the 14-day release quarantine as of September
9, 2026 for transitive dependencies too. Dependency updates must repeat that age
check. Web uses only the standard library. Node 24.7.0 and PostgreSQL 17.6 bookworm
base images are pinned to upstream OCI digests in their Dockerfiles. Builds use
the repository root as context.

Run `node services/web/main.mjs`, `node services/api/main.mjs`, or
`node services/worker/main.mjs` after supplying approved bindings:

| Service | Required configuration |
| --- | --- |
| All Node services | `SOURCE_REVISION`: full 40-character Git SHA, baked into published images; `EXAMPLE_TOKEN`: shared worker/operator credential; `FILES_PATH`: absolute existing writable mounted directory. |
| Web | `EXAMPLE_MESSAGE`: visible nonsecret message; `API_URL`: internal API HTTP origin. |
| API | `DATABASE_URL`: PostgreSQL URL including database name; `FAULT_FILL_CAP_BYTES`: positive integer, at most 67108864 (64 MiB); `FAULT_FILL_FLOOR_BYTES`: positive safe integer specifying minimum available bytes during filling. Both bounds are required, with no defaults. |
| Worker | `DATABASE_URL` and `API_URL`. |
| PostgreSQL | `POSTGRES_PASSWORD` through its approved binding. |

For the Compose topology, explicitly bind `API_URL` to `http://api:9090` and
`FILES_PATH` to `/data`. These are deployment bindings, never runtime defaults.
The existing `files` named volume is mounted on all three Node services. API
performs the file writes requested by worker; each service owns its bounded fault
record. The worker mount and `database` volume are preserved; no ledger data is
moved or erased. Run one replica per service and one campaign fault at a time.
`EXAMPLE_TOKEN` is the slice 2 credential key, replacing the unused slice 1
`EXAMPLE_SHARED_SECRET` intent. Credentials accept visible ASCII for HTTP header
transport. Missing configuration refuses startup by key; invalid URLs and
unavailable database/files storage fail without printing binding values. Never
put credentials in source, command arguments, logs, or checked-in files.

Application ports are web 8080, API 8081, and worker 8082. Each process also has an
internal management listener on 9090, excluded from Compose's advertised ports.
Keep 9090 on the private service network; do not publish it or route a public
hostname to it. Run local processes in separate network namespaces or one at a
time because they share that management port.

## Service flow and evidence

Web `/` renders the API ledger and the bound `EXAMPLE_MESSAGE`, and provides a
job submission form. Changing the message binding changes the rendered response.
The form posts `{ "id": "example-job", "payload": "example bytes" }` to web
`POST /jobs`, which forwards to API `POST /jobs`. API acknowledgment (202) means
**queued durably**, not completed. `GET /ledger` returns ordered committed rows;
`GET /files` returns durable file names, byte counts, and SHA-256 hashes. Web also
proxies these read routes. Payloads are rendered as text, not interpreted HTML.

The worker consumes the durable FIFO through authenticated API requests. When
idle, it puts a synthetic job into the same queue. It appends at most one ledger
entry per second, allocating the next sequence under a PostgreSQL transaction
lock from the last committed row. `synchronous_commit=on` and a completed `COMMIT`
precede acknowledgment. Job IDs are idempotent; a conflicting payload fails with
409. Rollback leaves no sequence gap. The existing limits are 1 KiB per payload
and 10,000 ledger entries; writes stop loudly on failure rather than prune history.
Actual host storage/WAL accounting and the campaign's 64 MiB execution envelope
still require live measurement; these local tests do not prove a disk quota.

After committing, the worker asks API to complete a one-entry batch. API reads
the committed row, writes deterministic JSON bytes to a reserved temporary file,
fsyncs, atomically renames to `00001.json` (and so on), fsyncs the directory, and
records the file hash in another acknowledged transaction. A restart/retry
reconciles the file from the committed row, including interrupted temporary writes
or renames. Existing files with different bytes fail and remain untouched. The
worker stops on a flow failure and reports unavailable readiness; restart it after
the dependency is repaired to retry the pending job. No running service uses the
in-memory stand-in, and no initialization deletes or migrates existing state.

All `/internal/*` API routes require `Authorization: Bearer <EXAMPLE_TOKEN>` on
9090. Invalid credentials receive 401 without being echoed. Public application
listeners exclude every internal and management route. API rejects secret-bearing
job content before storage. Tests use a generated canary credential and check
authentication failures, dependency errors, responses, and file bytes for leakage.
No request headers, raw SQL errors, or binding values are logged.

Private `GET /health/live`, `/health/ready`, and `/version` exist on every Node
service. Version reports service, application version, and source revision; release
evidence binds the image digest. API readiness probes the PostgreSQL schema and
configured files directory; worker probes PostgreSQL plus API readiness and
credential acceptance; web probes API readiness and identity. A failed dependency
returns 503 while liveness remains 200. Readiness alone does not prove useful work.

## Complete-prefix restore oracle

On the private API listener, authenticated `POST /internal/checkpoint` takes
`{ "runId": "run-1", "imageDigest": "sha256:<64 hex digits>", "targetScope": "source-copy" }`.
Supply the actual observed digest and target scope, not that explanatory
placeholder. The endpoint holds the same transaction lock as the ordered writer,
drains all committed rows' file completions, verifies the full row/hash chain and
file set, and returns a manifest only after commit. It includes checkpoint ID,
run ID, time, source revision, supplied image identity/scope, common watermark W,
every ordered row, every file's name/hash/size, and `held: true|false`.
The optional `hold` field must be a boolean and defaults to false. Without a
hold, writers resume when the lock releases. Queue state is not the
committed-prefix oracle.

For a consistent platform capture, use this exact sequence:

1. **Hold:** call checkpoint with `"hold": true` and retain the manifest outside
   the protected state. In the same database transaction, the API records
   `checkpointId` and `held_at` in the singleton `ledger_hold` table.
2. **Platform fence/capture:** fence both API and worker writers (for example,
   scale both to zero), then capture the protected database and files.
3. **Platform unfence:** restore the API and worker's availability.
4. **Release:** authenticated `POST /internal/checkpoint/release` with
   `{ "checkpointId": "<holding checkpoint ID>" }` deletes that hold and returns
   `{ "checkpointId": "<holding checkpoint ID>", "refusedWrites": 3 }` (example count).

Every API enqueue, completion, checkpoint file write, and worker direct ledger
transaction checks the shared hold under the transaction lock before writing.
Refused API writes return 423 with
`{ "error": "EXAMPLE_FROZEN", "checkpointId": "<holding checkpoint ID>" }`.
The worker treats HTTP 423 and database holds as transient, retaining queued
work and retrying after its existing one-second loop delay. A second hold returns
409 with the holding checkpoint ID. Refusals, including second holds, increment
the durable hold counter; reads, restore verification, and invalid release
attempts do not. Release with a different ID returns 409 naming the holding ID;
release without an active hold returns 409 `EXAMPLE_NOT_FROZEN`.

**Restart does not clear a hold.** A platform that never calls release cannot
rely on process restart: the platform or an operator must call release. Reads
and `/internal/restore` work while held, including on a restored physical database
that contains the hold. `ledger_hold` is operational state excluded from ledger
manifests, like the other operational records. A restore path starting from only
manifest ledger data has no hold; a physical database capture can retain it.

Retain that response **outside** the protected database and files volume as the
independent expected manifest. After release (if held), commit additional jobs to
make the selected boundary observable. Using an independently approved protection
mechanism, restore both database and files to an isolated destination with no
worker and no public hostname. This slice does not copy a live database or choose
a backup mechanism. Send the retained manifest to authenticated
`POST /internal/restore` on the restored API's private listener.

A 200 response with `status: "complete-prefix"` means exactly rows 1..W match the
independent ordered payload/hash chain and every expected file's bytes/hash, with
no extra ledger rows or files. The exact reserved fault filenames described below
are operational records and are excluded from ledger manifests. It reports checkpoint ID, selected and observed watermarks,
and verification duration in milliseconds. A missing middle row, altered payload,
wrong/missing file, unexpected file, or post-barrier row returns 409. Verification
is read-only; it does not repair the restored copy or discard failed evidence.
Verification duration is not restore duration or an RTO promise. Actual restore
start/end times and capability-specific RPO/RTO evidence belong to the later
campaign. Local persistence alone proves neither consistent backup nor off-site
protection.

## Private failure switches

Only the internal listener on **9090** accepts `GET /faults`, `POST /faults`, and
`POST /faults/reset`. Application ports return 404 even with a valid credential.
All three operations require `Authorization: Bearer <EXAMPLE_TOKEN>`; missing or
wrong credentials return 401 and emit `fault-denied` without recording headers,
submitted content, or credentials. Authenticated status includes the latest denial.
Pass credentials from the approved environment/secret binding in memory, never in
command arguments, request URLs, evidence files, or copied examples.

Every POST requires these nonsecret metadata fields in its JSON body:
`actor`, `runId`, `operationId`, `targetScope`, `imageDigest`, and `expiresAt`.
Identifiers use 1–128 ASCII letters, digits, underscores, periods, colons, or
hyphens; the image digest is `sha256:` followed by 64 lowercase hex digits.
`expiresAt` is an absolute date/time strictly in the future and at most five
minutes away. Use a new operation ID per set/reset. Missing/expired metadata,
secret-bearing content, or out-of-bound parameters returns 400. Reset requires
fresh metadata, including its own actor and expiration. Actor is the authenticated
holder's **declared label**, not independently verified individual identity: all
holders share the same secret. Do not use the token or its hash as the actor.

For example, after adding the required metadata in memory, the set payloads are:

| Fault | Additional fields | Observable symptom and reset |
| --- | --- | --- |
| All services: `latency` | `ms`: integer 1–2000 | Application responses (including errors) and worker iterations wait that many milliseconds. Readiness returns 503 with `fault:latency`; liveness, version, status, and reset remain responsive. Reset stops future delays; an already waiting request completes its bounded delay. |
| All services: `crash` | `mode`: `immediate` or `next-request` | Exit code 1 once, after the set response or on the next application request/worker iteration. Armed readiness reports `fault:crash`. Probes and fault controls do not trigger the exit. Reset can disarm next-request mode. The switch is not rearmed after restart. |
| All services: `crash-loop` | `starts`: integer 1–3 | Exactly that many injected exits including the arming process, followed by a healthy start if dependencies are healthy. A persisted counter decreases before each subsequent exit. Expiration also ends the loop. Readiness reports `fault:crash-loop` while armed; the completed reset remains in status after restart. |
| API: `database-down` | None | Refuses new API store operations before using the pool with HTTP 503 and `EXAMPLE_DATABASE_DOWN`; readiness names the same reason. Existing transactions may finish. Reset restores pool access without stopping PostgreSQL or changing rows. |
| API: `disk-full` | `bytes`: positive integer no greater than `FAULT_FILL_CAP_BYTES` | Physically writes zero-filled chunks of at most 1 MiB to `.fault-api.fill`. Status reports requested/written bytes; readiness reports `fault:disk-full`. Reset removes only that filler and restores baseline readiness. |

This disk fault **simulates pressure on the shared volume; it does not claim quota
isolation or real ENOSPC**. Available space is checked before filling and before
every chunk against the explicitly bound floor. Other writers can consume space
between checks; this is not a filesystem quota or a guarantee of remaining host
capacity. The hard fill ceiling is 64 MiB. Floor/write refusal returns 503 with a
named error and a resettable `fault:disk-full:fill-failed` symptom, retaining any
partial filler until reset/expiration. No sparse truncate is used. Never infer a
full physical disk from the declared fault. The campaign must independently
measure storage and the application's behavior.

One active fault per service is allowed; set during an active fault returns 409.
Concurrent mutations return 409 while one mutation is in progress. Leases reset
automatically while the process runs; persisted disk/loop leases are checked
before serving after restart. No external controller is required. Compose uses
`restart: unless-stopped` for each Node service; injected loops terminate through
the counter, not through an assumed retry limit in that policy. Daisy deployments
use the platform restart policy. Capture the platform's actual restart count,
exit code, and logs; an exited process cannot answer health, and a recovered
process honestly reports its current dependency health rather than stale failure.

Every set/reset emits JSON log evidence with service, source revision, actor,
run, operation, scope, supplied image digest, timestamps, parameters, and lease.
`GET /faults` returns active state, the latest set/reset, and the latest denial.
Reset retains the original set metadata plus `resetActor`, `resetContext`,
`resetAt`, and `reason`. Status is a bounded snapshot, not an audit-history API;
retain service log evidence under the campaign's approved retention policy.
No new log-retention policy is selected here.

The volume reserves `.fault-web.json`, `.fault-api.json`, `.fault-worker.json`,
their `.tmp` atomic-write files, and `.fault-api.fill`. Each record is at most
8192 bytes; records are replaced, not appended. Only disk/loop **active** state
survives restart; transient set/reset audit evidence survives without rearming
its switch. Ledger manifests exclude exactly these names and continue rejecting
all other unexpected files. Do not store application data under reserved names.
Existing malformed records, invalid counters, symlinks, or unowned filler cause
specific startup failure; they are not erased or silently treated as no fault.
Reset never touches another service's record or any ledger file. After a crash
interrupted filling, API reconciles the bounded filler length and exposes it for
reset. Keep normal data, failed evidence, and the approved original restore copy.

After reset, the campaign must check status has no active fault, readiness,
measured latency or writes, and the expected ledger/file prefix. Apply a separate
five-second reset-verification deadline; failure stops the campaign and records
the exact residual fault, never success. The worker's existing stop-on-flow-error
contract remains: if an API/database fault stopped its writer, restart that worker
after API recovery and verify queued work completes. No campaign driver is
implemented in this slice.

### Certificate-near-expiry campaign fixture

The app has no TLS adapter, so it cannot safely present this fault internally.
The campaign must use a **dedicated private TLS fixture**, with these explicit
steps and inputs; without an approved fixture mechanism, record this stage as
blocked (`certificate-fixture-unavailable`), never pass or emulate a certificate
with JSON health data:

1. Obtain authorization for a fixture-only hostname, private listener/port,
   certificate issuer/trust anchor, warning window, reset certificate, fixture
   owner, and evidence-retention policy. Verify the endpoint is not a shared or
   production certificate target and that Daisy can reach it privately.
2. Have the approved issuer create a real certificate for that hostname whose
   `notBefore` is already valid and whose `notAfter` is in the configured warning
   window. Keep its private key in approved secret custody and inject it directly
   into the fixture's memory through a secure binding/stdin; never include keys
   in repository files, campaign evidence, logs, or command arguments. This slice
   does not choose or install a TLS server/adapter.
3. Present that certificate on the isolated TLS listener. Supply Daisy with the
   hostname, port, target scope, and approved fixture trust anchor. Require an
   actual TLS handshake with hostname SNI and certificate-chain/hostname
   verification, then capture the observed serial/fingerprint and `notAfter`,
   observation time, warning-window comparison, run, operation, revision, and
   fixture identity. Declaring a fault is not evidence of observed expiry.
4. Reset by presenting the approved baseline certificate with `notAfter` beyond
   the warning window, then repeat the verified handshake and expiry measurement.
   Record set/reset actors and times in the fixture's own logs and campaign
   evidence. Use a lease of at most five minutes and the separate five-second
   reset-verification deadline; stop with the exact residual fixture if reset
   cannot be verified.
5. Never alter host time, trust settings shared with other workloads, public
   routing, production certificates, or sibling services. Retain evidence and
   release only the authorized fixture resources under its owner's policy.

Live TLS evidence, campaign drivers, upgrade/binding custody, and actual recovery
remain later work.

## Publish a reviewed revision

Publication authority into the personal `witnium` GHCR namespace is recorded in
`.pm/decisions.md` and `.pm/stack.md`. Configure the repository Actions secret
`GHCR_PUBLISH_TOKEN` for username `witnium`, with package publishing authority.
The workflow fails by name if the secret is missing. It passes the secret only
to Docker login over stdin, uses an isolated temporary Docker credential directory,
and logs out and removes that directory afterward. No credential is a build argument
or release asset. The repository's `GITHUB_TOKEN` uses the workflow's
`contents: write` permission to create the release and commit Compose to `main`.
No registry password is reused for GitHub operations.

1. Review the commit, then dispatch **Publish reviewed images** on that revision.
   CI checks out the exact dispatch SHA, installs the lockfile and runs `npm test`.
2. CI builds web, API and worker for Linux amd64/arm64 and publishes
   `ghcr.io/witnium/daisy-example-{web,api,worker}`. It also packages the digest-pinned
   upstream PostgreSQL image as `ghcr.io/witnium/daisy-example-postgres`.
   Deployments reference this GHCR mirror only, never Docker Hub. Commit-SHA tags
   are publication handles; deployment artifacts contain only `@sha256:` digests.
3. The owner must set **web, API and PostgreSQL public; worker private** once in
   each package's settings. Newly created packages may start private, causing the
   first run to fail intentionally. CI fetches manifests without publisher credentials,
   negotiates GHCR's anonymous bearer-token challenge, and checks exact status codes.
   A mismatch names the package and its settings URL. Fix visibility and rerun.
   A 404 or registry failure is never accepted as private-image evidence.
4. Only after those checks succeed, CI creates release `images-<full-source-SHA>`
   with `docker-compose.yaml`, `images.json` (source-to-digest mapping), and
   `visibility.json` (observed anonymous statuses). Existing release assets are
   not overwritten.
5. After successful release creation, CI commits the exact generated artifact bytes
   to `docker-compose.yaml` at the repository root on `main`. The commit convention
   is `publish: pin images web=<12 hex digits> api=<12 hex digits> worker=<12 hex digits> postgres=<12 hex digits>`.
   Unchanged content skips the commit. The workflow remains `workflow_dispatch`
   only, so this commit does not trigger another publish. The update starts from
   the current `main`; a concurrent update or denied push fails without force-pushing.

The checked-in `docker-compose.yaml` is the artifact for **repository-source intake**:
use `composePath: "docker-compose.yaml"` and pin the exact `publish: pin images`
commit. The file becomes available after a successful publish; no placeholder
digests are checked in beforehand. The **release asset** remains available too.
Download `docker-compose.yaml` from the reviewed release and collect with
`source: {kind: "compose-file", path: <absolute downloaded path>, name: "daisy-example"}`.
The file is generated from all four Buildx result digests and validated against
the exact specification shape. The generator fails on missing metadata; it does
not guess image tags or add unsupported fields. It can be run explicitly as
`SOURCE_REVISION=<full-SHA> npm run compose:generate -- <metadata-directory>`.

The image source revision is the reviewed dispatch SHA, while repository intake
pins the subsequent Compose commit. A local-file collection has null repository
revision; retain `images.json` with the artifact as separate source
evidence. Select `applicationName: "daisy-example"`, `primaryService: "web"`,
`primaryPort: "8080"`, and explicitly approved hostname/exposure configuration.

The full fixture intentionally remains refused by today's Daisy intake:
`postgresql-transition-unresolved` / `database-transition-unsupported` and
`configuration-binding-unavailable:<service>`. Named-volume acknowledgment can
yield `persistent-data-local-only`; it cannot clear the independent refusals or
prove backup/restore. Do not remove PostgreSQL, configuration keys, or volumes
to relabel the full application as supported. Live retention policy and recovery
authority remain prerequisites for later slices.
