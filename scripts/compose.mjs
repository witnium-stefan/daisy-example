import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const services = ['web', 'api', 'worker', 'postgres'];
export function validateDigests(digests) {
  if (!digests || Object.keys(digests).sort().join(',') !== [...services].sort().join(',')) {
    throw new Error('Expected exactly web, api, worker, postgres digests');
  }
  for (const name of services) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digests[name])) throw new Error(`Missing or invalid image digest: ${name}`);
  }
}

export function compose(digests) {
  validateDigests(digests);
  return `name: daisy-example
services:
  web:
    image: ghcr.io/witnium/daisy-example-web@${digests.web}
    ports: ["8080"]
    depends_on: [api]
    environment: [EXAMPLE_MESSAGE, API_URL]
  api:
    image: ghcr.io/witnium/daisy-example-api@${digests.api}
    ports: ["8081"]
    depends_on: [postgres]
    environment: [DATABASE_URL, EXAMPLE_TOKEN, FILES_PATH]
    volumes: ["files:/data"]
  worker:
    image: ghcr.io/witnium/daisy-example-worker@${digests.worker}
    ports: ["8082"]
    depends_on: [api, postgres]
    environment: [DATABASE_URL, EXAMPLE_TOKEN, API_URL]
    volumes: ["files:/data"]
  postgres:
    image: ghcr.io/witnium/daisy-example-postgres@${digests.postgres}
    ports: ["5432"]
    environment: [POSTGRES_PASSWORD]
    volumes: ["database:/var/lib/postgresql/data"]
volumes:
  files: {}
  database: {}
`;
}

// Validate the canonical generated artifact, not arbitrary user-authored YAML.
// Rebuilding it enforces every accepted key and prevents extra YAML documents,
// duplicate keys, values in environment lists, interpolation, or build directives.
export function validateCompose(source) {
  const images = [...source.matchAll(/^    image: ghcr\.io\/witnium\/daisy-example-(web|api|worker|postgres)@(sha256:[a-f0-9]{64})$/gm)];
  if (images.length !== 4) throw new Error('Compose must contain four digest-only GHCR images');
  const digests = Object.fromEntries(images.map(([, name, digest]) => [name, digest]));
  if (source !== compose(digests)) throw new Error('Compose does not match the accepted fixture shape');
  return digests;
}

export async function generate(directory, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Missing or invalid SOURCE_REVISION');
  const digests = {};
  for (const name of services) {
    const metadata = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'));
    digests[name] = metadata['containerimage.digest'];
  }
  const source = compose(digests);
  validateCompose(source);
  await writeFile(join(directory, 'docker-compose.yaml'), source, { flag: 'wx' });
  await writeFile(join(directory, 'images.json'), JSON.stringify({ sourceRevision: revision, digests }, null, 2) + '\n', { flag: 'wx' });
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/compose.mjs <metadata-directory>');
  await generate(process.argv[2], process.env.SOURCE_REVISION);
}
