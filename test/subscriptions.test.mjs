import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const SECRET = 'secret-123';
process.env.REACTLL_CONNECT_TOKEN = 'rcc_' + Buffer.from(JSON.stringify({ u: 'https://connect.example.test/v1/', k: 'rc_aaaaaaaaaaaaaaaaaaaa', s: SECRET })).toString('base64url');
process.env.REACTLL_CONNECT_SITE_URL = 'https://shop.example.test';
const { sendSubscriptions, normaliseSubscription, fromStripeSubscription, sendOrders } = await import('../dist/server.js');

const hmac = (s) => createHmac('sha256', SECRET).update(s).digest('hex');
let calls;
const answer = (fn) => { globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return fn(calls.length); }; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sub = (o = {}) => ({
  id: 'sub_1', plan: 'Pro · Monthly', status: 'active', currency: 'usd', amount: 9.99, interval: 'monthly',
  started_at: new Date('2026-09-01T10:00:00Z'), updated_at: new Date('2026-10-01T10:00:00Z'),
  email: ' Ana@Example.TEST ', customer: { name: 'ana ruiz', country: 'us', phone: '555' }, ...o,
});

beforeEach(() => { calls = []; delete process.env.REACTLL_CONNECT_SALES; });

test('a subscription is normalised and the email never leaves the app', () => {
  const s = normaliseSubscription(sub(), SECRET);
  assert.deepEqual([s.id, s.status, s.currency, s.amount, s.interval, s.interval_count, s.quantity], ['sub_1', 'active', 'USD', '9.99', 'month', 1, 1]);
  assert.deepEqual(s.customer, { label: 'Ana R.', country: 'US', key: hmac('ana@example.test') });
  assert.equal(s.updated_at, '2026-10-01T10:00:00+00:00');
  assert.ok(!JSON.stringify(s).includes('Example') && !JSON.stringify(s).includes('555'));
  assert.equal(normaliseSubscription(sub({ status: 'cancelled' }), SECRET).status, 'canceled');
  assert.equal(normaliseSubscription(sub({ status: 'unpaid' }), SECRET).status, 'past_due');
  assert.equal(normaliseSubscription(sub({ status: 'weird' }), SECRET), null);
  assert.equal(normaliseSubscription(sub({ amount: null }), SECRET), null);
  assert.equal(normaliseSubscription(sub({ email: null, customer_id: 'User-7' }), SECRET).customer.key, hmac('id:user-7'));
});

test('subscriptions are signed and posted; the invalid one is skipped', async () => {
  answer(() => json({ ok: true, stored: 1, updated: 0, skipped: 0, sales_allowed: true }));
  const r = await sendSubscriptions([sub(), { id: 'bad' }]);
  assert.equal(r.ok, true);
  assert.deepEqual([r.stored, r.skipped], [1, 1]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/subscriptions$/);
  assert.ok(calls[0].init.headers['X-Reactll-Signature']);
  assert.equal(calls[0].body.subscriptions[0].id, 'sub_1');
  assert.equal(calls[0].body.site_url, 'https://shop.example.test');
});

test('an order can carry its subscription, with the order\'s currency and customer', async () => {
  answer(() => json({ ok: true, stored: 1, updated: 0, deleted: 0, skipped: 0, sales_allowed: true }));
  await sendOrders({ id: 'in_1', currency: 'USD', total: 9.99, created_at: new Date(), created_via: 'subscription', email: 'ana@example.test',
    subscription: { id: 'sub_1', status: 'active', amount: 9.99, interval: 'month', updated_at: new Date() } });
  const o = calls[0].body.orders[0];
  assert.equal(o.subscription.id, 'sub_1');
  assert.equal(o.subscription.currency, 'USD');
  assert.equal(o.subscription.customer.key, o.customer.key);
});

test('a Stripe subscription maps to the contract', () => {
  const s = fromStripeSubscription({ id: 'sub_9', object: 'subscription', status: 'active', start_date: 1759312800, cancel_at: 1762000000, canceled_at: 1760000000,
    items: { data: [{ quantity: 3, current_period_end: 1762000000, price: { unit_amount: 2900, currency: 'eur', nickname: 'Team', recurring: { interval: 'year', interval_count: 1 } } }] } },
  { email: 'team@example.test' });
  assert.deepEqual([s.id, s.plan, s.currency, s.amount, s.interval, s.quantity], ['sub_9', 'Team', 'EUR', '29.00', 'year', 3]);
  assert.ok(s.ends_at && s.customer.key);
  assert.equal(fromStripeSubscription({ object: 'invoice', id: 'in_1' }), null);
});

test('switched off sends nothing', async () => {
  answer(() => json({}));
  process.env.REACTLL_CONNECT_SALES = 'false';
  const r = await sendSubscriptions([sub()]);
  assert.equal(r.reason, 'switched_off');
  assert.equal(calls.length, 0);
});
