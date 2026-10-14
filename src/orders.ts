import { createHmac } from 'node:crypto';
import { credentials } from './token.js';
import { normaliseSubscription, type ContractSubscription, type SubscriptionInput } from './subscriptions.js';

/**
 * Orders as the Reactll contract has them (POST /v1/orders) — and nothing more. Personal data is minimal by
 * contract: a label ("Maria L."), city, country and a key (HMAC-SHA256 of the lowercased email with the site's
 * secret). The email itself, phone, street address, postcode and IP never leave the app: only the listed fields
 * are copied. Server only (node:crypto).
 */

type Money = number | string;
type DateLike = Date | string | number;

export interface OrderItemInput {
  name: string;
  quantity?: number | string;
  /** The line's total, discounts included. */
  total?: Money;
  sku?: string | number | null;
  product_id?: string | number | null;
}

export interface OrderSourceInput {
  /** utm, organic, referral, typein, admin, mobile_app, unknown */
  type?: string | null;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  /** A URL or a host: only the host is sent. */
  referrer?: string | null;
  device?: string | null;
}

export interface OrderCustomerInput {
  /** Never sent: becomes `key` (HMAC-SHA256 with the site's secret). */
  email?: string | null;
  /** Full name, or first_name / last_name: only "First L." is sent. */
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  label?: string | null;
  city?: string | null;
  /** ISO 3166-1 alpha-2 */
  country?: string | null;
  /** No email (Apple / TikTok sign-in): your customer / user id — hashed into `key` ("id:" prefix), never sent. */
  customer_id?: string | number | null;
  user_id?: string | number | null;
  /** Already hashed key (64 hex), when you have no email at hand. */
  key?: string | null;
  /** The customer had an earlier paid order. Left out: Reactll works it out. */
  returning?: boolean | null;
}

/** What the app passes. Money as numbers or strings, dates as Date / ISO string / unix seconds. */
export interface OrderInput {
  id: string | number;
  number?: string | number | null;
  /** completed (paid), pending, failed, refunded, cancelled, processing, on-hold… Default completed. */
  status?: string;
  /** ISO 4217 */
  currency: string;
  total: Money;
  subtotal?: Money | null;
  tax?: Money | null;
  shipping?: Money | null;
  discount?: Money | null;
  refunded?: Money | null;
  payment_method?: string | null;
  /** checkout (default), subscription, admin… */
  created_via?: string | null;
  created_at: DateLike;
  paid_at?: DateLike | null;
  completed_at?: DateLike | null;
  /** Default: now — so a later send (a refund) replaces the earlier one. */
  updated_at?: DateLike | null;
  /** The buyer's email, never sent (same as customer.email). */
  email?: string | null;
  /** No email: the customer / user id, hashed into customer.key and never sent (the email wins when both). */
  customer_id?: string | number | null;
  user_id?: string | number | null;
  customer?: OrderCustomerInput | null;
  items?: OrderItemInput[] | null;
  source?: OrderSourceInput | null;
  /** The Connect page-view id (`_rc_pv`) of the checkout, when you have it. */
  visit?: string | null;
  /** Your admin page for this payment, or the Stripe dashboard URL. */
  admin_url?: string | null;
  /** The subscription this payment belongs to (an invoice): Reactll links them. Currency and customer default to the order's. */
  subscription?: Partial<SubscriptionInput> & { id: string | number } | null;
}

export interface ContractOrder {
  id: string;
  number: string;
  status: string;
  currency: string;
  total: string;
  subtotal: string;
  tax: string;
  shipping: string;
  discount: string;
  refunded: string;
  payment_method: string | null;
  created_via: string;
  created_at: string;
  paid_at: string | null;
  completed_at: string | null;
  updated_at: string;
  customer: { label: string | null; city: string | null; country: string | null; key: string | null; returning: boolean | null };
  items: { name: string; quantity: number; total: string; sku: string | null; product_id: string | null }[];
  source: { type: string | null; source: string | null; medium: string | null; campaign: string | null; referrer: string | null; device: string | null } | null;
  visit: string | null;
  admin_url: string | null;
  subscription: ContractSubscription | null;
}

