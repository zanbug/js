<p align="center"><img src="https://zanbug.com/logo.png" alt="Zanbug" width="120"></p>

# @zanbug/node

[Zanbug](https://zanbug.com) error and performance monitoring for Node.js.

```bash
npm install @zanbug/node
```

Using a framework? [`@zanbug/express`](https://www.npmjs.com/package/@zanbug/express) and [`@zanbug/nestjs`](https://www.npmjs.com/package/@zanbug/nestjs) build on this package and also hook the framework's own error path, which uncaught-exception handlers never see.

## Setup

```js
import { initNode } from '@zanbug/node';

initNode({
  apiKey: process.env.ZANBUG_API_KEY,
  host: 'https://zanbug.com',
  release: process.env.APP_VERSION,
  environment: process.env.NODE_ENV,
});
```

Uncaught exceptions and unhandled rejections are now reported automatically, along with your app name and version read from `package.json` and the Node version you are running.

## Slow database queries

Node has no single database layer, so each client gets its own hook. Queries slower than the threshold appear in the project's Performance tab, next to those from any other language.

```js
import { zanbugPrisma, zanbugTypeOrmLogger, zanbugKnex, zanbugPg, recordQuery } from '@zanbug/node';

// Prisma
prisma.$use(zanbugPrisma());

// TypeORM
new DataSource({ ...options, logger: zanbugTypeOrmLogger() });

// Knex
zanbugKnex(knex);

// node-postgres
zanbugPg(pool);

// Anything else
recordQuery({ sql, durationMs, bindings, connection: 'mysql' });
```

The threshold defaults to 1000 ms:

```js
initNode({
  apiKey: '…',
  slowQueryMs: 500,       // or ZANBUG_SLOW_QUERY_MS
  captureQueries: true,   // or ZANBUG_CAPTURE_QUERIES=false
});
```

Only queries at or above the threshold are sent, so hooking every query is cheap.

## Reporting errors yourself

```js
import { capture } from '@zanbug/node';

try {
  await job.run();
} catch (err) {
  capture(err, { handled: true, context: { job: job.name } });
}
```

## Cron, queue and script runs

In Node the SDK records every process that is not a web server as a *run*: how long it took, CPU
and peak memory, how many queries ran and how many were slow, and the exit code. The panel's
**Processes** tab groups them by command, shows which runs overlapped and which failed. Source
(`cron`, `scheduler`, `queue`, `script`) is detected from argv and the parent process; override it
when the guess is wrong:

```js
import { Zanbug } from '@zanbug/node';

Zanbug.setCommand('nightly-report');
Zanbug.setRunSource('cron');
```

Queue workers process many jobs in one long-lived process, so wrap each job — the run, its slow
queries and its error are then attributed to the job name, not to the worker:

```js
import { runJob } from '@zanbug/node';

await runJob('SendInvoiceEmail', () => handle(msg));           // source defaults to 'queue'
await runJob('nightly-report', run, 'cron', { tenant: 42 });  // any extra meta you want to see
```

`runJob` rethrows the job's error after recording it, so your retry logic is unchanged. It never
blocks the job: on an older core without run tracking it just calls `fn()`. Disable everything with
`captureRuns: false` (or `ZANBUG_CAPTURE_RUNS=false`).

## Updating the SDK

```bash
npx zanbug check              # exit 10 when a newer version is published
npx zanbug update             # asks, then upgrades every @zanbug/* dependency of the project
npx zanbug update --yes       # no prompt (cron / CI)
npx zanbug update --dry-run
```

The CLI walks up from the current directory to the `package.json` that depends on `@zanbug/*`,
picks your package manager from the lockfile (pnpm / yarn / bun / npm) and runs e.g.
`npm install @zanbug/node@^<latest> @zanbug/express@^<latest>` there. Key and host come from
`ZANBUG_API_KEY` / `ZANBUG_HOST`, your `.env`, or `--key` / `--host`.

**Automatic:** `initNode({ autoUpdate: true })` or `ZANBUG_AUTO_UPDATE=true`. Once a day, shortly
after init, the SDK asks the panel for the latest version and, if newer, runs the update in a
detached child process (log: `os.tmpdir()/zanbug-update.log`). Restart the process afterwards so
it loads the new code — the running process is never touched.

From code: `await checkForUpdate({ apiKey, host })` → `{ current, latest, updateAvailable, error }`;
`await updateSdk({ dryRun })` → `{ ok, from, to, message, output }`. Neither throws.

## Before the process exits

Delivery is fire-and-forget, so a short-lived script should wait for it:

```js
import { Zanbug } from '@zanbug/node';

await Zanbug.flush();
```

Long-running servers do not need this — the SDK also flushes on `beforeExit`.

## Compatibility

Node 12 and newer, ESM and CommonJS. Tested on 12, 14, 16, 18, 20 and 22. On versions without global `fetch` it falls back to the `http`/`https` module automatically.

Everything else — `console.error` capture, redaction, sampling, `beforeSend` — comes from [`@zanbug/js`](https://www.npmjs.com/package/@zanbug/js). See its README for the full option list.

## License

MIT
