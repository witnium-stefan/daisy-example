# daisy-example

Synthetic application for Opsie Daisy's operational acceptance examples. The
reviewed specification is `docs/architecture/example-application.md` in
`witnium-stefan/opsie-daisy-repo`. This repository implements slices 1 and 2: Repository and CI, and Services and
state. Local fixture tests are not evidence of a live deployment, database-server
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
| All Node services | `SOURCE_REVISION`: full 40-character Git SHA, baked into published images. |
| Web | `EXAMPLE_MESSAGE`: visible nonsecret message; `API_URL`: internal API HTTP origin. |
| API | `DATABASE_URL`: PostgreSQL URL including database name; `EXAMPLE_TOKEN`: worker credential; `FILES_PATH`: absolute existing writable mounted directory. |
| Worker | `DATABASE_URL`, the same `EXAMPLE_TOKEN`, and `API_URL`. |
| PostgreSQL | `POSTGRES_PASSWORD` through its approved binding. |

For the Compose topology, explicitly bind `API_URL` to `http://api:9090` and
`FILES_PATH` to `/data`. These are deployment bindings, never runtime defaults.
The existing `files` named volume is also mounted on the API, which performs the
file writes requested by the worker. The worker mount and `database` volume are
preserved; no data is moved or erased.
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
every ordered row, and every file's name/hash/size. Writers resume when the lock
is released. New submissions can wait for the barrier; queue state is not the
committed-prefix oracle.

Retain that response **outside** the protected database and files volume as the
independent expected manifest. Commit additional jobs after the checkpoint to
make the selected boundary observable. Using an independently approved protection
mechanism, restore both database and files to an isolated destination with no
worker and no public hostname. This slice does not copy a live database or choose
a backup mechanism. Send the retained manifest to authenticated
`POST /internal/restore` on the restored API's private listener.

A 200 response with `status: "complete-prefix"` means exactly rows 1..W match the
independent ordered payload/hash chain and every expected file's bytes/hash, with
no extra rows or files. It reports checkpoint ID, selected and observed watermarks,
and verification duration in milliseconds. A missing middle row, altered payload,
wrong/missing file, unexpected file, or post-barrier row returns 409. Verification
is read-only; it does not repair the restored copy or discard failed evidence.
Verification duration is not restore duration or an RTO promise. Actual restore
start/end times and capability-specific RPO/RTO evidence belong to the later
campaign. Local persistence alone proves neither consistent backup nor off-site
protection.

No failure switches, fault campaign, TLS adapter, or deployment capability changes
are included. Authorized fault control, live storage bounds, upgrade/binding
custody, and actual recovery remain later slices.

## Publish a reviewed revision

Publication authority into the personal `witnium` GHCR namespace is recorded in
`.pm/decisions.md` and `.pm/stack.md`. Configure the repository Actions secret
`GHCR_PUBLISH_TOKEN` for username `witnium`, with package publishing authority.
The workflow fails by name if the secret is missing. It passes the secret only
to Docker login over stdin, uses an isolated temporary Docker credential directory,
and logs out and removes that directory afterward. No credential is a build argument
or release asset. The repository's `GITHUB_TOKEN` needs `contents: write` only to
create the release. No registry password is reused for GitHub release creation.

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
   not overwritten. No fabricated deployment digest or executable placeholder
   Compose file is checked into this source repository.

The chosen artifact transport is a **release asset**, not an automatic source
commit. Download `docker-compose.yaml` from the reviewed release and collect with
`source: {kind: "compose-file", path: <absolute downloaded path>, name: "daisy-example"}`.
The file is generated from all four Buildx result digests and validated against
the exact specification shape. The generator fails on missing metadata; it does
not guess image tags or add unsupported fields. It can be run explicitly as
`SOURCE_REVISION=<full-SHA> npm run compose:generate -- <metadata-directory>`.

The same bytes are valid for repository collection if explicitly committed in a
separate reviewed digest update, with `composePath: "docker-compose.yaml"` and its
exact commit. This workflow does not make that update. A local-file collection has
null repository revision; retain `images.json` with the artifact as separate source
evidence. Select `applicationName: "daisy-example"`, `primaryService: "web"`,
`primaryPort: "8080"`, and explicitly approved hostname/exposure configuration.

The full fixture intentionally remains refused by today's Daisy intake:
`postgresql-transition-unresolved` / `database-transition-unsupported` and
`configuration-binding-unavailable:<service>`. Named-volume acknowledgment can
yield `persistent-data-local-only`; it cannot clear the independent refusals or
prove backup/restore. Do not remove PostgreSQL, configuration keys, or volumes
to relabel the full application as supported. Live retention policy and recovery
authority remain prerequisites for later slices.
