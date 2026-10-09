import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { credentials, VERSION } from './token.js';

export { VERSION, credentials } from './token.js';

type Fields = Record<string, unknown>;

interface LeadOptions {
  /** The page view id the script stamps into every form as `_rc_pv`. */
  pv?: string | null;
  /** The page the form was sent from. */
  page?: string | null;
  /** Your own id for this submission, so a retry never doubles it. */
  id?: string;
  token?: string;
}

const DROP = /pass(word)?|card|cvv|cvc|token|nonce|captcha|^_rc_pv$|^\$ACTION/i;

function sign(secret: string, payload: string): { ts: string; signature: string } {
  const ts = String(Math.floor(Date.now() / 1000));

  return { ts, signature: createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex') };
}

/**
 * Send a form your site accepted to Reactll as a lead (from a server action or route handler, after
 * validating and saving it). Never throws: false when Reactll could not be reached.
 */
export async function submitLead(form: string, fields: Fields, options: LeadOptions = {}): Promise<boolean> {
  const c = credentials(options.token);
  if (!c) return false;

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
  const { ts, signature } = sign(c.s, body);

  try {
    const response = await fetch(`${c.u}/submissions`, {
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
      signal: AbortSignal.timeout(4000),
      cache: 'no-store',
    });

    return response.ok || response.status === 409;
  } catch {
    return false;
  }
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
export function scriptTag(token?: string): string {
  const c = credentials(token);

  return c ? `<script src="${c.u}/c.js" data-site="${c.k}" defer></script>` : '';
}

function versionOf(pkg: string): string | undefined {
  try {
    return (createRequire(import.meta.url)(`${pkg}/package.json`) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/**
 * Hourly health check, asked by Reactll (Next.js has no scheduler of its own). Export it from
 * app/api/reactll/health/route.ts:
 *
 *   export { GET } from '@reactll/connect/server';
 *
 * Only Reactll can call it: the request is signed with the site's secret.
 */
export async function GET(request: Request): Promise<Response> {
  const c = credentials();
  if (!c) return Response.json({ error: 'not connected' }, { status: 404 });

  const ts = request.headers.get('x-reactll-timestamp') ?? '';
  const given = request.headers.get('x-reactll-signature') ?? '';
  const expected = createHmac('sha256', c.s).update(`${ts}.health`).digest('hex');
  const fresh = /^\d+$/.test(ts) && Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
  if (!fresh || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  return Response.json(
    {
      platform: versionOf('next') ? 'next' : 'node',
      version: VERSION,
      runtime: Object.fromEntries(Object.entries({
        next: versionOf('next'),
        react: versionOf('react'),
        node: process.version.replace(/^v/, ''),
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
        host: process.env.VERCEL ? 'Vercel' : undefined,
        // Reactll counts the site's days on this clock (UTC is read as "not set"; set TZ to override).
        timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      }).filter(([, v]) => v)),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
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
