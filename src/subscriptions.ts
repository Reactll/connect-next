import { credentials } from './token.js';
import { customerIdKey, customerKey, date, fromSmallest, label, money, text, type OrderCustomerInput } from './orders.js';

/**
 * Subscriptions as the Reactll contract has them (POST /v1/subscriptions, or `subscription` on an order): what
 * Reactll counts MRR, churn and trials from. The same minimal personal data as orders: a label, a country and a
 * one-way key (from `email`, else `customer_id` / `user_id`) — never the email or the id itself. Server only.
 */

type DateLike = Date | string | number;

export const STATUSES = ['trialing', 'active', 'past_due', 'paused', 'canceled'] as const;
export const INTERVALS = ['day', 'week', 'month', 'year'] as const;

/** What the app passes. */
export interface SubscriptionInput {
  id: string | number;
  /** "Pro · Monthly" */
  plan?: string | null;
  /** trialing, active, past_due, paused, canceled (cancelled / ended / expired → canceled, unpaid / incomplete → past_due, trial → trialing). Default active. */
  status?: string;
  /** ISO 4217 */
  currency: string;
  /** The recurring price per interval, after discounts, excl. tax. */
  amount: number | string;
  /** day, week, month, year (daily / weekly / monthly / yearly / annual accepted). Default month. */
  interval?: string;
  interval_count?: number | null;
  quantity?: number | null;
  started_at?: DateLike | null;
  trial_ends_at?: DateLike | null;
  current_period_end?: DateLike | null;
  canceled_at?: DateLike | null;
  /** Cancelled at period end: access and MRR run to here. */
  ends_at?: DateLike | null;
  /** Default: now. A repeat with an older or equal updated_at changes nothing in Reactll. */
  updated_at?: DateLike | null;
  /** Never sent: becomes customer.key. */
  email?: string | null;
  /** No email: hashed into customer.key ("id:" prefix), never sent. */
  customer_id?: string | number | null;
  user_id?: string | number | null;
  customer?: OrderCustomerInput | null;
}

export interface ContractSubscription {
  id: string;
  plan: string | null;
  status: (typeof STATUSES)[number];
  currency: string;
  amount: string;
  interval: (typeof INTERVALS)[number];
  interval_count: number;
  quantity: number;
  started_at: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  ends_at: string | null;
  updated_at: string;
  customer: { label: string | null; country: string | null; key: string | null };
}

const STATUS_ALIASES: Record<string, string> = {
  cancelled: 'canceled', ended: 'canceled', expired: 'canceled', incomplete_expired: 'canceled',
  unpaid: 'past_due', incomplete: 'past_due', trial: 'trialing',
};

const INTERVAL_ALIASES: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year', annual: 'year', annually: 'year' };

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.trunc(Number(value ?? fallback));

  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** One subscription as the contract has it, or null when it cannot be one (no id, an unknown status or interval, no currency or amount). */