const ZERO_DECIMALS = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
const THREE_DECIMALS = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];
// Stripe's own lists: amounts there are in the smallest unit, except these zero-decimal ones.
const STRIPE_ZERO = ['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
const STRIPE_THREE = ['BHD', 'JOD', 'KWD', 'OMR', 'TND'];

const decimals = (currency: string) => (ZERO_DECIMALS.includes(currency) ? 0 : THREE_DECIMALS.includes(currency) ? 3 : 2);

/** @internal shared with subscriptions */
export function money(value: unknown, currency: string): string | null {
  const raw = typeof value === 'string' ? value.replace(/[,\s]/g, '') : value;
  if (typeof raw !== 'number' && !(typeof raw === 'string' && raw !== '' && Number.isFinite(Number(raw)))) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const d = decimals(currency);
  const out = (Math.round(n * 10 ** d) / 10 ** d).toFixed(d);

  return /^-0(\.0+)?$/.test(out) ? out.slice(1) : out;
}

/** @internal shared with subscriptions */
export function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  const out = String(value).replace(/<[^>]*>/g, '').trim();

  return out === '' ? null : Array.from(out).slice(0, max).join('');
}

/** ISO 8601 with offset (UTC: +00:00), from a Date, an ISO string or unix seconds (or milliseconds). */
/** @internal shared with subscriptions */
export function date(value: unknown): string | null {
  let d: Date | null = null;
  if (value instanceof Date) d = value;
  else if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim()))) {
    const n = Number(value);
    d = n > 0 ? new Date(n > 100_000_000_000 ? n : n * 1000) : null;
  } else if (typeof value === 'string' && value.trim() !== '') d = new Date(value.trim());
  if (!d || Number.isNaN(d.getTime())) return null;

  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** The customer key: hex HMAC-SHA256 of the lowercased, trimmed email with the site's secret. */
export function customerKey(email: string | null | undefined, secret: string | null | undefined): string | null {
  const clean = (email ?? '').trim().toLowerCase();

  return clean && secret ? createHmac('sha256', secret).update(clean).digest('hex') : null;
}

/** Without an email (Apple / TikTok sign-in): hex HMAC-SHA256 of "id:" + the lowercased, trimmed customer id. */
export function customerIdKey(id: string | number | null | undefined, secret: string | null | undefined): string | null {
  const clean = String(id ?? '').trim().toLowerCase();

  return clean && secret ? createHmac('sha256', secret).update(`id:${clean}`).digest('hex') : null;
}

