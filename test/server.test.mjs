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
