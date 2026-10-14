import Script from 'next/script';
import { modules } from './modules.js';
import { credentials } from './token.js';

export { VERSION } from './token.js';
export { modules, type Modules, type ModuleName } from './modules.js';

/**
 * The Reactll Connect script. Put it once in your root layout (a server component):
 *
 *   <ReactllConnect />
 *
 * It reads REACTLL_CONNECT_TOKEN on the server and renders nothing when it is missing. Cookieless;
 * client-side navigations are counted as page views.
 *
 * Modules: `visitors={false}` (or REACTLL_CONNECT_VISITORS=false) renders nothing; `events={false}`
 * (REACTLL_CONNECT_EVENTS=false) counts page views only (calls, WhatsApp and other clicks are not sent).
 */
export function ReactllConnect({ token, visitors, events }: { token?: string; visitors?: boolean; events?: boolean }) {
  const c = credentials(token ?? process.env.REACTLL_CONNECT_TOKEN);
  const on = modules({ visitors, events });
  if (!c || !on.visitors) return null;

  return (
    <Script id="reactll-connect" src={`${c.u}/c.js`} data-site={c.k} data-events={on.events ? undefined : 'off'} strategy="afterInteractive" />
  );
}

export default ReactllConnect;
