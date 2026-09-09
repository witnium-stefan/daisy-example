import { readFile } from 'node:fs/promises';
import { services, validateDigests } from './compose.mjs';

const accept = 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json';

export async function anonymousManifest(name, digest, request = fetch) {
  const url = `https://ghcr.io/v2/witnium/daisy-example-${name}/manifests/${digest}`;
  const options = { headers: { accept }, redirect: 'error', signal: AbortSignal.timeout(10000) };
  let response = await request(url, options);
  if (response.status !== 401) return response.status;
  // GHCR challenges anonymous readers even for public packages. Request an
  // anonymous bearer token, never the publisher's token or Docker credentials.
  const challenge = response.headers.get('www-authenticate') ?? '';
  if (!/^Bearer /i.test(challenge) || !challenge.includes('realm="https://ghcr.io/token"')) {
    throw new Error('Unexpected GHCR authentication challenge');
  }
  const tokenUrl = new URL('https://ghcr.io/token');
  tokenUrl.searchParams.set('service', 'ghcr.io');
  tokenUrl.searchParams.set('scope', `repository:witnium/daisy-example-${name}:pull`);
  const tokenResponse = await request(tokenUrl.href, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  // An anonymous token denial leaves the manifest's measured 401 in effect.
  if ([401, 403].includes(tokenResponse.status)) return response.status;
  if (tokenResponse.status !== 200) throw new Error(`Anonymous token request returned ${tokenResponse.status}`);
  const body = await tokenResponse.json();
  if (typeof body.token !== 'string' || !body.token) throw new Error('Missing anonymous GHCR token');
  response = await request(url, { ...options, signal: AbortSignal.timeout(10000), headers: { accept, authorization: `Bearer ${body.token}` } });
  return response.status;
}

export async function verifyVisibility(digests, request = fetch) {
  validateDigests(digests);
  const results = {};
  for (const name of services) {
    const packageName = `daisy-example-${name}`;
    const settings = `https://github.com/users/witnium/packages/container/${packageName}/settings`;
    let status;
    try { status = await anonymousManifest(name, digests[name], request); }
    catch { throw new Error(`${packageName}: anonymous manifest verification failed; inspect ${settings}`); }
    const expected = name === 'worker' ? [401, 403] : [200];
    if (!expected.includes(status)) {
      throw new Error(`${packageName}: anonymous manifest returned ${status}; expected ${expected.join('/')}. Owner must set ${name === 'worker' ? 'private' : 'public'} visibility at ${settings}`);
    }
    results[name] = status;
  }
  return results;
}

if (import.meta.main) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-visibility.mjs <images.json>');
  const { digests } = JSON.parse(await readFile(process.argv[2], 'utf8'));
  console.log(JSON.stringify(await verifyVisibility(digests)));
}