export function normaliseSubscription(input: SubscriptionInput, secret: string | null | undefined): ContractSubscription | null {
  const s = (input ?? {}) as unknown as Record<string, unknown>;
  const id = text(s.id, 190);
  const currency = String(s.currency ?? '').trim().toUpperCase();
  let status = String(s.status ?? 'active').trim().toLowerCase();
  status = STATUS_ALIASES[status] ?? status;
  let interval = String(s.interval ?? 'month').trim().toLowerCase();
  interval = INTERVAL_ALIASES[interval] ?? interval;
  const amount = /^[A-Z]{3}$/.test(currency) ? money(s.amount, currency) : null;
  if (id === null || amount === null || !(STATUSES as readonly string[]).includes(status) || !(INTERVALS as readonly string[]).includes(interval)) return null;

  const c = (s.customer && typeof s.customer === 'object' ? s.customer : {}) as OrderCustomerInput;
  const email = c.email ?? (s.email as string | null | undefined);
  const userId = c.customer_id ?? c.user_id ?? (s.customer_id as string | number | null | undefined) ?? (s.user_id as string | number | null | undefined);
  const given = String(c.key ?? '').trim().toLowerCase();
  const country = String(c.country ?? '').trim().toUpperCase();

  return {
    id,
    plan: text(s.plan, 190),
    status: status as ContractSubscription['status'],
    currency,
    amount: amount.replace(/^-/, ''),
    interval: interval as ContractSubscription['interval'],
    interval_count: clamp(s.interval_count, 1, 365, 1),
    quantity: clamp(s.quantity, 1, 100_000, 1),
    started_at: date(s.started_at ?? s.created_at),
    trial_ends_at: date(s.trial_ends_at),
    current_period_end: date(s.current_period_end),
    canceled_at: date(s.canceled_at),
    ends_at: date(s.ends_at),
    updated_at: date(s.updated_at) ?? date(new Date())!,
    customer: {
      label: label(c),
      country: /^[A-Z]{2}$/.test(country) ? country : null,
      key: customerKey(typeof email === 'string' ? email : null, secret)
        ?? customerIdKey(typeof userId === 'string' || typeof userId === 'number' ? userId : null, secret)
        ?? (/^[0-9a-f]{64}$/.test(given) ? given : null),
    },
  };
}

/** The parts of a Stripe Subscription the mapping reads (a webhook's `data.object`, or stripe-node's Subscription). */
export interface StripeSubscriptionLike {
  id?: string;
  object?: string;
  status?: string;
  currency?: string;
  start_date?: number | null;
  created?: number | null;
  trial_end?: number | null;
  current_period_end?: number | null;
  canceled_at?: number | null;
  cancel_at?: number | null;
  ended_at?: number | null;
  quantity?: number | null;
  items?: { data?: StripeSubscriptionItemLike[] };
  [key: string]: unknown;
}

interface StripePriceLike {
  currency?: string;
  unit_amount?: number | null;
  amount?: number | null;
  nickname?: string | null;
  product?: string | { name?: string | null } | null;
  recurring?: { interval?: string; interval_count?: number } | null;
  interval?: string;
  interval_count?: number;
}

interface StripeSubscriptionItemLike {
  quantity?: number | null;
  current_period_end?: number | null;
  price?: StripePriceLike | null;
  plan?: StripePriceLike | null;
}

/**
 * A Stripe Subscription (customer.subscription.* webhooks) as a contract subscription. Plan names and the customer
 * usually are ids on the object: pass them in `extra` (plan, email, customer). Null when it is not a subscription.
 */
export function fromStripeSubscription(subscription: StripeSubscriptionLike, extra: Partial<SubscriptionInput> = {}, options: { token?: string } = {}): ContractSubscription | null {
  const s = subscription ?? {};
  if ((s.object ?? 'subscription') !== 'subscription' || !s.id) return null;
  const item = s.items?.data?.[0] ?? {};
  const price = item.price ?? item.plan ?? {};
  const recurring = price.recurring ?? price;
  const currency = String(price.currency ?? s.currency ?? '').toUpperCase();
  const unit = price.unit_amount ?? price.amount;
  const at = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v * 1000) : null);
  const product = price.product;

  return normaliseSubscription({
    id: s.id,
    plan: price.nickname ?? (product && typeof product === 'object' ? product.name ?? null : null),
    status: s.status ?? 'active',
    currency,
    amount: typeof unit === 'number' ? fromSmallest(unit, currency) : '',
    interval: recurring.interval ?? 'month',
    interval_count: recurring.interval_count ?? 1,
    quantity: item.quantity ?? s.quantity ?? 1,
    started_at: at(s.start_date ?? s.created),
    trial_ends_at: at(s.trial_end),
    current_period_end: at(item.current_period_end ?? s.current_period_end),
    canceled_at: at(s.canceled_at),
    // Cancelled at period end: access (and MRR) runs to cancel_at; ended: it stopped then.
    ends_at: at(s.ended_at ?? s.cancel_at),
    updated_at: new Date(),
    ...extra,
  } as SubscriptionInput, credentials(options.token)?.s);
}
