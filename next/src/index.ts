/**
 * Zanbug SDK for Next.js.
 *
 * Next is the reason the platform picker has a "Fullstack" group: one app runs
 * in two places at once. Errors in a Server Component, a route handler or
 * middleware happen in Node; errors in a Client Component happen in the
 * browser; and each side needs different telemetry — slow queries on the
 * server, Web Vitals and DOM snapshots in the browser.
 *
 * So this package exposes two entry points and you call both:
 *
 *   instrumentation.ts        → registerZanbug()      (server)
 *   app/layout.tsx (client)   → <ZanbugProvider />    (browser)
 */

import * as React from 'react';
import { Zanbug, capture, getClient, init } from '@zanbug/js';
import type { ZanbugOptions } from '@zanbug/js';

// Injected by tsup (see tsup.config.ts) from this package's package.json.
declare const __ZANBUG_PKG__: string;
declare const __ZANBUG_PKG_VERSION__: string;
/** This adapter's own entry for the install ping's package list. */
function withOwnPackage(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra || {}), [__ZANBUG_PKG__]: __ZANBUG_PKG_VERSION__ };
}

export * from '@zanbug/js';
export { Zanbug, capture };

/** Detect the Next.js version at runtime, for the install ping. */
async function nextVersion(): Promise<string | undefined> {
    try {
        const { dependencyVersion } = await import('@zanbug/js');
        return await dependencyVersion('next');
    } catch {
        return undefined;
    }
}

/**
 * Server-side init. Call from `instrumentation.ts` at the project root:
 *
 *   export async function register() {
 *     const { registerZanbug } = await import('@zanbug/next');
 *     await registerZanbug({ apiKey: process.env.ZANBUG_API_KEY, host: '...' });
 *   }
 *
 * Next runs `register()` once per server process, before any request — which is
 * exactly the hook an error tracker needs.
 */
export async function registerZanbug(options: ZanbugOptions = {}) {
    const { init } = await import('@zanbug/js');

    return init({
        framework: 'nextjs',
        frameworkVersion: await nextVersion(),
        environment: options.environment ?? process.env.NODE_ENV,
        // Vercel exposes the deployment SHA; it is the most reliable release
        // marker available without the app configuring one.
        release:
            options.release ??
            process.env.NEXT_PUBLIC_APP_VERSION ??
            process.env.VERCEL_GIT_COMMIT_SHA,
        ...options,
        sdkPackages: withOwnPackage(options.sdkPackages),
    });
}

/**
 * Browser-side init. Safe to call more than once — the core tears down the
 * previous client first, so React's double-invoked effects in development do
 * not install duplicate handlers.
 */
export function initZanbugClient(options: ZanbugOptions = {}) {
    // Guard against being called during SSR, where there is no window and the
    // browser integrations would have nothing to attach to.
    if (typeof window === 'undefined') return null;

    return Zanbug.init({
        framework: 'nextjs',
        environment: options.environment ?? process.env.NODE_ENV,
        release: options.release ?? process.env.NEXT_PUBLIC_APP_VERSION,
        ...options,
        sdkPackages: withOwnPackage(options.sdkPackages),
    });
}

/**
 * Make sure THIS process has a client before reporting.
 *
 * `next start` renders in worker processes separate from the one that ran
 * `instrumentation.ts`, so a route handler cannot see the client `register()`
 * created — not even through globalThis, because it is a different process.
 * Verified with a probe route: `getClient()` was null and no zanbug key existed
 * on globalThis, while the install ping from instrumentation had already
 * arrived.
 *
 * So each worker initialises itself on first use, from the environment. That is
 * the only configuration source guaranteed to be identical in every worker;
 * `ZANBUG_API_KEY` and `ZANBUG_HOST` are read by the core's option resolver.
 * Without a key this is a no-op, exactly like every other path in the SDK.
 */
function ensureServerClient(): void {
    try {
        if (typeof window !== 'undefined') return;
        if (getClient()) return;
        if (!process.env.ZANBUG_API_KEY && !process.env.BUGBAN_API_KEY) return; // legacy: bugban → zanbug (2026-10-07)

        init({
            framework: 'nextjs',
            environment: process.env.NODE_ENV,
            release:
                process.env.NEXT_PUBLIC_APP_VERSION ??
                process.env.VERCEL_GIT_COMMIT_SHA ??
                process.env.ZANBUG_RELEASE ??
                process.env.BUGBAN_RELEASE, // legacy: bugban → zanbug (2026-10-07)
            // The handshake already happened in instrumentation.ts; pinging
            // again from every worker would be pure noise.
            installPing: false,
        });
    } catch {
        // A worker that cannot self-initialise must still serve the request.
    }
}

