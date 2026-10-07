<p align="center"><img src="https://zanbug.com/logo.png" alt="Zanbug" width="120"></p>

# @zanbug/express

[Zanbug](https://zanbug.com) error and performance monitoring for Express.

```bash
npm install @zanbug/express
```

## Why the adapter

Express does not let a route's error reach `uncaughtException` — it hands it to the error-middleware chain instead. So a global handler alone reports nothing when a route throws.

## Setup

Order matters: the request handler goes **before** your routes, the error handler **after** them.

```js
import express from 'express';
import { initExpress, zanbugRequestHandler, zanbugErrorHandler } from '@zanbug/express';

initExpress({
  apiKey: process.env.ZANBUG_API_KEY,
  host: 'https://zanbug.com',
  release: process.env.APP_VERSION,
  environment: process.env.NODE_ENV,
});

const app = express();

app.use(zanbugRequestHandler());   // first

app.get('/orders/:id', async (req, res) => {
  res.json(await getOrder(req.params.id));
});

app.use(zanbugErrorHandler());     // last
```

Each report carries the method, the route **pattern** (`/orders/:id`, not the concrete URL — that is what groups errors usefully) and the status code.

## Attaching the user

`req.user` is used automatically when present. Otherwise say where to look:

```js
app.use(zanbugRequestHandler({
  user: (req) => ({ id: req.session?.userId, email: req.session?.email }),
  breadcrumbs: true,   // record every request, not just failures
}));
```

## What counts as an error

Deliberate 4xx responses (validation, not found) are not bugs, so they are skipped by default. Anything without a status, or 5xx, is reported. To decide yourself:

```js
app.use(zanbugErrorHandler({
  shouldCapture: (err) => err.status !== 429,
}));
```

The middleware always calls `next(err)`, so your own error handler still runs and still shapes the response.

## Slow database queries

Hook your database client with [`@zanbug/node`](https://www.npmjs.com/package/@zanbug/node) (bundled in) — Prisma, TypeORM, Knex and `pg` are supported out of the box.

## Updating
```bash
npx zanbug check     # exit 10 when a newer version is published
npx zanbug update    # upgrades @zanbug/node and @zanbug/express together, with your package manager
```
Automatic: `initNode({ autoUpdate: true })` or `ZANBUG_AUTO_UPDATE=true` — daily check after init, update runs detached; restart the process afterwards. Details in the [@zanbug/node README](../node/README.md#updating-the-sdk).

## License

MIT
