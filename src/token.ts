/**
 * Reactll Connect for Next.js — built and maintained by Reactor Technology.
 *
 * The connection token (REACTLL_CONNECT_TOKEN, from Reactll → Sites → the site → Install) holds the
 * endpoint, the site's public key and its secret. Only the endpoint and the public key ever reach
 * the browser.
 */
export const VERSION = '1.3.0';

export interface Credentials {
  /** Endpoint, e.g. https://connect.reactll.com/v1 */
  u: string;
  /** Public site key (rc_…) */
  k: string;
  /** Secret: server only */
  s: string;
}

export function credentials(token: string | undefined | null = process.env.REACTLL_CONNECT_TOKEN): Credentials | null {
  const raw = (token ?? '').trim();
  if (!raw.startsWith('rcc_')) return null;
  try {
    const json = Buffer.from(raw.slice(4).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const data = JSON.parse(json) as Partial<Credentials>;
    if (!data.u || !data.k || !data.s) return null;

    return { u: data.u.replace(/\/+$/, ''), k: data.k, s: data.s };
  } catch {
    return null;
  }
}
