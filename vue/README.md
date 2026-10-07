<p align="center"><img src="https://zanbug.com/logo.png" alt="Zanbug" width="120"></p>

# @zanbug/vue

[Zanbug](https://zanbug.com) error and performance monitoring for Vue 3 (and Vue 2.7+).

```bash
npm install @zanbug/vue
```

## Why the adapter

Vue routes component errors through its own `app.config.errorHandler` instead of letting them reach `window.onerror`. Without this plugin a broken render is invisible to the SDK.

## Setup

```js
import { createApp } from 'vue';
import { zanbugVue } from '@zanbug/vue';
import App from './App.vue';

createApp(App)
  .use(zanbugVue, {
    apiKey: import.meta.env.VITE_ZANBUG_KEY,
    host: 'https://zanbug.com',
    release: import.meta.env.VITE_APP_VERSION,
    environment: import.meta.env.MODE,
  })
  .mount('#app');
```

The plugin chains onto any `errorHandler` you already set — yours still runs.

Each report includes the component name and Vue's own description of where it happened (`render function`, `watcher callback`, …), which is as close to a component stack as Vue provides.

## Errors Vue does not route

Async event handlers throw outside Vue's error path, so report those yourself:

```vue
<script setup>
import { useZanbug } from '@zanbug/vue';

const report = useZanbug();

async function save() {
  try {
    await api.save();
  } catch (err) {
    report(err, { screen: 'settings' });
  }
}
</script>
```

In the Options API the same client is available as `this.$zanbug`.

## Options

Everything [`@zanbug/js`](https://www.npmjs.com/package/@zanbug/js) accepts, plus:

| Option | Default | Description |
|---|---|---|
| `captureWarnings` | `false` | Record Vue's dev-mode warnings as breadcrumbs. Noisy, and development-only. |
| `globalProperty` | `true` | Expose `this.$zanbug`. |

Uncaught errors, `console.error`, failed network calls, Core Web Vitals and the DOM snapshot are handled by the core and on by default — see its README for privacy and redaction details.

## License

MIT
