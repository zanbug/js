/**
 * Zanbug SDK for Express.
 *
 * Express does not let an uncaught error reach `uncaughtException` — it hands it
 * to the error middleware chain instead. So, exactly as with Laravel's report()
 * or Yii's ErrorHandler on the PHP side, the global handlers the core installs
 * are not enough: a route that throws must be captured by middleware.
 *
 * Usage:
 *
 *   const app = express();
 *   app.use(zanbugRequestHandler());   // first, before your routes
 *   ... your routes ...
 *   app.use(zanbugErrorHandler());     // last, after your routes
 */

import { Zanbug, initNode, capture, recordQuery, runWithRequestScope } from '@zanbug/node';
import type { NodeOptions } from '@zanbug/node';

// Injected by tsup (see tsup.config.ts) from this package's package.json.
declare const __ZANBUG_PKG__: string;
declare const __ZANBUG_PKG_VERSION__: string;
/** This adapter's own entry for the install ping's package list. */
function withOwnPackage(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra || {}), [__ZANBUG_PKG__]: __ZANBUG_PKG_VERSION__ };
}

export * from '@zanbug/node';
export { Zanbug, capture, recordQuery };

/** Structural types, so this package does not have to import express. */
interface ReqLike {
    method?: string;
    originalUrl?: string;
    url?: string;
    headers?: Record<string, unknown>;
    ip?: string;
    route?: { path?: string };
    user?: unknown;
}
interface ResLike {
    statusCode?: number;
    on?: (event: string, cb: () => void) => void;
}
type NextFn = (err?: unknown) => void;

export function initExpress(options: NodeOptions = {}) {
    return initNode({ framework: 'express', ...options, sdkPackages: withOwnPackage(options.sdkPackages) });
}

export interface RequestHandlerOptions {
    /**
     * Attach the signed-in user to events. Receives the request and returns
     * whatever your app stores — `req.user` is used when this is omitted.
     */
    user?: (req: ReqLike) => { id?: string | number; email?: string; name?: string } | null | undefined;
    /** Record every request as a breadcrumb, not just failures. */
    breadcrumbs?: boolean;
}

/**
 * Per-request context: the route, method and user that were active when an
 * error happened. Without this an event says "TypeError" with no indication of
 * which endpoint produced it.
 */
export function zanbugRequestHandler(options: RequestHandlerOptions = {}) {
    return function zanbugRequest(req: ReqLike, res: ResLike, next: NextFn) {
        let scoped = false;
        try {
            const url = req.originalUrl || req.url || '';

            if (options.breadcrumbs) {
                Zanbug.addBreadcrumb({
                    type: 'navigation',
                    message: `${req.method || 'GET'} ${url}`,
                });
            }

            const u = options.user ? options.user(req) : (req.user as any);
            const user = u && (u.id != null || u.email) ? { id: u.id, email: u.email, name: u.name } : undefined;

            // Per-request store, NOT client-wide state.
            //
            // Zanbug.setUser() here would write the signed-in user onto the one
            // client this process shares between every concurrent request, so a
            // slow request could be reported carrying a later request's
            // identity. runWithRequestScope keeps it to this request, and every
            // await inside next() still sees it.
            if (typeof runWithRequestScope === 'function') {
                scoped = true;
                return runWithRequestScope({ request: requestPayload(req), user }, () => next());
            }

            // Older @zanbug/node without scope support: keep the previous
            // behaviour rather than losing context entirely.
            Zanbug.setContext('request', { method: req.method, url, ip: req.ip });
            if (user) Zanbug.setUser(user);
        } catch {
            /* context enrichment must never block the request */
        }
        if (!scoped) next();
    };
}

/**
 * The `request` field of an event, in the shape the PHP SDKs already send —
 * which is what the panel's Request tab and the route line under the error
 * title read. Headers are redacted by the core before they leave the process.
 */
function requestPayload(req: ReqLike): Record<string, unknown> {
    const full = req.originalUrl || req.url || '';
    const qmark = full.indexOf('?');
    return {
        method: req.method,
        url: full,
        path: qmark >= 0 ? full.slice(0, qmark) : full,
        // The route PATTERN (/users/:id) once routing has happened.
        route: req.route?.path,
        query: (req as any).query,
        headers: req.headers,
        ip: req.ip,
    };
}

/**
 * Error middleware. Must be registered AFTER all routes — Express identifies
 * error middleware by its four-argument signature, so the unused `next`
 * parameter is load-bearing and cannot be removed.
 */
export function zanbugErrorHandler(
    options: { shouldCapture?: (err: any) => boolean } = {},
) {
    return function zanbugError(err: any, req: ReqLike, res: ResLike, next: NextFn) {
        try {
            // 4xx thrown deliberately (validation, not-found) is not a bug.
            // Anything without a status, or 5xx, is.
            const status = Number(err?.status ?? err?.statusCode ?? 0);
            const worth = options.shouldCapture
                ? options.shouldCapture(err)
                : !(status >= 400 && status < 500);

            if (worth) {
                // What the client will actually receive. A plain `throw new
                // Error()` carries no status, and reporting 0 made the panel
                // show "0" where the response was really a 500. The filter
                // decision above still uses only the DECLARED status, so this
                // fallback cannot start suppressing errors that used to report.
                const reported =
                    status || (Number(res?.statusCode) >= 400 ? Number(res.statusCode) : 500);
                // The error middleware runs only when no route handled it → UNHANDLED.
                capture(err, {
                    handled: false,
                    type: 'express.error',
                    // Top-level `request`, not context.request: that is the field
                    // the panel's Request tab and the route line read, and it is
                    // where every PHP SDK puts it. By now routing has happened,
                    // so req.route holds the PATTERN (/users/:id) — which is what
                    // groups errors usefully, unlike the concrete URL.
                    request: { ...requestPayload(req), status: reported },
                });
            }
        } catch {
            /* fall through to the app's own handler no matter what */
        }
        next(err);
    };
}
