import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { capabilities, modules, type Modules } from './modules.js';
import { normaliseOrder, type ContractOrder, type OrderInput } from './orders.js';
import { credentials, VERSION, type Credentials } from './token.js';

export { VERSION, credentials } from './token.js';
export { modules, capabilities, MODULES, type ModuleName, type Modules, type Capabilities } from './modules.js';
export {
  normaliseOrder,
  customerKey,
  customerIdKey,
  fromStripeInvoice,
  type OrderInput,
  type OrderItemInput,
  type OrderCustomerInput,
  type OrderSourceInput,
  type ContractOrder,
  type StripeInvoiceLike,
} from './orders.js';

type Fields = Record<string, unknown>;

/**
 * What became of a send to Reactll. Never thrown: `ok` false means it did not arrive, and `reason` says why.
 *
 * - `switched_off` — the module is off here (nothing sent) or in Reactll (nothing stored); ok
 * - `not_allowed` — the client has not agreed to sales in Reactll: nothing stored; ok
 * - `host` — site_url is not this site's address in Reactll (a staging copy with the live token): nothing stored
 * - `unreachable` — network error, timeout or Reactll down: send it again later (e.g. answer Stripe's webhook 500)
 * - `refused` — Reactll will never take it (bad token, invalid data)
 * - `not_connected` — no REACTLL_CONNECT_TOKEN; `no_site_url` — no siteUrl / REACTLL_CONNECT_SITE_URL
 */
export interface ConnectResult {
  ok: boolean;
  stored: number;
  updated: number;
  deleted: number;
  skipped: number;
  salesAllowed: boolean | null;
  reason: 'switched_off' | 'not_allowed' | 'host' | 'unreachable' | 'refused' | 'not_connected' | 'no_site_url' | (string & {}) | null;
}

const result = (ok: boolean, reason: ConnectResult['reason'] = null, counts: Partial<ConnectResult> = {}): ConnectResult => ({
  ok,
  stored: 0,
  updated: 0,
  deleted: 0,
  skipped: 0,
  salesAllowed: null,
  ...counts,
  reason,
});

