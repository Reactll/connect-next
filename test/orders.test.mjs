import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const SECRET = 'secret-123';
const token = 'rcc_' + Buffer.from(JSON.stringify({ u: 'https://connect.example.test/v1/', k: 'rc_aaaaaaaaaaaaaaaaaaaa', s: SECRET })).toString('base64url');
process.env.REACTLL_CONNECT_TOKEN = token;
process.env.REACTLL_CONNECT_SITE_URL = 'https://shop.example.test';
const server = await import('../dist/server.js');
const { sendOrders, deleteOrders, normaliseOrder, fromStripeInvoice, sendLead, submitLead, scriptTag, GET, createHealth } = server;

const hmac = (s) => createHmac('sha256', SECRET).update(s).digest('hex');
let calls;
const answer = (fn) => { globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return fn(calls.length); }; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (extra = {}) => json({ ok: true, stored: 1, updated: 0, deleted: 0, skipped: 0, sales_allowed: true, ...extra });

const order = (o = {}) => ({
  id: 4211,
  status: 'wc-processing',
  currency: 'usd',
  total: 86.4,
  subtotal: '78',
  tax: 6.9,
  discount: 5,
  created_at: new Date('2026-10-14T14:58:02-05:00'),
  email: '  Maria.Lopez@Example.TEST ',
  phone: '+1 504 555 0100',
  address: '1 Royal St',
  customer: { name: 'maria lopez', city: 'New Orleans', country: 'us', postcode: '70130', phone: '555' },
  items: [{ name: 'Shrimp & Grits', quantity: '2', total: 38, sku: 'SG-01', product_id: 88 }],
  ...o,
});

beforeEach(() => {
  calls = [];
  for (const k of ['REACTLL_CONNECT_SALES', 'REACTLL_CONNECT_FORMS', 'REACTLL_CONNECT_VISITORS', 'REACTLL_CONNECT_EVENTS', 'REACTLL_CONNECT_SENDS_LEADS']) delete process.env[k];
});

test('orders are signed and posted with the site url', async () => {
  answer(() => ok());
  const result = await sendOrders(order());
  assert.deepEqual(result, { ok: true, stored: 1, updated: 0, deleted: 0, skipped: 0, salesAllowed: true, reason: null });
  const { url, init, body } = calls[0];
  assert.equal(url, 'https://connect.example.test/v1/orders');
  assert.equal(init.headers['X-Reactll-Key'], 'rc_aaaaaaaaaaaaaaaaaaaa');
  assert.equal(init.headers['X-Reactll-Signature'], hmac(`${init.headers['X-Reactll-Timestamp']}.${init.body}`));
  assert.equal(body.site_url, 'https://shop.example.test');
  assert.equal(body.backfill, false);
});

