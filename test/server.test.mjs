import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const token = 'rcc_' + Buffer.from(JSON.stringify({ u: 'https://connect.example.test/v1/', k: 'rc_aaaaaaaaaaaaaaaaaaaa', s: 'secret-123' })).toString('base64url');
process.env.REACTLL_CONNECT_TOKEN = token;
const { submitLead, submitLeadFromFormData, GET, credentials } = await import('../dist/server.js');

test('the token gives endpoint, key and secret', () => {
  assert.deepEqual(credentials(), { u: 'https://connect.example.test/v1', k: 'rc_aaaaaaaaaaaaaaaaaaaa', s: 'secret-123' });
  assert.equal(credentials('nope'), null);
});

test('a lead is signed, cleaned and tied to its page view', async () => {
  let sent;
  globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response('{"ok":true}', { status: 201 }); };
  const data = new FormData();
  data.set('name', 'Ayla'); data.set('email', 'ayla@example.test'); data.set('password', 'x');
  data.set('_rc_pv', '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9');

  assert.equal(await submitLeadFromFormData('Contact', data, { headers: new Headers({ referer: 'https://site.test/contact' }) }), true);
  assert.equal(sent.url, 'https://connect.example.test/v1/submissions');
  const body = JSON.parse(sent.init.body);
  assert.deepEqual(body.fields, { name: 'Ayla', email: 'ayla@example.test' });
  assert.equal(body.pv, '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9');
  assert.equal(body.page, 'https://site.test/contact');
  const h = sent.init.headers;
  assert.equal(h['X-Reactll-Signature'], createHmac('sha256', 'secret-123').update(`${h['X-Reactll-Timestamp']}.${sent.init.body}`).digest('hex'));
});

test('an unreachable Reactll never throws', async () => {
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal(await submitLead('Contact', { email: 'a@b.test' }), false);
});

test('the health check answers only a signed Reactll request', async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', 'secret-123').update(`${ts}.health`).digest('hex');
  const ok = await GET(new Request('https://site.test/api/reactll/health', { headers: { 'x-reactll-timestamp': ts, 'x-reactll-signature': sig } }));
  assert.equal(ok.status, 200);
  const json = await ok.json();
  assert.equal(json.platform, 'next');
  assert.ok(json.runtime.node);

  const bad = await GET(new Request('https://site.test/api/reactll/health', { headers: { 'x-reactll-timestamp': ts, 'x-reactll-signature': 'f'.repeat(64) } }));
  assert.equal(bad.status, 401);
});

test('a script tag for any template, with only the public key', async () => {
  const { scriptTag } = await import('../dist/server.js');
  assert.equal(scriptTag(), '<script src="https://connect.example.test/v1/c.js" data-site="rc_aaaaaaaaaaaaaaaaaaaa" defer></script>');
  assert.equal(scriptTag('nope'), '');
});

test('express / node:http middleware answers signed health and passes everything else on', async () => {
  const { expressHealth } = await import('../dist/server.js');
  const http = await import('node:http');
  const mw = expressHealth();
  const server = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 204; res.end(); }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (await import('node:http')) && globalThis.__realFetch ? globalThis.__realFetch : globalThis.fetch;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', 'secret-123').update(`${ts}.health`).digest('hex');
  const get = (path, headers = {}) => new Promise((resolve) => http.get(base + path, { headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }));

  const ok = await get('/api/reactll/health', { 'x-reactll-timestamp': ts, 'x-reactll-signature': sig });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).platform === 'next' || JSON.parse(ok.body).platform === 'node', true);
  assert.equal((await get('/api/reactll/health')).status, 401);
  assert.equal((await get('/somewhere-else')).status, 204);
  server.close();
});
