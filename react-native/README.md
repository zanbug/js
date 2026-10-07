<p align="center"><img src="https://zanbug.com/logo.png" alt="Zanbug" width="120"></p>

# @zanbug/react-native

Crash reporting and performance monitoring for **React Native and Expo**, reporting to your own
[Zanbug](https://zanbug.com) server. Your errors, screenshots and user data stay on infrastructure
you control.

```bash
npm install @zanbug/react-native
```

## Quick start

```js
import { initZanbug } from '@zanbug/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

initZanbug({
  apiKey: 'bb_your_project_key',
  host: 'https://zanbug.com',
  release: '1.4.0',
  environment: __DEV__ ? 'development' : 'production',

  // Passed in by YOUR app, never imported by the SDK — see "Why you pass these in".
  storage: AsyncStorage,
});
```

That is the whole setup. From here, an unhandled JS error, a rejected promise or a failed HTTP call
arrives in your Zanbug panel with the stack trace, the device, the screen and the breadcrumbs that
led there.

## What it captures

| | |
|---|---|
| **Unhandled errors** | Hooks `ErrorUtils.setGlobalHandler` and **chains** the previous handler, so the dev red box and any reporter you already had keep working. |
| **Unhandled promise rejections** | Through Hermes' `enablePromiseRejectionTracker` (RN 0.70+ default engine). |
| **HTTP failures** | `fetch` and `XMLHttpRequest` are wrapped. 5xx and transport errors become their own `HttpError` event; 4xx stays a breadcrumb, because a 401 is usually the app working correctly. Method, URL, status and duration only — **never headers or bodies**, which on a phone is where the auth token and the card number live. |
| **Screenshots** | A real PNG of the screen at error time, with `<ZanbugMask>` regions painted over **before** the shutter. |
| **Device and app** | OS, OS version, model, screen size, app version and build. |
| **Performance** | `APP_START`, `SCREEN_LOAD` and `JANK`, measured in short windows rather than a permanent frame loop — a loop that schedules work every frame is a battery cost you would feel. |
| **Breadcrumbs** | Navigation, HTTP calls, console output and anything you add with `addBreadcrumb()`. |

### Every error gets a screenshot (1.4.0)

Once `screenshot` is configured, the adapter hands the capture function to the
core, so **every** captured error carries a picture of the current screen — a
plain `Zanbug.capture(e)` from a `try/catch`, a failed HTTP request reported by
the network integration, and (best effort) a fatal. Before 1.4.0 only
`captureWithScreenshot()` and the global handler attached one.

The event is written to the offline queue **first** and the screenshot is
attached afterwards, bounded to 2 s, so a slow or failing capture never costs
the error itself. `captureMessage()` events get no screenshot.

## Offline queue — why it matters on mobile

A phone loses signal in a lift and a fatal error kills the process before a request can finish. The
queue is therefore written to disk **before** sending and cleared only once the server has accepted
it, so a crash with no connection is still reported the next time the app opens.

```js
initZanbug({ apiKey: 'bb_…', host: 'https://zanbug.com', storage: AsyncStorage });
```

Without `storage` the SDK still works, but a report that cannot be sent right now is lost with the
process. A 4xx response counts as delivered on purpose — otherwise a wrong API key would replay the
same rejected payload on every launch, forever.

## Masking a screenshot

Wrapping a subtree marks it for masking. The children are **not unmounted**, so state is kept and
the layout does not jump; an overlay is painted over them for the capture only.

```jsx
import { ZanbugMask } from '@zanbug/react-native/mask';

<ZanbugMask>
  <Text>{cardNumber}</Text>
</ZanbugMask>
```

> The older advice — `collapsable={false}` and `renderToHardwareTextureAndroid` — **does not work**.
> `react-native-view-shot` cannot skip a view, so the card number was captured in full while the
> payload claimed `masked: true`. `ZanbugMask` reports `masked` only when an overlay was really
> drawn.

To enable screenshots, pass the capture function from your app:

```js
import { captureScreen } from 'react-native-view-shot';

initZanbug({
  /* … */
  screenshot: { capture: () => captureScreen({ format: 'png', result: 'base64' }) },
});
```

## Why you pass `storage` and `screenshot` in

Metro resolves `require` at **build** time. If this package imported `@react-native-async-storage/…`
or `react-native-view-shot` itself, every app that does not install them would fail to build — not
at runtime, where a `try/catch` could help, but at bundling, where nothing can. So the SDK depends on
neither and takes them as arguments.

## Identifying the user

```js
import { setUser, setContext, addBreadcrumb } from '@zanbug/react-native';

setUser({ id: 42, email: 'user@example.com' });
setContext({ cart_items: 3 });
addBreadcrumb({ category: 'checkout', message: 'Pressed pay' });
```

## Options

| Option | Default | What it does |
|---|---|---|
| `apiKey` | — | Project key from the Zanbug panel. Without it the SDK is a silent no-op. |
| `host` | — | Your Zanbug server. |
| `release` / `environment` | — | Shown on every event; `release` is what tells you which build introduced a bug. |
| `storage` | — | AsyncStorage-compatible object; enables the offline queue. |
| `screenshot` | — | `{ capture }` — enables PNG capture. |
| `captureHttp` | `true` | Wrap `fetch` / XHR. |
| `httpIgnoreUrls` | `[]` | Substrings or RegExps that must never be reported. |
| `maxBreadcrumbs` | `30` | Ring buffer size. |
| `beforeSend` | — | Last chance to edit or drop an event; return `null` to discard. |

## Compatibility

Verified by **building real apps**, not by inspection:

| | |
|---|---|
| React Native 0.71.19 (Metro 0.73, React 18.2) | bundles, `/mask` subpath included |
| React Native 0.76.5 (Metro 0.81, React 19) | release APK, full behaviour on a device |
| Expo 57 / RN 0.86 | `expo export` — 590 modules, 1.5 MB Hermes bundle |

The SDK never throws. A network failure, a malformed response or a missing permission ends as a
dropped report, never as a crash in your app.

## Privacy

Query-string secrets are redacted before a URL is stored, request and response bodies are never
collected, and screenshots are masked in the app before the image exists. Everything is sent to
**your** server — there is no third party in the path.

---

Part of the Zanbug SDK family: [`@zanbug/js`](https://www.npmjs.com/package/@zanbug/js) (core),
[`@zanbug/node`](https://www.npmjs.com/package/@zanbug/node),
[`@zanbug/express`](https://www.npmjs.com/package/@zanbug/express),
[`@zanbug/nestjs`](https://www.npmjs.com/package/@zanbug/nestjs),
[`@zanbug/next`](https://www.npmjs.com/package/@zanbug/next),
[`@zanbug/react`](https://www.npmjs.com/package/@zanbug/react),
[`@zanbug/vue`](https://www.npmjs.com/package/@zanbug/vue).

MIT © Zanbug