/** One signed POST. Null when it never got an answer (network error, timeout). */
async function post(c: Credentials, path: string, body: string, timeoutMs: number): Promise<{ status: number; json: Record<string, unknown> } | null> {
  const { ts, signature } = sign(c.s, body);
  try {
    const response = await fetch(`${c.u}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Reactll-Key': c.k,
        'X-Reactll-Timestamp': ts,
        'X-Reactll-Signature': signature,
        'User-Agent': `ReactllConnect/${VERSION} Next.js`,
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (parsed && typeof parsed === 'object') json = parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }

    return { status: response.status, json };
  } catch {
    return null;
  }
}

interface LeadOptions {
  /** The page view id the script stamps into every form as `_rc_pv`. */
  pv?: string | null;
  /** The page the form was sent from. */
  page?: string | null;
  /** Your own id for this submission, so a retry never doubles it. */
  id?: string;
  token?: string;
  /** The forms module (default: REACTLL_CONNECT_FORMS, on). Off → nothing is sent. */
  forms?: boolean;
}

const DROP = /pass(word)?|card|cvv|cvc|token|nonce|captcha|^_rc_pv$|^\$ACTION/i;

function sign(secret: string, payload: string): { ts: string; signature: string } {
  const ts = String(Math.floor(Date.now() / 1000));

  return { ts, signature: createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex') };
}

/**
 * Send a form your site accepted to Reactll as a lead (from a server action or route handler, after
 * validating and saving it). Never throws: false when Reactll could not be reached (true, with nothing sent,
 * when the forms module is switched off — sendLead() tells the reason).
 */
export async function submitLead(form: string, fields: Fields, options: LeadOptions = {}): Promise<boolean> {
  return (await sendLead(form, fields, options)).ok;
}

/** submitLead() with the whole answer: `reason` is `switched_off` when the forms module is off (nothing sent). */
export async function sendLead(form: string, fields: Fields, options: LeadOptions = {}): Promise<ConnectResult> {
  if (!modules({ forms: options.forms }).forms) return result(true, 'switched_off');
  const c = credentials(options.token);
  if (!c) return result(false, 'not_connected');

  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (DROP.test(key) || value === undefined || value === null || typeof value === 'function') continue;
    clean[key] = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  const pv = options.pv && /^[0-9a-f-]{36}$/i.test(options.pv) ? options.pv : null;
  const body = JSON.stringify({
    id: options.id ?? `${form.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}`,
    form,
    page: options.page ?? null,
    pv,
    submitted_at: new Date().toISOString(),
    fields: clean,
  });

  const answer = await post(c, 'submissions', body, 4000);
  if (!answer) return result(false, 'unreachable');
  if (answer.status === 409 && answer.json.error === 'host') return result(false, 'host');
  if ((answer.status >= 200 && answer.status < 300) || answer.status === 409) {
    return result(true, typeof answer.json.reason === 'string' ? answer.json.reason : null, { stored: Number(answer.json.stored ?? (answer.status === 409 ? 0 : 1)) || 0 });
  }

  return result(false, answer.status >= 500 || answer.status === 429 ? 'unreachable' : 'refused');
}

// ── Sales & orders ─────────────────────────────────────────────────────────────────────────────────

export interface OrdersOptions {
  token?: string;
  /** The app's public URL, matching the site in Reactll. Default: REACTLL_CONNECT_SITE_URL, NEXT_PUBLIC_SITE_URL, the Vercel production URL. */
  siteUrl?: string;
  /** The sales module (default: REACTLL_CONNECT_SALES, on). Off → nothing is sent. */
  sales?: boolean;
  /** Order ids removed in the app: Reactll deletes them. */
  deleted?: (string | number)[];
  /** An import of past orders. */
  backfill?: boolean;
  /** Per request; default 10 000 ms. */
  timeoutMs?: number;
}

/** Orders per request (the contract's maximum). */
export const BATCH = 50;

let lastSentAt: string | null = null;

function siteUrl(given?: string): string | null {
  const env = process.env;
  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined;
  const url = (given ?? env.REACTLL_CONNECT_SITE_URL ?? env.NEXT_PUBLIC_SITE_URL ?? vercel ?? '').trim();

  return url === '' ? null : url;
}

/**
 * Send orders (a checkout, a paid Stripe invoice, a refund — the same id again — a failed payment) to Reactll,
 * 50 per request, signed. Pass the buyer's `email`: it becomes `customer.key` (HMAC with the site's secret) and is
 * never sent; phone, address and any other key are dropped. Never throws.
 *
 * Server only. To keep it off the response time, call it in Next's `after()` (next/server) or
 * `waitUntil()`; on `reason: 'unreachable'` let the caller retry (a Stripe webhook answered 500 comes again).
 */
export async function sendOrders(orders: OrderInput | OrderInput[], options: OrdersOptions = {}): Promise<ConnectResult> {
  if (!modules({ sales: options.sales }).sales) return result(true, 'switched_off', { salesAllowed: false });
  const c = credentials(options.token);
  if (!c) return result(false, 'not_connected');
  const site = siteUrl(options.siteUrl);
  if (!site) return result(false, 'no_site_url');

  const byId = new Map<string, ContractOrder>();
  let skipped = 0;
  for (const order of Array.isArray(orders) ? orders : [orders]) {
    const normal = normaliseOrder(order, c.s);
    if (!normal || normal.status === 'checkout-draft') skipped++;
    else byId.set(normal.id, normal);
  }
  const pending = [...byId.values()];
  const deleted = [...new Set((options.deleted ?? []).map((id) => String(id).trim().slice(0, 100)).filter(Boolean))];
  const t = { stored: 0, updated: 0, deleted: 0, skipped, salesAllowed: null as boolean | null };

  while (pending.length || deleted.length) {
    const batch = pending.splice(0, BATCH);
    const gone = deleted.splice(0, BATCH);
    const body = JSON.stringify({ site_url: site, backfill: Boolean(options.backfill), orders: batch, deleted: gone });
    const answer = await post(c, 'orders', body, options.timeoutMs ?? 10_000);

    if (!answer) return result(false, 'unreachable', t);
    const { status, json } = answer;
    if (status === 409 && json.error === 'host') return result(false, 'host', t);
    if (status === 409) continue; // this exact request already arrived: delivered
    if (status >= 200 && status < 300) {
      for (const key of ['stored', 'updated', 'deleted', 'skipped'] as const) t[key] += Number(json[key] ?? 0) || 0;
      if (typeof json.sales_allowed === 'boolean') t.salesAllowed = json.sales_allowed;
      lastSentAt = new Date().toISOString();
      // Switched off or not agreed in Reactll: nothing will be stored, the rest is not sent.
      if (typeof json.reason === 'string' && json.reason) return result(true, json.reason, t);
      continue;
    }
    if (status >= 500 || status === 429) return result(false, 'unreachable', t);
    t.skipped += batch.length;

    return result(false, 'refused', t);
  }

  return result(true, null, t);
}

/** Order ids removed in the app (deleted, or a test order): Reactll deletes them. */
export async function deleteOrders(ids: (string | number)[], options: Omit<OrdersOptions, 'deleted'> = {}): Promise<ConnectResult> {
  return sendOrders([], { ...options, deleted: ids });
}

/**
 * The same from a FormData (a server action's argument): `_rc_pv` is read from it, and the page from
 * the request's Referer when you pass `headers()`.
 */
export async function submitLeadFromFormData(form: string, data: FormData, options: LeadOptions & { headers?: Headers } = {}): Promise<boolean> {
  const fields: Fields = {};
  data.forEach((value, key) => {
    if (typeof value === 'string') fields[key] = value;
  });
  const pv = typeof data.get('_rc_pv') === 'string' ? (data.get('_rc_pv') as string) : null;

  return submitLead(form, fields, { ...options, pv: options.pv ?? pv, page: options.page ?? options.headers?.get('referer') ?? null });
}

/**
 * The script tag for any server-rendered page (Express/EJS, Handlebars, Fastify, Nuxt, Astro…), or ''
 * when not connected. Put it in the <head>. Only the public site key is in it.
 */
export function scriptTag(token?: string, options: { visitors?: boolean; events?: boolean } = {}): string {
  const c = credentials(token);
  const on = modules(options);
  if (!c || !on.visitors) return '';

  return `<script src="${c.u}/c.js" data-site="${c.k}"${on.events ? '' : ' data-events="off"'} defer></script>`;
}

function versionOf(pkg: string): string | undefined {
  try {
    return (createRequire(import.meta.url)(`${pkg}/package.json`) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export interface HealthOptions {
  token?: string;
  /** Switches set in code (otherwise REACTLL_CONNECT_VISITORS / _EVENTS / _FORMS / _SALES). */
  modules?: Partial<Modules>;
  /** The app sends its form leads (otherwise REACTLL_CONNECT_SENDS_LEADS, default true). */
  sendsLeads?: boolean;
}

/**
 * The health route with your own switches, when they are set in code rather than in the environment:
 *
 *   export const GET = createHealth({ modules: { sales: false } });
 */
export function createHealth(options: HealthOptions = {}): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const c = credentials(options.token);
    if (!c) return Response.json({ error: 'not connected' }, { status: 404 });

    const ts = request.headers.get('x-reactll-timestamp') ?? '';
    const given = request.headers.get('x-reactll-signature') ?? '';
    const expected = createHmac('sha256', c.s).update(`${ts}.health`).digest('hex');
    const fresh = /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
    if (!fresh || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }

    const can = capabilities(options);

    return Response.json(
      {
        platform: versionOf('next') ? 'next' : 'node',
        version: VERSION,
        ...(siteUrl() ? { site_url: siteUrl() } : {}),
        runtime: Object.fromEntries(Object.entries({
          next: versionOf('next'),
          react: versionOf('react'),
          node: process.version.replace(/^v/, ''),
          environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
          host: process.env.VERCEL ? 'Vercel' : undefined,
          // Reactll counts the site's days on this clock (UTC is read as "not set"; set TZ to override).
          timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
        }).filter(([, v]) => v)),
        modules: modules(options.modules),
        capabilities: can,
        // An app has no past orders to import for Reactll: it sends what happens from now on.
        ...(can.sales ? { sales: { backfill: 'none', last_sent_at: lastSentAt } } : {}),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  };
}

/**
 * Hourly health check, asked by Reactll (Next.js has no scheduler of its own). Export it from
 * app/api/reactll/health/route.ts:
 *
 *   export { GET } from '@reactll/connect/server';
 *
 * Only Reactll can call it: the request is signed with the site's secret. It also reports the modules
 * (environment switches) and what the app sends; use createHealth() to set them in code.
 */
export async function GET(request: Request): Promise<Response> {
  return createHealth()(request);
}

export const dynamic = 'force-dynamic';

/** The health answer as plain data (platform and versions), for any framework. */
export async function health(request: Request): Promise<Response> {
  return GET(request);
}

type NodeReq = { method?: string; url?: string; originalUrl?: string; headers: Record<string, string | string[] | undefined> };
type NodeRes = { statusCode: number; setHeader(name: string, value: string): unknown; end(body?: string): unknown };

/**
 * Express / Connect (and plain node:http) middleware answering Reactll's hourly health question at
 * GET /api/reactll/health. Other requests pass through.
 *
 *   app.use(expressHealth());
 */
export function expressHealth(path = '/api/reactll/health') {
  return async (req: NodeReq, res: NodeRes, next?: () => void) => {
    const url = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if ((req.method ?? 'GET') !== 'GET' || url !== path) {
      next?.();

      return;
    }
    const header = (name: string) => {
      const v = req.headers[name];

      return Array.isArray(v) ? v[0] : (v ?? '');
    };
    const answer = await GET(new Request('http://localhost' + path, {
      headers: { 'x-reactll-timestamp': header('x-reactll-timestamp'), 'x-reactll-signature': header('x-reactll-signature') },
    }));
    res.statusCode = answer.status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(await answer.text());
  };
}