test('the order is normalised and the email never leaves the app', async () => {
  answer(() => ok());
  await sendOrders([order()]);
  const raw = calls[0].init.body;
  for (const pii of ['maria.lopez', 'Maria.Lopez', '555', 'Royal', '70130']) assert.ok(!raw.includes(pii), pii);
  const o = calls[0].body.orders[0];
  assert.equal(o.id, '4211');
  assert.equal(o.number, '4211');
  assert.equal(o.status, 'processing');
  assert.equal(o.currency, 'USD');
  assert.deepEqual([o.total, o.subtotal, o.tax, o.shipping, o.discount, o.refunded], ['86.40', '78.00', '6.90', '0.00', '5.00', '0.00']);
  assert.equal(o.created_at, '2026-10-14T19:58:02+00:00');
  assert.match(o.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
  assert.equal(o.created_via, 'checkout');
  assert.deepEqual(o.customer, { label: 'Maria L.', city: 'New Orleans', country: 'US', key: hmac('maria.lopez@example.test'), returning: null });
  assert.deepEqual(o.items, [{ name: 'Shrimp & Grits', quantity: 2, total: '38.00', sku: 'SG-01', product_id: '88' }]);
  assert.equal('email' in o || 'phone' in o || 'address' in o, false);
});

test('without an email the customer id is the key, and never sent', () => {
  const o = normaliseOrder(order({ email: null, customer: { name: 'Ayla' }, customer_id: ' Apple-000123.ABC ' }), SECRET);
  assert.equal(o.customer.key, hmac('id:apple-000123.abc'));
  assert.ok(!JSON.stringify(o).includes('000123'));
  assert.equal(normaliseOrder(order({ customer: { user_id: 77, email: 'A@B.test' } }), SECRET).customer.key, hmac('a@b.test'), 'the email wins');
  assert.equal(normaliseOrder(order({ email: null, customer: { user_id: 77 } }), SECRET).customer.key, hmac('id:77'));
});

test('normalising twice changes nothing; invalid orders and drafts are skipped', async () => {
  const once = normaliseOrder(order(), SECRET);
  assert.deepEqual(normaliseOrder(once, SECRET), once);
  assert.equal(normaliseOrder(order({ currency: 'JPY', total: '1500.4' }), SECRET).total, '1500');
  assert.equal(normaliseOrder({ id: '1', currency: 'USD', total: 1 }, SECRET), null);
  assert.equal(normaliseOrder(order({ currency: 'dollars' }), SECRET), null);
  assert.equal(normaliseOrder(order({ total: 'free' }), SECRET), null);

  answer(() => ok());
  const result = await sendOrders([order(), { id: 'x' }, order({ id: 'draft', status: 'checkout-draft' })]);
  assert.equal(result.skipped, 2);
  assert.equal(calls[0].body.orders.length, 1);
});

test('orders go in batches of fifty', async () => {
  answer(() => ok({ stored: 50 }));
  const result = await sendOrders(Array.from({ length: 120 }, (_, i) => order({ id: `o-${i}` })), { deleted: ['gone-1'] });
  assert.deepEqual(calls.map((c) => c.body.orders.length), [50, 50, 20]);
  assert.deepEqual(calls[0].body.deleted, ['gone-1']);
  assert.deepEqual(calls[1].body.deleted, []);
  assert.equal(result.stored, 150);
});

test('deleteOrders sends the ids only', async () => {
  answer(() => ok({ stored: 0, deleted: 2 }));
  const result = await deleteOrders([5, '6']);
  assert.deepEqual(calls[0].body.orders, []);
  assert.deepEqual(calls[0].body.deleted, ['5', '6']);
  assert.equal(result.deleted, 2);
});

test('a switched-off sales module sends nothing', async () => {
  answer(() => ok());
  assert.deepEqual(await sendOrders(order(), { sales: false }), { ok: true, stored: 0, updated: 0, deleted: 0, skipped: 0, salesAllowed: false, reason: 'switched_off' });
  process.env.REACTLL_CONNECT_SALES = 'false';
  assert.equal((await deleteOrders(['1'])).reason, 'switched_off');
  assert.equal(calls.length, 0);
});

test('Reactll not allowing sales stops the rest', async () => {
  answer(() => json({ ok: true, stored: 0, sales_allowed: false, reason: 'not_allowed' }));
  const result = await sendOrders(Array.from({ length: 60 }, (_, i) => order({ id: `o-${i}` })));
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'not_allowed');
  assert.equal(result.salesAllowed, false);
  assert.equal(calls.length, 1);
});

test('409 host stops without throwing; any other 409 means already delivered', async () => {
  answer(() => json({ error: 'host' }, 409));
  const host = await sendOrders(Array.from({ length: 60 }, (_, i) => order({ id: `o-${i}` })));
  assert.equal(host.ok, false);
  assert.equal(host.reason, 'host');
  assert.equal(calls.length, 1);

  calls = [];
  answer((n) => (n === 1 ? json({ error: 'replayed request' }, 409) : ok({ stored: 10 })));
  const replay = await sendOrders(Array.from({ length: 60 }, (_, i) => order({ id: `o-${i}` })));
  assert.equal(replay.ok, true);
  assert.equal(replay.reason, null);
  assert.equal(replay.stored, 10);
  assert.equal(calls.length, 2);
});

test('network errors and 5xx are unreachable, bad data is refused', async () => {
  globalThis.fetch = async () => { throw new Error('down'); };
  assert.equal((await sendOrders(order())).reason, 'unreachable');
  answer(() => json({}, 503));
  assert.equal((await sendOrders(order())).reason, 'unreachable');
  answer(() => json({ message: 'invalid' }, 422));
  const refused = await sendOrders(order());
  assert.equal(refused.reason, 'refused');
  assert.equal(refused.ok, false);
});

test('without a site url nothing is sent', async () => {
  const saved = process.env.REACTLL_CONNECT_SITE_URL;
  delete process.env.REACTLL_CONNECT_SITE_URL;
  answer(() => ok());
  assert.equal((await sendOrders(order())).reason, 'no_site_url');
  assert.equal((await sendOrders(order(), { siteUrl: 'https://x.test' })).ok, true);
  process.env.REACTLL_CONNECT_SITE_URL = saved;
});

const invoice = (o = {}) => ({
  id: 'in_1Pabc', object: 'invoice', number: 'A1B2-0003', status: 'paid', currency: 'usd',
  total: 2900, subtotal: 2900, amount_paid: 2900, amount_due: 2900, attempt_count: 1,
  billing_reason: 'subscription_cycle', subscription: 'sub_123', created: 1760450282,
  status_transitions: { paid_at: 1760450290 },
  customer_email: 'Buyer@Example.test', customer_name: 'Ayla Demir', customer_phone: '+90 555',
  customer_address: { line1: 'Bagdat Cd 1', postal_code: '34000', city: 'Istanbul', country: 'TR' },
  livemode: false,
  lines: { object: 'list', data: [{ description: '1 × Pro (at $29.00 / month)', amount: 2900, quantity: 1, price: { product: 'prod_9' } }] },
  ...o,
});

