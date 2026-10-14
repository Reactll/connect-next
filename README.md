# Reactll Connect for Next.js and Node.js

Connects a Next.js or any Node.js site (Express, Fastify, Nuxt, Remix, Astro, Hono…) to its [Reactll](https://reactll.com) dashboard: visits, calls, WhatsApp and
directions clicks, form leads, sales and site health. Built and maintained by **Reactor Technology**.

## Install

```bash
npm i @reactll/connect
```

```dotenv
REACTLL_CONNECT_TOKEN=rcc_…   # Reactll → Sites → the site → Install (server-side only)
```

**1. The script** — once, in `app/layout.tsx`:

```tsx
import { ReactllConnect } from '@reactll/connect';

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ReactllConnect />
      </body>
    </html>
  );
}
```

Cookieless; client-side navigations count as page views. Only the public site key reaches the browser.

**2. Health** — Reactll asks hourly (signed, nothing else can call it). `app/api/reactll/health/route.ts`:

```ts
export { GET } from '@reactll/connect/server';
```

**3. Form leads** — after your server action validated and saved the form:

```ts
'use server';
import { headers } from 'next/headers';
import { submitLeadFromFormData } from '@reactll/connect/server';

export async function contact(formData: FormData) {
  // …validate and save…
  await submitLeadFromFormData('Contact', formData, { headers: await headers() });
}
```

The script stamps every form with the page view id (`_rc_pv`), so Reactll ties the lead to the visit it
came from. `submitLead(form, fields, options)` takes a plain object instead. Neither ever throws.
`sendLead(...)` returns the whole answer (a `ConnectResult`, see below) instead of a boolean.

## Modules

Four switches, all on by default — off with `REACTLL_CONNECT_VISITORS` / `_EVENTS` / `_FORMS` / `_SALES` `=false`, or
in code (the option wins). A module switched off sends nothing, and Reactll drops anything that still arrives.

| Module | Off means | In code |
|---|---|---|
| `visitors` | `<ReactllConnect />` / `scriptTag()` render nothing | `<ReactllConnect visitors={false} />`, `scriptTag(undefined, { visitors: false })` |
| `events` | page views only (`data-events="off"`: no call / WhatsApp / click events) | `<ReactllConnect events={false} />` |
| `forms` | `submitLead()` / `sendLead()` send nothing (`reason: 'switched_off'`) | `{ forms: false }` |
| `sales` | `sendOrders()` / `deleteOrders()` send nothing (`reason: 'switched_off'`) | `{ sales: false }` |

The health route reports them to Reactll with `capabilities` (`forms`: the app sends its leads —
`REACTLL_CONNECT_SENDS_LEADS`; `sales`: the sales module is on). Switches set in code go in the route too:

```ts
// app/api/reactll/health/route.ts
import { createHealth } from '@reactll/connect/server';
export const GET = createHealth({ modules: { sales: false }, sendsLeads: true });
export const dynamic = 'force-dynamic';
```

## Sales & orders

Custom shops and SaaS send their sales as orders (`POST /v1/orders`, contract: Reactll's CONNECT-ORDERS). The app
decides what an order is:

| What happened | Send |
|---|---|
| A one-off purchase / checkout | one order, `created_via: 'checkout'`, items = what was bought |
| A subscription payment (first or renewal, e.g. a paid Stripe invoice) | one order per paid invoice, `id` = the invoice id, `created_via: 'subscription'`, one item = the plan |
| A refund | the same order again with `refunded` set (`status: 'refunded'` when fully refunded) — a newer `updated_at` replaces it |
| A failed payment | the order with `status: 'failed'` (shows in the failed-payment alert, never as revenue) |
| A trial / free sign-up | **not an order** — send it as a lead (form `Signup`) |

Status: `completed` (paid), `pending`, `failed`, `refunded`, `cancelled`. Money as numbers or strings (sent as
decimal strings in the order's currency, never converted), dates as `Date`, ISO strings or unix seconds (sent as
ISO 8601 with offset). `created_at` is required, `updated_at` defaults to now. 50 orders per request.

**Personal data stays in the app.** Pass the buyer's `email`: it becomes `customer.key` (HMAC-SHA256 of the
lowercased email with the site's secret — Reactll cannot reverse it) and is never sent. No email (Apple / TikTok
sign-in)? Pass `customer_id` (or `user_id`): hashed the same way with an `id:` prefix, never sent either; the email
wins when both are given. Only `First L.`, city and country go with it; phone, address, postcode and any key not in
the contract are dropped.

Server only (`@reactll/connect/server`, Node's crypto) — never import it in a client component.

```ts
import { after } from 'next/server';
import { sendOrders, deleteOrders, fromStripeInvoice, submitLead } from '@reactll/connect/server';

// A one-off checkout (server action / route handler) — after() sends it once the response is out
after(() => sendOrders({
  id: order.id,
  status: 'completed',
  currency: 'EUR',
  total: order.total,                 // 86.4 or '86.40'
  tax: order.tax,
  created_at: order.createdAt,
  paid_at: order.paidAt,
  email: order.email,                 // hashed, never sent
  customer: { name: order.name, city: order.city, country: 'DE' },
  items: [{ name: 'Pro plan', quantity: 1, total: order.total, sku: 'PRO' }],
  source: { type: 'utm', source: user.utmSource, medium: user.utmMedium, campaign: user.utmCampaign },
  admin_url: `https://app.example.com/admin/orders/${order.id}`,
}));

