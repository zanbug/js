<p align="center"><img src="https://zanbug.com/logo.png" alt="Zanbug" width="120"></p>

# @zanbug/react

[Zanbug](https://zanbug.com) error and performance monitoring for React. Works with Vite, Create React App, Parcel — anything that bundles React.

```bash
npm install @zanbug/react
```

## Why the adapter

React swallows errors thrown during render and shows a blank screen. They never reach `window.onerror`, so a global handler cannot see them — only an error boundary can. This package adds one, plus the component stack, which is the piece a minified stack trace cannot give you.

## Setup

```jsx
// main.jsx — before rendering
import { initReact } from '@zanbug/react';

initReact({
  apiKey: import.meta.env.VITE_ZANBUG_KEY,
  host: 'https://zanbug.com',
  release: import.meta.env.VITE_APP_VERSION,
  environment: import.meta.env.MODE,
});
```

Then wrap your tree:

```jsx
import { ZanbugErrorBoundary } from '@zanbug/react';

<ZanbugErrorBoundary
  fallback={(error, reset) => (
    <div>
      <p>Something went wrong.</p>
      <button onClick={reset}>Try again</button>
    </div>
  )}
>
  <App />
</ZanbugErrorBoundary>
```

Recover automatically on route change:

```jsx
<ZanbugErrorBoundary resetKeys={[location.pathname]}>
  <Routes />
</ZanbugErrorBoundary>
```

## Errors a boundary cannot catch

Event handlers and effects run outside render, so React does not route their errors to a boundary. Report those yourself:

```jsx
import { useZanbugCapture } from '@zanbug/react';

function SaveButton() {
  const report = useZanbugCapture();

  const onClick = async () => {
    try {
      await save();
    } catch (err) {
      report(err, { screen: 'checkout' });
    }
  };

  return <button onClick={onClick}>Save</button>;
}
```

## Wrapping a single component

```jsx
import { withZanbug } from '@zanbug/react';

export default withZanbug(Dashboard, { fallback: <Oops /> });
```

## Everything else

Uncaught errors, `console.error`, failed network calls, Core Web Vitals and the DOM snapshot come from [`@zanbug/js`](https://www.npmjs.com/package/@zanbug/js) and are on by default. See its README for options, privacy and redaction — including input masking in snapshots.

Requires React 16.8 or newer.

## License

MIT
