/**
 * Zanbug SDK for Vue 3 (and Vue 2.7+ via app.config).
 *
 * Vue routes component errors through its own `errorHandler` instead of letting
 * them reach window.onerror — the same pattern as Yii2's ErrorHandler on the
 * PHP side. So without this plugin the core SDK sees nothing from a broken
 * render, only unrelated global errors.
 */

import { Zanbug, init as coreInit, capture } from '@zanbug/js';
import type { ZanbugOptions } from '@zanbug/js';

// Injected by tsup (see tsup.config.ts) from this package's package.json.
declare const __ZANBUG_PKG__: string;
declare const __ZANBUG_PKG_VERSION__: string;
/** This adapter's own entry for the install ping's package list. */
function withOwnPackage(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra || {}), [__ZANBUG_PKG__]: __ZANBUG_PKG_VERSION__ };
}

export * from '@zanbug/js';
export { Zanbug };

/** Minimal shape of what we need from a Vue app — avoids depending on vue. */
interface VueAppLike {
    config: {
        errorHandler?: (err: unknown, instance: unknown, info: string) => void;
        warnHandler?: (msg: string, instance: unknown, trace: string) => void;
        globalProperties?: Record<string, unknown>;
    };
    version?: string;
}

export interface VueOptions extends ZanbugOptions {
    /**
     * Also report Vue's dev-mode warnings. Off by default: they are noisy and
     * only appear in development builds, so they would drown real errors.
     */
    captureWarnings?: boolean;
    /** Expose `this.$zanbug` in Options API components. */
    globalProperty?: boolean;
}

/**
 * Vue plugin.
 *
 *   import { createApp } from 'vue';
 *   import { zanbugVue } from '@zanbug/vue';
 *
 *   createApp(App).use(zanbugVue, { apiKey: '...', host: 'https://zanbug.com' }).mount('#app');
 */
export const zanbugVue = {
    install(app: VueAppLike, options: VueOptions = {}) {
        const client = coreInit({
            framework: 'vue',
            frameworkVersion: app && app.version ? String(app.version) : undefined,
            ...options,
            sdkPackages: withOwnPackage(options.sdkPackages),
        });

        try {
            // Chain rather than replace: an app that already set an
            // errorHandler must keep working.
            const previous = app.config.errorHandler;
            app.config.errorHandler = (err, instance, info) => {
                // Vue's global errorHandler is the last stop → UNHANDLED.
                capture(err, {
                    handled: false,
                    type: 'vue.error',
                    // `info` is Vue's own description of where it happened
                    // ("render function", "watcher callback"), which is the
                    // closest thing Vue gives us to a component stack.
                    context: {
                        vue: {
                            lifecycle_hook: info,
                            component: componentName(instance),
                        },
                    },
                });
                if (typeof previous === 'function') previous(err, instance, info);
            };

            if (options.captureWarnings) {
                const prevWarn = app.config.warnHandler;
                app.config.warnHandler = (msg, instance, trace) => {
                    Zanbug.addBreadcrumb({
                        type: 'console',
                        level: 'warning',
                        message: `Vue warning: ${msg}`,
                        data: { component: componentName(instance), trace: String(trace).slice(0, 500) },
                    });
                    if (typeof prevWarn === 'function') prevWarn(msg, instance, trace);
                };
            }

            if (options.globalProperty !== false && app.config.globalProperties) {
                app.config.globalProperties.$zanbug = Zanbug;
            }
        } catch {
            // A failure wiring the handlers must not stop the app from booting.
        }

        return client;
    },
};

function componentName(instance: unknown): string | undefined {
    try {
        const i = instance as any;
        return (
            i?.type?.name ||
            i?.type?.__name ||
            i?.$options?.name ||
            i?.$options?.__file ||
            undefined
        );
    } catch {
        return undefined;
    }
}

/**
 * Composition API helper for errors that Vue's errorHandler never sees —
 * anything inside an async event handler.
 *
 *   const report = useZanbug();
 *   try { await save(); } catch (e) { report(e); }
 */
export function useZanbug() {
    return (error: unknown, context?: Record<string, unknown>) =>
        capture(error, { handled: true, type: 'vue.handler', context });
}

/** Alias, so `app.use(ZanbugPlugin, {...})` reads naturally too. */
export const ZanbugPlugin = zanbugVue;
