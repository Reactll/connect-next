/**
 * The site owner's switches: Visitors, Events, Forms, Sales & Orders. Each is on unless switched off — in code
 * (an option) or with REACTLL_CONNECT_VISITORS / _EVENTS / _FORMS / _SALES = false. A module switched off sends
 * nothing, and Reactll drops whatever still arrives. Reported to Reactll in the health answer.
 */
export type ModuleName = 'visitors' | 'events' | 'forms' | 'sales';

export type Modules = Record<ModuleName, boolean>;

export const MODULES: readonly ModuleName[] = ['visitors', 'events', 'forms', 'sales'];

/** "false", "0", "off", "no" → false; anything else (or nothing) → the default. */
export function envFlag(name: string, fallback = true): boolean {
  const raw = (typeof process !== 'undefined' ? process.env[name] : undefined)?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['false', '0', 'off', 'no'].includes(raw)) return false;
  if (['true', '1', 'on', 'yes'].includes(raw)) return true;

  return fallback;
}

/** The switches: an option given in code wins over the environment. */
export function modules(overrides: Partial<Modules> = {}): Modules {
  const out = {} as Modules;
  for (const module of MODULES) {
    out[module] = overrides[module] ?? envFlag(`REACTLL_CONNECT_${module.toUpperCase()}`);
  }

  return out;
}

export interface Capabilities {
  /** The app sends its form leads with submitLead() (REACTLL_CONNECT_SENDS_LEADS, default true). */
  forms: boolean;
  /** The app sends orders (the sales module is on). */
  sales: boolean;
}

export function capabilities(options: { modules?: Partial<Modules>; sendsLeads?: boolean } = {}): Capabilities {
  return {
    forms: options.sendsLeads ?? envFlag('REACTLL_CONNECT_SENDS_LEADS'),
    sales: modules(options.modules).sales,
  };
}