/**
 * Client-side initialiser as a component, for the App Router.
 *
 *   // app/zanbug.tsx
 *   'use client';
 *   import { ZanbugProvider } from '@zanbug/next';
 *   export default function Zanbug() {
 *     return <ZanbugProvider apiKey={process.env.NEXT_PUBLIC_ZANBUG_KEY!} host="https://zanbug.com" />;
 *   }
 *
 *   // app/layout.tsx — render it once, inside <body>
 *
 * Renders nothing. It exists because a Server Component layout cannot call
 * init() itself, and an effect is the only place guaranteed to run in the
 * browser exactly once per mount.
 */
export function ZanbugProvider(props: ZanbugOptions & { children?: React.ReactNode }): React.ReactNode {
    const { children, ...options } = props;

    // A ref, not state: initialising twice would be harmless (the core tears
    // the old client down) but it would also re-send breadcrumb state, so it is
    // cheaper to simply skip.
    const started = React.useRef(false);

    React.useEffect(() => {
        if (started.current) return;
        started.current = true;
        initZanbugClient(options as ZanbugOptions);
        // Options are captured once on mount on purpose: an api key that
        // changes between renders is a bug, not a feature to support.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return children ?? null;
}

/**
 * Report an error from a Next.js error boundary.
 *
 *   // app/error.tsx
 *   'use client';
 *   export default function Error({ error, reset }) {
 *     useEffect(() => { captureNextError(error); }, [error]);
 *     return <button onClick={reset}>Try again</button>;
 *   }
 *
 * Next attaches a `digest` to server-thrown errors and hides the real message
 * from the client — so the digest is the only way to line the client-side
 * report up with the server-side one. It is sent as context for exactly that.
 */
export function captureNextError(
    error: unknown,
    extra?: { context?: Record<string, unknown> },
): void {
    const digest = (error as { digest?: string } | null | undefined)?.digest;

    // error.tsx renders only for an uncaught render error → UNHANDLED.
    capture(error, {
        handled: false,
        type: 'nextjs.error-boundary',
        context: {
            ...extra?.context,
            nextjs: digest ? { digest } : undefined,
        },
    });
}

/**
 * Wrap a route handler or server action so thrown errors are reported before
 * they bubble up to Next's own handler.
 *
 *   export const POST = withZanbugRoute(async (req) => { ... });
 */
/**
 * Event `request` field built from a Web `Request` (App Router) or a Node-style
 * `req` (Pages Router / middleware). Returns undefined for anything else —
 * a route handler can be called with no request at all in tests.
 */
function routeRequestPayload(arg: unknown): Record<string, unknown> | undefined {
    try {
        const r = arg as any;
        if (!r || typeof r !== 'object') return undefined;

        const raw = typeof r.url === 'string' ? r.url : undefined;
        if (!raw) return undefined;

        let path = raw;
        let query: Record<string, string> | undefined;
        try {
            // App Router gives an absolute URL; Pages Router a path.
            const u = new URL(raw, 'http://localhost');
            path = u.pathname;
            if (u.search) {
                query = {};
                u.searchParams.forEach((v, k) => {
                    query![k] = v;
                });
            }
        } catch {
            /* keep the raw value */
        }

        // Headers is an iterable Map-alike in the App Router, a plain object in
        // the Pages Router.
        let headers: Record<string, unknown> | undefined;
        try {
            if (r.headers && typeof r.headers.forEach === 'function' && typeof r.headers.get === 'function') {
                headers = {};
                r.headers.forEach((v: string, k: string) => {
                    headers![k] = v;
                });
            } else if (r.headers && typeof r.headers === 'object') {
                headers = r.headers;
            }
        } catch {
            /* headers are optional */
        }

        // An exception escaping a route handler is a 500 by definition — Next
        // has no chance to send anything else. Reporting 0 here made the panel
        // show "0" for what the client actually received.
        return { method: r.method || 'GET', url: raw, path, query, headers, status: 500 };
    } catch {
        return undefined;
    }
}

export function withZanbugRoute<A extends unknown[], R>(
    handler: (...args: A) => Promise<R> | R,
    meta: { name?: string } = {},
): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
        ensureServerClient();
        try {
            return await handler(...args);
        } catch (error) {
            // The wrapper caught what the route handler let escape → UNHANDLED.
            capture(error, {
                handled: false,
                type: 'nextjs.route',
                context: meta.name ? { nextjs: { handler: meta.name } } : undefined,
                // Next passes the Request as the first argument, so the panel's
                // Request tab and the route line can be filled in without the
                // app threading anything through.
                request: routeRequestPayload(args[0]),
            });
            // Rethrow: swallowing it here would turn a 500 into a silent
            // success and break the app's own error handling.
            throw error;
        }
    };
}
