import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const token = process.env.AGENT_DEVICE_DAEMON_AUTH_TOKEN ?? '';
const starts = process.env.FAKE_AGENT_DEVICE_STARTS;
const firstStart = starts === undefined || !existsSync(starts) || readFileSync(starts, 'utf8') === '';
if (starts !== undefined) appendFileSync(starts, 'start\n');
const diesAfterMs = firstStart && process.env.FAKE_AGENT_DEVICE_DIES_AFTER_MS !== undefined ? Number(process.env.FAKE_AGENT_DEVICE_DIES_AFTER_MS) : null;
const startedAt = Date.now();
console.log(`Daemon auth token: ${token}`);
http
  .createServer((req, res) => {
    if (diesAfterMs !== null && Date.now() - startedAt >= diesAfterMs) {
      res.writeHead(req.url === '/health' ? 200 : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'fetch failed' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, authorized: req.headers.authorization === `Bearer ${token}` }));
  })
  .listen(port, '127.0.0.1');