/** @internal shared with subscriptions */
export function label(c: OrderCustomerInput): string | null {
  let first = text(c.first_name, 60);
  let last = text(c.last_name, 60);
  if (first === null && last === null) {
    const words = (text(c.name ?? c.label, 190) ?? '').split(/\s+/).filter(Boolean);
    first = words[0] ? Array.from(words[0]).slice(0, 60).join('') : null;
    last = words.length > 1 ? words[words.length - 1] : null;
  }
  if (first === null) return null;
  const initial = last ? Array.from(last.replace(/^\.+/, ''))[0]?.toUpperCase() ?? '' : '';
  const chars = Array.from(first);

  return chars[0].toUpperCase() + chars.slice(1).join('') + (initial ? ` ${initial}.` : '');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One order as the contract has it, or null when it cannot be one (no id, no created_at, no currency or no total).
 * Unknown keys (email, phone, address…) are dropped; `email` becomes `customer.key`.
 */
export function normaliseOrder(input: OrderInput, secret: string | null | undefined): ContractOrder | null {
  const o = (input ?? {}) as unknown as Record<string, unknown>;
  const id = text(o.id, 100);
  const currency = String(o.currency ?? '').trim().toUpperCase();
  const created = date(o.created_at);
  const total = money(o.total, currency);
  if (id === null || !/^[A-Z]{3}$/.test(currency) || created === null || total === null) return null;

  const m = (field: string) => money(o[field], currency) ?? money(0, currency)!;
  let status = String(o.status ?? 'completed').trim().toLowerCase();
  status = (status.startsWith('wc-') ? status.slice(3) : status).slice(0, 30) || 'completed';

  const items: ContractOrder['items'] = [];
  for (const raw of Array.isArray(o.items) ? (o.items as unknown[]) : []) {
    if (items.length >= 50) break;
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = text(item.name, 190);
    if (name === null) continue;
    const quantity = Math.trunc(Number(item.quantity ?? 1)) || 0;
    items.push({
      name,
      quantity: Math.max(-100000, Math.min(100000, quantity)),
      total: money(item.total, currency) ?? money(0, currency)!,
      sku: text(item.sku, 100),
      product_id: text(item.product_id, 50),
    });
  }

  const s = (o.source && typeof o.source === 'object' ? o.source : {}) as Record<string, unknown>;
  let referrer = text(s.referrer, 2000);
  if (referrer && referrer.includes('/')) {
    try {
      referrer = new URL(referrer.includes('://') ? referrer : `https://${referrer.replace(/^\/+/, '')}`).hostname || null;
    } catch {
      referrer = null;
    }
  }
  const source = {
    type: text(s.type, 30),
    source: text(s.source ?? s.utm_source, 190),
    medium: text(s.medium ?? s.utm_medium, 100),
    campaign: text(s.campaign ?? s.utm_campaign, 190),
    referrer: text(referrer, 190),
    device: text(s.device, 50),
  };

  const c = (o.customer && typeof o.customer === 'object' ? o.customer : {}) as OrderCustomerInput & Record<string, unknown>;
  const email = c.email ?? (o.email as string | undefined) ?? (o.customer_email as string | undefined);
  const userId = c.customer_id ?? c.user_id ?? (o.customer_id as string | number | undefined) ?? (o.user_id as string | number | undefined);
  const given = String(c.key ?? '').trim().toLowerCase();
  const country = String(c.country ?? '').trim().toUpperCase();
  const visit = String(o.visit ?? '').trim().toLowerCase();
  const admin = String(o.admin_url ?? '').trim();
  let adminUrl: string | null = null;
  if (admin.length <= 2000 && /^https?:\/\//i.test(admin)) {
    try {
      new URL(admin);
      adminUrl = admin;
    } catch {
      adminUrl = null;
    }
  }

  return {
    id,
    number: text(o.number, 50) ?? id.slice(0, 50),
    status,
    currency,
    total,
    subtotal: money(o.subtotal, currency) ?? total,
    tax: m('tax'),
    shipping: m('shipping'),
    discount: m('discount'),
    refunded: m('refunded').replace(/^-/, ''),
    payment_method: text(o.payment_method, 190),
    created_via: text(o.created_via, 50) ?? 'checkout',
    created_at: created,
    paid_at: date(o.paid_at),
    completed_at: date(o.completed_at),
    updated_at: date(o.updated_at) ?? date(new Date())!,
    customer: {
      label: label(c),
      city: text(c.city, 100),
      country: /^[A-Z]{2}$/.test(country) ? country : null,
      key: customerKey(typeof email === 'string' ? email : null, secret)
        ?? customerIdKey(typeof userId === 'string' || typeof userId === 'number' ? userId : null, secret)
        ?? (/^[0-9a-f]{64}$/.test(given) ? given : null),
      returning: c.returning === null || c.returning === undefined ? null : Boolean(c.returning),
    },
    items,
    source: Object.values(source).some((v) => v !== null) ? source : null,
    visit: UUID.test(visit) ? visit : null,
    admin_url: adminUrl,
    subscription: o.subscription && typeof o.subscription === 'object'
      ? normaliseSubscription({
        currency,
        email: typeof email === 'string' ? email : null,
        customer_id: typeof userId === 'string' || typeof userId === 'number' ? userId : null,
        customer: c,
        ...(o.subscription as Partial<SubscriptionInput>),
      } as SubscriptionInput, secret)
      : null,
  };
}

// ── Stripe ────────────────────────────────────────────────────────────────────────────────────────

/** The parts of a Stripe Invoice the mapping reads (a webhook's `data.object`, or stripe-node's Invoice). */
export interface StripeInvoiceLike {
  id?: string;
  number?: string | null;
  status?: string | null;
  paid?: boolean;
  currency?: string;
  total?: number;
  subtotal?: number;
  amount_paid?: number;
  amount_due?: number;
  tax?: number | null;
  total_taxes?: { amount?: number }[] | null;
  total_tax_amounts?: { amount?: number }[] | null;
  total_discount_amounts?: { amount?: number }[] | null;
  post_payment_credit_notes_amount?: number;
  charge?: string | { amount_refunded?: number } | null;
  attempt_count?: number;
  last_finalization_error?: unknown;
  billing_reason?: string | null;
  subscription?: string | object | null;
  parent?: { subscription_details?: unknown } | null;
  created?: number;
  status_transitions?: { paid_at?: number | null } | null;
  customer_email?: string | null;
  customer_name?: string | null;
  customer_address?: { city?: string | null; country?: string | null } | null;
  livemode?: boolean;
  lines?: { data?: StripeLineLike[] } | StripeLineLike[];
  [key: string]: unknown;
}

interface StripeLineLike {
  description?: string | null;
  amount?: number;
  quantity?: number | null;
  price?: { product?: string | object | null; nickname?: string | null } | null;
  plan?: { nickname?: string | null } | null;
  pricing?: { price_details?: { product?: string | null } | null } | null;
}

/** @internal shared with subscriptions */
export function fromSmallest(amount: number, currency: string): string {
  const divisor = STRIPE_ZERO.includes(currency) ? 1 : STRIPE_THREE.includes(currency) ? 1000 : 100;

  return (amount / divisor).toFixed(decimals(currency));
}

/**
 * A Stripe Invoice as an order input for sendOrders(): one order per invoice (`id` = the invoice id),
 * `created_via: subscription` for subscription invoices, the lines as items, amounts from the smallest unit.
 * Paid → completed, refunded (credit notes after payment, or an expanded charge) → refunded, a failed attempt →
 * failed, void → cancelled. `extra` sets or overrides fields (source, admin_url, customer.returning…).
 * Null when it is not an invoice. Returned already in the contract's shape: the email is hashed into
 * `customer.key` with the site's secret (REACTLL_CONNECT_TOKEN, or `options.token`) and gone.
 */
export function fromStripeInvoice(invoice: StripeInvoiceLike, extra: Partial<OrderInput> = {}, options: { token?: string } = {}): ContractOrder | null {
  const i = invoice ?? {};
  if (!i.id || !i.currency || i.created === undefined) return null;
  const currency = i.currency.toUpperCase();
  const amount = (v: unknown) => fromSmallest(typeof v === 'number' ? v : Number(v ?? 0) || 0, currency);
  const sum = (rows: { amount?: number }[] | null | undefined) => (rows ?? []).reduce((t, r) => t + (Number(r?.amount) || 0), 0);

  const paid = i.status === 'paid' || i.paid === true;
  const total = Number(paid ? (i.amount_paid ?? i.total ?? 0) : (i.total ?? i.amount_due ?? 0)) || 0;
  const charge = i.charge && typeof i.charge === 'object' ? i.charge : {};
  const refunded = Math.max(Number(i.post_payment_credit_notes_amount ?? 0) || 0, Number(charge.amount_refunded ?? 0) || 0);
  const tax = typeof i.tax === 'number' ? i.tax : sum(i.total_taxes ?? i.total_tax_amounts);

  let status = 'pending';
  if (paid && refunded > 0 && refunded >= total) status = 'refunded';
  else if (paid) status = 'completed';
  else if (i.status === 'void') status = 'cancelled';
  else if (i.status === 'uncollectible' || Number(i.attempt_count ?? 0) > 0 || i.last_finalization_error) status = 'failed';

  const lines = Array.isArray(i.lines) ? i.lines : (i.lines?.data ?? []);
  const reason = i.billing_reason ?? '';
  const subscription = Boolean(i.subscription || i.parent?.subscription_details || reason.startsWith('subscription'));

  const order: OrderInput = {
    id: i.id,
    number: i.number ?? null,
    status,
    currency,
    total: amount(total),
    subtotal: amount(i.subtotal ?? total),
    tax: amount(tax),
    shipping: amount(0),
    discount: amount(sum(i.total_discount_amounts)),
    refunded: amount(refunded),
    payment_method: 'Stripe',
    created_via: subscription ? 'subscription' : 'invoice',
    created_at: i.created,
    paid_at: i.status_transitions?.paid_at ?? null,
    completed_at: null,
    updated_at: null, // now: a later webhook (refund, retry) always replaces an earlier one
    customer: {
      name: i.customer_name ?? null,
      email: i.customer_email ?? null,
      city: i.customer_address?.city ?? null,
      country: i.customer_address?.country ?? null,
      returning: reason === 'subscription_cycle' ? true : reason === 'subscription_create' ? false : null,
    },
    items: lines.map((line) => {
      const product = line.price?.product ?? line.pricing?.price_details?.product;

      return {
        name: line.description ?? line.price?.nickname ?? line.plan?.nickname ?? 'Invoice line',
        quantity: line.quantity ?? 1,
        total: amount(line.amount ?? 0),
        product_id: typeof product === 'string' ? product : null,
      };
    }),
    source: null,
    admin_url: `https://dashboard.stripe.com/${i.livemode === false ? 'test/' : ''}invoices/${i.id}`,
  };

  const merged = { ...order, ...extra } as OrderInput;
  if (extra.customer) merged.customer = { ...order.customer, ...extra.customer };
  if (extra.source) merged.source = { ...(order.source ?? {}), ...extra.source };

  return normaliseOrder(merged, credentials(options.token)?.s);
}