test('a paid Stripe invoice is a subscription order, without personal data', () => {
  const o = fromStripeInvoice(invoice());
  assert.equal(o.id, 'in_1Pabc');
  assert.equal(o.number, 'A1B2-0003');
  assert.equal(o.status, 'completed');
  assert.equal(o.currency, 'USD');
  assert.equal(o.total, '29.00');
  assert.equal(o.created_via, 'subscription');
  assert.equal(o.created_at, '2025-10-14T13:58:02+00:00');
  assert.equal(o.paid_at, '2025-10-14T13:58:10+00:00');
  assert.deepEqual(o.items, [{ name: '1 × Pro (at $29.00 / month)', quantity: 1, total: '29.00', sku: null, product_id: 'prod_9' }]);
  assert.deepEqual(o.customer, { label: 'Ayla D.', city: 'Istanbul', country: 'TR', key: hmac('buyer@example.test'), returning: true });
  assert.equal(o.admin_url, 'https://dashboard.stripe.com/test/invoices/in_1Pabc');
  const raw = JSON.stringify(o);
  for (const pii of ['Buyer', 'example.test', '555', 'Bagdat', '34000']) assert.ok(!raw.includes(pii), pii);
});

test('refunded, failed and zero-decimal invoices; extra fields', async () => {
  const refunded = fromStripeInvoice(invoice({ post_payment_credit_notes_amount: 2900 }));
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.refunded, '29.00');
  const partly = fromStripeInvoice(invoice({ charge: { amount_refunded: 1000 } }));
  assert.equal(partly.status, 'completed');
  assert.equal(partly.refunded, '10.00');
  const failed = fromStripeInvoice(invoice({ status: 'open', amount_paid: 0, attempt_count: 2, billing_reason: 'subscription_create' }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.total, '29.00');
  assert.equal(failed.customer.returning, false);
  const yen = fromStripeInvoice(invoice({ currency: 'jpy', total: 3000, amount_paid: 3000, subtotal: 3000 }), { source: { source: 'google' }, customer: { returning: false } });
  assert.equal(yen.total, '3000');
  assert.equal(yen.source.source, 'google');
  assert.equal(yen.customer.returning, false);
  assert.equal(fromStripeInvoice({ object: 'invoice' }), null);

  answer(() => ok());
  assert.equal((await sendOrders(refunded)).ok, true);
  assert.equal(calls[0].body.orders[0].status, 'refunded');
  assert.equal(calls[0].body.orders[0].customer.key, hmac('buyer@example.test'));
});

test('forms off makes the lead a no-op', async () => {
  answer(() => json({ ok: true }, 201));
  assert.deepEqual(await sendLead('Contact', { email: 'a@b.test' }, { forms: false }), { ok: true, stored: 0, updated: 0, deleted: 0, skipped: 0, salesAllowed: null, reason: 'switched_off' });
  process.env.REACTLL_CONNECT_FORMS = 'off';
  assert.equal(await submitLead('Contact', { email: 'a@b.test' }), true);
  assert.equal(calls.length, 0);
  delete process.env.REACTLL_CONNECT_FORMS;
  answer(() => json({ error: 'host' }, 409));
  assert.equal((await sendLead('Contact', { email: 'a@b.test' })).reason, 'host');
});

test('visitors off means no script, events off marks it', () => {
  assert.equal(scriptTag(undefined, { visitors: false }), '');
  process.env.REACTLL_CONNECT_EVENTS = 'false';
  assert.equal(scriptTag(), '<script src="https://connect.example.test/v1/c.js" data-site="rc_aaaaaaaaaaaaaaaaaaaa" data-events="off" defer></script>');
});

test('the health answer reports modules and capabilities', async () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const req = () => new Request('https://site.test/api/reactll/health', { headers: { 'x-reactll-timestamp': ts, 'x-reactll-signature': hmac(`${ts}.health`) } });

  const all = await (await GET(req())).json();
  assert.deepEqual(all.modules, { visitors: true, events: true, forms: true, sales: true });
  assert.deepEqual(all.capabilities, { forms: true, sales: true });
  assert.equal(all.sales.backfill, 'none');
  assert.equal(all.site_url, 'https://shop.example.test');

  process.env.REACTLL_CONNECT_SALES = 'false';
  const off = await (await createHealth({ sendsLeads: false })(req())).json();
  assert.deepEqual(off.capabilities, { forms: false, sales: false });
  assert.equal(off.modules.sales, false);
  assert.equal('sales' in off, false);
  assert.equal((await createHealth({ modules: { sales: true } })(req()).then((r) => r.json())).modules.sales, true);
});
