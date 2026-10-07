/**
 * Per-request scope for Node servers.
 *
 * THE PROBLEM THIS SOLVES — read before changing anything here.
 *
 * On the PHP side one process serves one request, so `Zanbug::setUser()`
 * writing to a process-wide client is correct and always has been. Node is the
 * opposite: one client object serves every concurrent request. A middleware
 * that calls `Zanbug.setUser(req.user)` therefore overwrites whatever the
 * previous request wrote, and an error thrown in request A gets reported
 * carrying request B's identity. That is not a cosmetic bug — it is a privacy
 * leak that puts one customer's email on another customer's error.
 *
 * AsyncLocalStorage is the only mechanism in Node that survives every `await`
 * and callback of a request without threading a parameter through the whole
 * app. It has been available since Node 12.17; we still feature-detect, because
 * a Zanbug install must never be the reason a runtime fails to boot.
 *
 * When ALS is unavailable, `runWithRequestScope` simply runs the callback and
 * scope reads return the last-set values. Degraded, but never broken.
 */

import type { ScopeData } from '@zanbug/js';

type AlsLike = {
    getStore(): ScopeData | undefined;
    run<T>(store: ScopeData, fn: () => T): T;
};

/**
 * `async_hooks` loaded so that a bundler cannot statically resolve it — the
 * same trick the core uses for `os`/`http`. A static import would make this
 * module unloadable in any runtime without the built-in (Vercel Edge without
 * nodejs_compat, some browser bundles that pull a server file in by mistake),
 * and an unloadable module takes the host application down with it.
 */
function loadAls(): AlsLike | null {
    try {
        const req: any =
            typeof module !== 'undefined' && typeof (module as any).require === 'function'
                ? (module as any).require
                : typeof (globalThis as any).require === 'function'
                  ? (globalThis as any).require
                  : undefined;

        // Under ESM there is no `require` here at all. Rather than reach for
        // createRequire (which needs a module URL this file cannot see), leave
        // `als` null and let the async import below fill it in.
        if (!req) return null;

        const ALS = req('async_hooks')?.AsyncLocalStorage;
        return ALS ? (new ALS() as AlsLike) : null;
    } catch {
        return null;
    }
}

let als: AlsLike | null = loadAls();

/**
 * ESM fallback.
 *
 * Under ESM the synchronous paths above find no `require`, so `async_hooks` is
 * imported asynchronously and swapped in when it resolves. The window before it
 * lands is the process's first few milliseconds — well before any request — so
 * in practice no request runs unscoped.
 */
if (!als) {
    try {
        void import(/* @vite-ignore */ /* webpackIgnore: true */ 'node:async_hooks')
            .then((ns: any) => {
                const ALS = ns?.AsyncLocalStorage || ns?.default?.AsyncLocalStorage;
                if (ALS && !als) als = new ALS() as AlsLike;
            })
            .catch(() => {
                /* no ALS in this runtime — degrade, do not throw */
            });
    } catch {
        /* import() itself unavailable (very old CJS) */
    }
}

/** Used only when ALS is unavailable, so behaviour degrades instead of failing. */
let fallbackScope: ScopeData | null = null;

/** True when real per-request isolation is active. */
export function hasRequestIsolation(): boolean {
    return als !== null;
}

/** The scope of the request currently executing, if any. */
export function currentScope(): ScopeData | undefined {
    try {
        return als ? als.getStore() : fallbackScope || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Run `fn` with a fresh scope. Everything the request awaits — including code
 * the app wrote, in files that never import Zanbug — sees this scope.
 */
export function runWithRequestScope<T>(initial: ScopeData, fn: () => T): T {
    if (!als) {
        fallbackScope = initial;
        try {
            return fn();
        } finally {
            fallbackScope = null;
        }
    }
    return als.run(initial, fn);
}

/** Attach the signed-in user to the CURRENT request only. */
export function setRequestUser(user: ScopeData['user']): void {
    const s = currentScope();
    if (s) s.user = user;
    else if (!als) fallbackScope = { ...(fallbackScope || {}), user };
}

/** Merge keys into the current request's context. */
export function setRequestContext(key: string, value: unknown): void {
    const s = currentScope();
    if (s) s.context = { ...(s.context || {}), [key]: value };
}

/** Replace the current request's HTTP details (method/url/headers/...). */
export function setRequestInfo(request: Record<string, unknown>): void {
    const s = currentScope();
    if (s) s.request = request;
}
