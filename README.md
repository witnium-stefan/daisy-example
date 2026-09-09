# daisy-example

Synthetic application for Opsie Daisy's operational acceptance examples. The
reviewed specification is `docs/architecture/example-application.md` in
`witnium-stefan/opsie-daisy-repo`. This repository implements slice 1, Repository
and CI. It does not claim a live deployment or successful restore.

## Local development

Use Node 24 and install the locked dependencies:

```sh
fnm exec --using 24 -- npm ci --ignore-scripts
fnm exec --using 24 -- npm test
```

Tests use Node's standard test runner, fake registry responses and an in-memory
transaction store. They need neither Docker nor credentials and never push images.
They cover all three services' health/version handlers, configuration failures,
dependency failures, ledger ordering, hash chains, idempotency and rollback, and
the exact generated Compose grammar. Heavy integration, e2e, demo, rehearsal and
full CI gates are **DEFERRED** to the runbook after the build, not reported as passing.

The only runtime dependency is `pg@8.16.3`, published June 27, 2025. The lockfile
was resolved with `--before=2026-08-26`, enforcing the 14-day release quarantine
as of September 9, 2026 for transitive dependencies too. Dependency updates must
repeat that age check. Web uses only the standard library. Node 24.7.0 and
PostgreSQL 17.6 bookworm base images are pinned to verified upstream OCI digests
in their Dockerfiles. Builds use the repository root as context.

Run a service with `node services/web/main.mjs`, `node services/api/main.mjs`, or
`node services/worker/main.mjs` after supplying its required environment through
an approved binding. `SOURCE_REVISION` must be a full 40-character Git SHA; CI
bakes it into each Node image. Web also requires `EXAMPLE_MESSAGE`; API and
worker require `DATABASE_URL` (including the database name) and
`EXAMPLE_SHARED_SECRET`. Missing or malformed configuration fails startup with
the key's name, without printing its value. The shared credential's request
authentication belongs to slice 2; there are no private work submission routes yet.
Never put credentials in source, command arguments, test output, or checked-in files.

Application ports are web 8080, API 8081 and worker 8082. Each process also has an
internal management listener on port 9090, excluded from Compose's advertised
ports and public application routing. Keep that listener on the private service
network; do not publish it or route a public hostname to it. When running several
processes locally, use separate network namespaces or run one at a time.

| Aspect | Slice 1 evidence and boundary |
| --- | --- |
| Health and version | Private `:9090/health/live`, `/health/ready`, `/version` on every Node service. Version reports service, application version and source revision; release evidence supplies image digests. Application ingress returns 404 for management paths. |
| Dependencies | Web readiness checks API identity/readiness; API queries PostgreSQL with `SELECT 1`; worker checks API, PostgreSQL and read/write access to `/data`. Failure returns 503 while liveness remains 200. Readiness does not prove useful work. |
| Configuration | Web `/` returns the bound nonsecret `EXAMPLE_MESSAGE`. Compose carries key names only, including PostgreSQL's required `POSTGRES_PASSWORD`. |
| Web → API → worker and real writes | Ordered worker ledger core is tested against an in-memory transaction stand-in. Live queue/SQL commit acknowledgment and second-session readback are slice 2. No volatile store is used by a running service. |
| State and files | Ledger test fixtures assert contiguous committed sequences, idempotent job IDs, payload hashes and previous-row hashes. Failed commits leave no gap. Payloads are bounded to 1 KiB and the ledger to 10,000 entries. Separate `database` and `files` named volumes preserve the planned mount contract. Durable files, storage usage bounds and barriers are slice 2; nothing prunes or migrates state. |
| Public/private packages | CI requires anonymous manifest 200 for web, API and PostgreSQL; worker must deny anonymous reads with 401/403. Publishing uses scoped repository-secret authority. |
| Hostnames and TLS | Later live work must record allocated hostname/zone/account, installed target and reviewed certificate-fixture mechanism, then distinguish origin identity from DNS/edge and independent external reachability. |
| Failures, restore and upgrade | No failure switches or campaign exist in this slice. Future faults require private scoped authorization and independent reset. Restore requires the complete common watermark prefix plus matching durable files; readiness and maximum sequence alone are insufficient. Version upgrades must retain committed data and binding custody. |

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