// A Stripe webhook: invoice.paid, invoice.payment_failed, credit_note.created / charge.refunded (send the invoice
// again). No stripe dependency: the event's data.object as it is.
export async function POST(request: Request) {
  const event = /* stripe.webhooks.constructEvent(...) */ await request.json();
  if (event.type.startsWith('invoice.')) {
    const order = fromStripeInvoice(event.data.object); // paid → completed, refunded → refunded, failed attempt → failed
    const result = order ? await sendOrders(order) : null;
    if (result?.reason === 'unreachable') return new Response('retry', { status: 500 }); // Stripe sends it again
  }
  return new Response('ok');
}

// A refund made in the app / a failed payment
await sendOrders({ ...sameOrder, refunded: 86.4, status: 'refunded', updated_at: new Date() });
await sendOrders({ ...sameOrder, status: 'failed', updated_at: new Date() });

// An order deleted in the app (a test order)
await deleteOrders([order.id]);

// A free sign-up is a lead, not an order
await submitLead('Signup', { plan: 'trial', email: user.email });
```

`sendOrders(orders, { siteUrl?, deleted?, sales?, backfill?, token?, timeoutMs? })` and `deleteOrders(ids, options)`
never throw; they resolve to a `ConnectResult`:

| Field | |
|---|---|
| `ok` | it arrived (or nothing had to be sent) |
| `stored`, `updated`, `deleted`, `skipped` | Reactll's counts (`skipped` also counts orders without id, created_at, currency or total) |
| `salesAllowed` | Reactll has the client's agreement for sales (`false` → nothing is stored yet) |
| `reason` | `null`, `'switched_off'`, `'not_allowed'`, `'host'` (the site URL is not the site's in Reactll — a staging copy), `'unreachable'` (network / 5xx: retry later), `'refused'`, `'not_connected'`, `'no_site_url'` |

There is no background queue in a serverless app: on `'unreachable'`, let the caller retry (a Stripe webhook
answered 500 comes again). `site_url` comes from `siteUrl`, `REACTLL_CONNECT_SITE_URL`, `NEXT_PUBLIC_SITE_URL` or
Vercel's production URL, and has to match the site's address in Reactll.

**CommonJS.** The package is ESM. From a CommonJS app (`require`), load the server helpers with a dynamic import:

```js
const { sendOrders, submitLead } = await import('@reactll/connect/server');
```

### Subscriptions (MRR, churn, trials)

A subscription business also sends the subscriptions themselves (`POST /v1/subscriptions`): Reactll counts MRR, new
and cancelled subscribers and trials from them, while the paid invoices stay the revenue. Send one when it starts,
renews, changes plan, fails to renew or is cancelled — or resend them all from a cron: a repeat with an older or equal
`updated_at` changes nothing.

```ts
import { sendSubscriptions, fromStripeSubscription, sendOrders } from '@reactll/connect/server';

await sendSubscriptions({
  id: sub.id,
  plan: 'Pro · Monthly',
  status: 'active',            // trialing, active, past_due, paused, canceled (cancelled / expired / unpaid accepted)
  currency: 'USD',
  amount: 9.99,                // per interval, after discounts, excl. tax
  interval: 'month',           // day, week, month, year (monthly / yearly accepted)
  started_at: sub.createdAt,
  current_period_end: sub.renewsAt,
  ends_at: sub.endsAt,         // cancelled at period end: access and MRR run to here
  updated_at: sub.updatedAt,
  email: user.email,           // or customer_id — hashed, never sent
  customer: { name: user.name },
});

// customer.subscription.* webhooks (pass plan / email when the object only has ids)
const s = fromStripeSubscription(event.data.object, { plan: 'Pro', email });
if (s) await sendSubscriptions(s);

// Or on the invoice order: `subscription` links the payment to it (currency and customer come from the order)
await sendOrders({ ...invoiceOrder, subscription: { id: sub.id, status: 'active', amount: 9.99, interval: 'month' } });
```

No retry queue: on `reason: 'unreachable'` send again (answer the webhook 500, or let the next cron run).

## Environment

| Variable | Default | |
|---|---|---|
| `REACTLL_CONNECT_TOKEN` | — | the connection token (server only) |
| `REACTLL_CONNECT_SITE_URL` | `NEXT_PUBLIC_SITE_URL`, then Vercel's production URL | the app's public URL, sent as `site_url` with orders |
| `REACTLL_CONNECT_VISITORS` | `true` | visitors module |
| `REACTLL_CONNECT_EVENTS` | `true` | events module |
| `REACTLL_CONNECT_FORMS` | `true` | forms module |
| `REACTLL_CONNECT_SALES` | `true` | sales module |
| `REACTLL_CONNECT_SENDS_LEADS` | `true` | the app sends its form leads (reported as `capabilities.forms`) |

## Any other Node.js app

The same package, without Next.js or React (they are optional):

```js
import { scriptTag, expressHealth, submitLead } from '@reactll/connect/server';

app.use(expressHealth());                       // Express / Connect / node:http — GET /api/reactll/health
res.render('page', { reactll: scriptTag() });   // put {{{ reactll }}} / <%- reactll %> in the <head>

// after your form was validated and saved:
await submitLead('Contact', { name, email, message }, { pv: req.body._rc_pv, page: req.get('referer') });
```

Frameworks on web `Request`/`Response` (Hono, Remix, Nuxt/h3, Astro, Bun, Deno): route
`GET /api/reactll/health` to `health(request)` from `@reactll/connect/server`.

## Content-Security-Policy

If the site sends a CSP header, allow Reactll Connect in it, or the browser blocks the script and its beacons:

```
script-src  … https://connect.reactll.com
connect-src … https://connect.reactll.com
```

## License

MIT © Reactor Technology
