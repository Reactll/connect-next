import Script from 'next/script';
import { credentials } from './token.js';

export { VERSION } from './token.js';

/**
 * The Reactll Connect script. Put it once in your root layout (a server component):
 *
 *   <ReactllConnect />
 *
 * It reads REACTLL_CONNECT_TOKEN on the server and renders nothing when it is missing. Cookieless;
 * client-side navigations are counted as page views.
 */
export function ReactllConnect({ token }: { token?: string }) {
  const c = credentials(token ?? process.env.REACTLL_CONNECT_TOKEN);
  if (!c) return null;

  return <Script id="reactll-connect" src={`${c.u}/c.js`} data-site={c.k} strategy="afterInteractive" />;
}

export default ReactllConnect;
