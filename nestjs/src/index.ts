/**
 * Zanbug SDK for NestJS.
 *
 * Nest wraps everything in its own exception layer, so a throwing controller
 * never reaches `uncaughtException` — it goes to the registered exception
 * filter. Same principle as every other framework adapter: hook the
 * framework's own error path, not the global one.
 *
 * Usage (module):
 *
 *   @Module({ imports: [ZanbugModule.forRoot({ apiKey: '...', host: '...' })] })
 *   export class AppModule {}
 *
 * Usage (filter only, e.g. in main.ts):
 *
 *   app.useGlobalFilters(new ZanbugExceptionFilter());
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

export function initNest(options: NodeOptions = {}) {
    return initNode({ framework: 'nestjs', ...options, sdkPackages: withOwnPackage(options.sdkPackages) });
}

/**
 * Exception filter.
 *
 * Deliberately written without Nest decorators so this package works whether or
 * not the host has `emitDecoratorMetadata` enabled, and so importing it never
 * requires reflect-metadata to be loaded first. Register it explicitly with
 * `app.useGlobalFilters(new ZanbugExceptionFilter())` or via ZanbugModule.
 */
export class ZanbugExceptionFilter {
    /**
     * @param passthrough Called after reporting, so an app that already has a
     *        formatting filter can keep it. When omitted the exception is
     *        rethrown, which lets Nest's own default filter respond.
     */
    constructor(private passthrough?: (exception: unknown, host: unknown) => unknown) {}

    catch(exception: any, host: any): unknown {
        try {
            const status = Number(
                typeof exception?.getStatus === 'function' ? exception.getStatus() : exception?.status ?? 0,
            );

            // HttpException with a 4xx is the app telling the client it did
            // something wrong — not a defect worth an alert.
            if (!(status >= 400 && status < 500)) {
                const req = extractRequest(host);
                // What the client will actually receive. A plain `throw new
                // Error()` is not an HttpException and carries no status, and
                // reporting 0 made the panel show "0" where the response was
                // really a 500. The filter decision above still uses only the
                // DECLARED status, so this cannot suppress anything.
                const res = extractResponse(host);
                const reported =
                    status || (Number(res?.statusCode) >= 400 ? Number(res.statusCode) : 500);
                // A global exception filter sees what no handler caught → UNHANDLED.
                capture(exception, {
                    handled: false,
                    type: 'nestjs.exception',
                    // Top-level `request` — the field the panel's Request tab and
                    // the route line under the error title actually read, and
                    // where every PHP SDK puts it.
                    request: requestPayload(req, reported),
                });
            }
        } catch {
            /* reporting must never replace the original exception */
        }

        if (this.passthrough) return this.passthrough(exception, host);
        throw exception;
    }
}

/** Event `request` field, matching the shape the PHP SDKs send. */
function requestPayload(req: any, status: number): Record<string, unknown> {
    const full = String(req?.originalUrl || req?.url || '');
    const qmark = full.indexOf('?');
    return {
        method: req?.method,
        url: full,
        path: qmark >= 0 ? full.slice(0, qmark) : full,
        route: req?.route?.path,
        query: req?.query,
        headers: req?.headers,
        ip: req?.ip,
        status,
    };
}

function extractRequest(host: any): any {
    try {
        // ArgumentsHost is only HTTP-shaped for HTTP requests; for RPC or
        // WebSocket contexts there is no request object and that is fine.
        if (host && typeof host.switchToHttp === 'function') {
            return host.switchToHttp().getRequest?.();
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

function extractResponse(host: any): any {
    try {
        if (host && typeof host.switchToHttp === 'function') {
            return host.switchToHttp().getResponse?.();
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

/**
 * Module that initialises the SDK on boot.
 *
 * Built as a plain object literal rather than a decorated class so that this
 * file compiles without Nest's decorator metadata; Nest accepts a dynamic
 * module descriptor either way.
 */
/**
 * Structural stand-in for Nest's `DynamicModule`.
 *
 * Declared locally rather than imported from @nestjs/common so this package
 * still builds when the peer is absent. `any[]` is deliberate: Nest's
 * `Provider[]` is a large union, and `unknown[]` is NOT assignable to it — a
 * strict `imports: [ZanbugModule.forRoot(...)]` then fails to compile, which is
 * every TypeScript Nest app.
 */
export interface ZanbugDynamicModule {
    module: typeof ZanbugModule;
    providers: any[];
    exports: any[];
    global: boolean;
}

export class ZanbugModule {
    static forRoot(options: NodeOptions = {}): ZanbugDynamicModule {
        const client = initNest(options);

        return {
            module: ZanbugModule,
            global: true,
            providers: [
                { provide: ZANBUG_CLIENT, useValue: client },
                { provide: ZANBUG_OPTIONS, useValue: options },
            ],
            exports: [ZANBUG_CLIENT, ZANBUG_OPTIONS],
        };
    }
}

/**
 * Per-request scope middleware. Register in main.ts, before the filter:
 *
 *   app.use(zanbugNestMiddleware());
 *
 * The exception filter already attaches the request to the events it reports.
 * This exists for everything else: an error captured deeper in a service, or an
 * unhandled rejection that surfaces mid-request, still gets THAT request's URL
 * and user instead of whichever request happened to write to the shared client
 * last. Nest runs on Express (or Fastify) underneath, so this is plain
 * middleware rather than a Nest interceptor — interceptors do not wrap
 * everything an async handler awaits.
 */
export function zanbugNestMiddleware(
    options: { user?: (req: any) => { id?: string | number; email?: string; name?: string } | null | undefined } = {},
) {
    return function zanbugNestScope(req: any, _res: any, next: (err?: unknown) => void) {
        try {
            if (typeof runWithRequestScope !== 'function') return next();
            const u = options.user ? options.user(req) : req?.user;
            const user = u && (u.id != null || u.email) ? { id: u.id, email: u.email, name: u.name } : undefined;
            return runWithRequestScope({ request: requestPayload(req, 0), user }, () => next());
        } catch {
            return next();
        }
    };
}

/** Injection tokens, for `@Inject(ZANBUG_CLIENT)`. */
export const ZANBUG_CLIENT = 'ZANBUG_CLIENT';
export const ZANBUG_OPTIONS = 'ZANBUG_OPTIONS';

/**
 * TypeORM logger wired for Nest's TypeOrmModule:
 *
 *   TypeOrmModule.forRoot({ ..., logger: zanbugNestTypeOrmLogger() })
 */
export { zanbugTypeOrmLogger as zanbugNestTypeOrmLogger } from '@zanbug/node';
