<p align="center"><img src="https://zanbug.com/logo.png" alt="Zanbug" width="120"></p>

# @zanbug/js

Error and performance monitoring for JavaScript — the framework-agnostic core of the [Zanbug](https://zanbug.com) SDK family. Runs in browsers and in Node.js.

Captures uncaught errors, `console.error`, failed network calls, Core Web Vitals and a DOM snapshot of the page at the moment it broke — then reports them to your Zanbug project, where they are grouped, tracked and analysed by AI.

```bash
npm install @zanbug/js
```

Using a framework? Install the adapter instead — it wires the framework's own error path, which the global handlers cannot see:

| Framework | Package |
|---|---|
| React (Vite, CRA, …) | [`@zanbug/react`](https://www.npmjs.com/package/@zanbug/react) |
| Vue 3 | [`@zanbug/vue`](https://www.npmjs.com/package/@zanbug/vue) |
| Next.js | [`@zanbug/next`](https://www.npmjs.com/package/@zanbug/next) |
| Node.js | [`@zanbug/node`](https://www.npmjs.com/package/@zanbug/node) |
| Express | [`@zanbug/express`](https://www.npmjs.com/package/@zanbug/express) |
| NestJS | [`@zanbug/nestjs`](https://www.npmjs.com/package/@zanbug/nestjs) |

## Quick start

```js
import { Zanbug } from '@zanbug/js';

Zanbug.init({
  apiKey: 'bb_your_project_key',   // Zanbug → project → Settings
  host: 'https://zanbug.com',
  release: '1.4.2',                // your app version
  environment: 'production',
});
```

That is the whole setup. From here on, uncaught errors, rejected promises, `console.error` calls and failed HTTP requests are reported automatically.

### Reporting an error yourself

Errors inside a `try/catch` never reach a global handler, so report them explicitly:

```js
import { Zanbug } from '@zanbug/js';

try {
  await saveOrder();
} catch (err) {
  Zanbug.capture(err, { handled: true });
}
```

### Who was affected

```js
Zanbug.setUser({ id: user.id, email: user.email, name: user.name });
Zanbug.setContext('cart', { items: 3, total: 41.5 });
Zanbug.addBreadcrumb({ type: 'manual', message: 'Checkout started' });
```

## Install without npm

For a page with no bundler, load the standalone build and use the `Zanbug` global:

```html
<script src="https://zanbug.com/sdk/zanbug.js"></script>
<script>
  Zanbug.init({ apiKey: 'bb_your_project_key', host: 'https://zanbug.com' });
</script>
```

Pin a version in production: `https://zanbug.com/sdk/zanbug-1.0.0.js`.

> **Do not use the script tag and the npm package in the same app.** Two copies of the SDK install two sets of handlers and report everything twice. Pick one.

## What is collected

| | Default | Option |
|---|---|---|
| Uncaught errors, rejected promises | on | `globalHandlers` |
| `console.error` / `console.warn` | on | `console` |
| Network calls (`fetch`, `XHR`) | on | `network` |
| Clicks and route changes | on | `domBreadcrumbs` |
| Core Web Vitals (LCP, FCP, CLS, INP, TTFB) | on | `vitals` |
| DOM snapshot at error time | on | `snapshot` |

### Privacy

Request bodies are never sent. Headers, query parameters and context keys that look like credentials (`password`, `token`, `authorization`, `cookie`, `card`, …) are replaced with `[redacted]` before anything leaves the process.

The DOM snapshot is a **serialized copy of the page**, not a pixel screenshot, and **every input value is masked** before it is sent:

```js
Zanbug.init({
  apiKey: '…',
  snapshot: {
    maskInputs: true,                       // default, keep it on
    maskSelectors: ['.invoice-total'],       // mask extra elements by selector
  },
});
```

`maskInputs` defaults to `true` and there is no reason to turn it off — with it on, a password field is stored as `••••••••`. To disable snapshots entirely:

```js
Zanbug.init({ apiKey: '…', snapshot: false });
```

## Filtering what gets reported

```js
Zanbug.init({
  apiKey: '…',
  sampleRate: 0.25,                          // report a quarter of errors
  ignoreErrors: ['ResizeObserver loop', /^AbortError/],
  beforeSend(event) {
    if (event.message?.includes('third-party-widget')) return null; // drop it
    return event;
  },
});
```

## Options

| Option | Default | Description |
|---|---|---|
| `apiKey` | — | Project key. Without it the SDK does nothing at all. |
| `host` | — | Your Zanbug host. |
| `release` | — | App version. Groups errors by release. |
| `environment` | — | `production`, `staging`, … |
| `enabled` | `true` | Set `false` to disable without removing the code. |
| `debug` | `false` | Log what the SDK is doing to the console. |
| `sampleRate` | `1` | Fraction of errors sent (`0`–`1`). |
| `maxBreadcrumbs` | `30` | Size of the breadcrumb ring buffer. |
| `ignoreErrors` | `[]` | Strings or regexes matched against the message. |
| `beforeSend` | — | Edit or drop an event. Return `null` to drop. |
| `beforeBreadcrumb` | — | Edit or drop a breadcrumb. |
| `redactKeys` | `[]` | Extra key names to redact. |

## API

```js
Zanbug.init(options)          // start; returns the client
Zanbug.capture(error, extra)  // report an error
Zanbug.captureMessage(msg)    // report a message
Zanbug.setUser(user)          // attach the signed-in user (null to clear)
Zanbug.setContext(key, value) // attach arbitrary context
Zanbug.addBreadcrumb(crumb)   // record a step
Zanbug.flush()                // await delivery (before a process exits)
Zanbug.close()                // remove every handler
Zanbug.VERSION
```

## Compatibility

- **Node.js 12 and newer**, ESM and CommonJS. Tested on 12, 14, 16, 18, 20 and 22. On versions without global `fetch` the SDK falls back to the `http`/`https` module automatically.
- **Browsers**: anything supporting ES2018. The standalone build targets ES2017.
- **TypeScript**: types are bundled, no `@types` package needed.

The SDK never throws. If it cannot report — no key, no network, an unsupported runtime — it goes quiet instead of breaking your app.

## License

MIT
