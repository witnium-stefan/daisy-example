import { configuration, handler, httpReady, listen, apiRequest, body, send } from '../common.mjs';

export function createWeb(env, dependencies) {
  const config = configuration('web', env);
  const management = handler('web', config, dependencies);
  return async (req, res) => {
    if (['/health/live', '/health/ready', '/version'].includes(req.url)) return management(req, res);
    try {
      if (req.method === 'GET' && req.url === '/') {
        const answer = await apiRequest(config, '/ledger');
        // Text nodes preserve the exact API answer without interpreting payload HTML.
        const data = JSON.stringify({ message: config.message, ...answer }).replaceAll('<', '\\u003c');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Daisy example</title><h1 id="message"></h1><form id="job"><label>Job ID <input name="id" required maxlength="128"></label><label>Payload <input name="payload" required></label><button>Submit</button></form><pre id="result"></pre><pre id="ledger"></pre><script>const data=${data};document.querySelector('#message').textContent=data.message;document.querySelector('#ledger').textContent=JSON.stringify(data.rows,null,2);document.querySelector('#job').onsubmit=async event=>{event.preventDefault();const response=await fetch('/jobs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});document.querySelector('#result').textContent=await response.text();};</script></html>`);
        return;
      }
      if (req.method === 'POST' && req.url === '/jobs') {
        let job;
        try { job = await body(req); } catch { return send(res, 400, { error: 'Invalid job' }); }
        return send(res, 202, await apiRequest(config, '/jobs', { method: 'POST', body: JSON.stringify(job) }));
      }
      if (req.method === 'GET' && ['/ledger', '/files'].includes(req.url)) return send(res, 200, await apiRequest(config, req.url));
      return send(res, 404, { error: 'not-found' });
    } catch { return send(res, 503, { error: 'Web API dependency unavailable' }); }
  };
}

if (import.meta.main) {
  try {
    const config = configuration('web', process.env);
    listen('web', 8080, createWeb(process.env, { api: () => httpReady(new URL('/health/ready', config.apiUrl), 'api') }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
