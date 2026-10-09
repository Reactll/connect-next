# Reactll Connect for Next.js

Connects a Next.js site to its [Reactll](https://reactll.com) dashboard: visits, calls, WhatsApp and
directions clicks, form leads and site health. Built and maintained by **Reactor Technology**.

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

## License

MIT © Reactor Technology
