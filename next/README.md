<p align="center"><img src="https://zanbug.com/logo.png" alt="Zanbug" width="120"></p>

# @zanbug/next

[Zanbug](https://zanbug.com) error and performance monitoring for Next.js — server and client.

```bash
npm install @zanbug/next
```

## Why two entry points

A Next.js app runs in two places at once. A Server Component, route handler or middleware runs in Node; a Client Component runs in the browser. Each side needs different telemetry — slow database queries on the server, Core Web Vitals and DOM snapshots in the browser — so you wire both.

## 1. Server

Create `instrumentation.ts` at the project root (next to `next.config.js`). Next calls `register()` once per server process, before any request.

```ts
// instrumentation.ts
export async function register() {
  const { registerZanbug } = await import('@zanbug/next');

  await registerZanbug({
    apiKey: process.env.ZANBUG_API_KEY,
    host: 'https://zanbug.com',
  });
}
```

`release` defaults to `VERCEL_GIT_COMMIT_SHA` or `NEXT_PUBLIC_APP_VERSION`, and `environment` to `NODE_ENV`.

## 2. Client

```tsx
// app/zanbug.tsx
'use client';
import { ZanbugProvider } from '@zanbug/next';

export default function Zanbug() {
  return (
    <ZanbugProvider
      apiKey={process.env.NEXT_PUBLIC_ZANBUG_KEY!}
      host="https://zanbug.com"
    />
  );
}
```

```tsx
// app/layout.tsx — render it once
import Zanbug from './zanbug';

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <Zanbug />
        {children}
      </body>
    </html>
  );
}
```

## 3. Error boundary

Next hides the real message of a server-thrown error from the client and gives you a `digest` instead. Passing it along is the only way to line the client-side report up with the server-side one, which `captureNextError` does for you.

```tsx
// app/error.tsx
'use client';
import { useEffect } from 'react';
import { captureNextError } from '@zanbug/next';

export default function Error({ error, reset }) {
  useEffect(() => {
    captureNextError(error);
  }, [error]);

  return <button onClick={reset}>Try again</button>;
}
```

Add `app/global-error.tsx` the same way to catch failures in the root layout.

## Route handlers and server actions

```ts
import { withZanbugRoute } from '@zanbug/next';

export const POST = withZanbugRoute(async (req) => {
  const body = await req.json();
  return Response.json(await createOrder(body));
}, { name: 'orders.create' });
```

The error is reported and then rethrown, so your own error handling still runs.

## Pages Router

Use `registerZanbug()` from `instrumentation.ts` exactly as above, call `initZanbugClient()` once in `pages/_app.tsx`, and report from `pages/_error.tsx` with `captureNextError`.

## Slow database queries

Server-side query timing comes from [`@zanbug/node`](https://www.npmjs.com/package/@zanbug/node), which is bundled in — hook Prisma, TypeORM, Knex or `pg` there and slow queries appear in the Performance tab.

## Source maps

A production Next build is minified, so stack traces point into hashed bundles. Zanbug detects this and says so instead of guessing — set `productionBrowserSourceMaps: true` in `next.config.js` to get real file and line numbers.

## License

MIT
