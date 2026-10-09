/**
 * Zanbug SDK for Node.js.
 *
 * The core already installs `uncaughtException` / `unhandledRejection`
 * handlers, so this package exists for the things only a server can report:
 * slow database queries, and request-scoped context.
 *
 * Slow queries are what feed the Performance tab — the same feature the PHP
 * SDKs provide via DB::listen / Doctrine / Yii profiling. Node has no single
 * database layer, so each ORM gets its own small hook below.
 */

import { Zanbug, init as coreInit, capture, legacyEnvKey } from '@zanbug/js';
import type { ZanbugOptions, ScopeData } from '@zanbug/js';
import { currentScope, runWithRequestScope } from './scope';
import { maybeAutoUpdate } from './update';

export * from '@zanbug/js';
export { Zanbug };
export {
    currentScope,
    hasRequestIsolation,
    runWithRequestScope,
    setRequestContext,
    setRequestInfo,
    setRequestUser,
} from './scope';

// Injected by tsup (see tsup.config.ts) from this package's package.json.
declare const __ZANBUG_PKG__: string;
declare const __ZANBUG_PKG_VERSION__: string;
/** This adapter's own entry for the install ping's package list. */
function withOwnPackage(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra || {}), [__ZANBUG_PKG__]: __ZANBUG_PKG_VERSION__ };
}

/** Default threshold, matching the PHP SDK's ZANBUG_SLOW_QUERY_MS. */
export const DEFAULT_SLOW_QUERY_MS = 1000;

export interface NodeOptions extends ZanbugOptions {
    /** Report queries at or above this duration, in ms. */
    slowQueryMs?: number;
    /** Set false to stop capturing queries entirely. */
    captureQueries?: boolean;
    /**
     * EXPLAIN slow SELECTs so the panel can say whether an index was used.
     * Costs one extra planning round-trip per slow query. Default true, same as
     * ZANBUG_EXPLAIN_QUERIES in the PHP SDK.
     */
    explainQueries?: boolean;
    /**
     * Opt-in: once a day, ask the panel for the newest @zanbug/* release and,
     * if there is one, run `npx zanbug update --yes` detached in the project
     * root (log: <tmpdir>/zanbug-update.log). Same as ZANBUG_AUTO_UPDATE=true.
     * Default false — unattended dependency upgrades are a deployment decision.
     */
    autoUpdate?: boolean;
}

let slowQueryMs = DEFAULT_SLOW_QUERY_MS;
let captureQueries = true;
let explainQueries = true;

export function initNode(options: NodeOptions = {}) {
    slowQueryMs = options.slowQueryMs ?? envInt('ZANBUG_SLOW_QUERY_MS', DEFAULT_SLOW_QUERY_MS);
    captureQueries = options.captureQueries ?? envBool('ZANBUG_CAPTURE_QUERIES', true);
    explainQueries = options.explainQueries ?? envBool('ZANBUG_EXPLAIN_QUERIES', true);

    const autoUpdate = options.autoUpdate ?? envBool('ZANBUG_AUTO_UPDATE', false);

    const client = coreInit({
        framework: options.framework || 'node',
        ...options,
        // Reported on the install ping: which @zanbug/* packages, and whether
        // this install updates itself.
        sdkPackages: withOwnPackage(options.sdkPackages),
        autoUpdate,
    });

    // Hand the core its per-request lookup, so an error captured anywhere during
    // a request carries THAT request's user/URL — see scope.ts for why.
    //
    // Feature-detected, not assumed. A mixed install can pair this adapter with
    // an older core, and calling a method that does not exist is a fatal error
    // that takes the host app down. That is not hypothetical: on the PHP side
    // `Client::setQueryRunner()` missing from an older core did exactly that to
    // a live customer site. An `if` is the whole fix.
    try {
        const anyClient = client as unknown as {
            setScopeProvider?: (p: () => ScopeData | undefined) => void;
        };
        if (typeof anyClient.setScopeProvider === 'function') {
            anyClient.setScopeProvider(() => currentScope());
        }
    } catch {
        /* older core, or no scope support — events simply carry less context */
    }

    // Run attribution: which job (inside a long-lived worker) a query or error
    // belongs to is read from the SAME async scope, so parallel jobs never mix.
    try {
        const anyClient = client as unknown as {
            setJobProvider?: (p: () => string | null | undefined) => void;
        };
        if (typeof anyClient.setJobProvider === 'function') {
            anyClient.setJobProvider(() => currentScope()?.job);
        }
    } catch {
        /* older core without run attribution */
    }

    // Opt-in self-update. Off the hot path and fully guarded — see update.ts.
    if (autoUpdate) {
        try {
            maybeAutoUpdate({ apiKey: options.apiKey, host: options.host });
        } catch {
            /* never let the updater affect the host app */
        }
    }

    return client;
}

function envRaw(key: string): string | undefined {
    if (typeof process === 'undefined' || !process.env) return undefined;
    const v = process.env[key];
    if (v != null && v !== '') return v;
    const legacy = legacyEnvKey(key); // legacy: bugban → zanbug (2026-10-07)
    return legacy ? process.env[legacy] : undefined;
}

function envInt(key: string, fallback: number): number {
    const raw = envRaw(key);
    const n = raw ? parseInt(raw, 10) : NaN;
    return isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
    const raw = envRaw(key);
    if (raw == null || raw === '') return fallback;
    return !/^(0|false|off|no)$/i.test(raw);
}

export interface QueryRecord {
    sql: string;
    durationMs: number;
    connection?: string;
    bindings?: unknown[];
    url?: string;
    method?: string;
    /**
     * The query plan, shaped for the server's `indexStatusFromExplain()`:
     * `{ driver: 'pgsql' | 'mysql', raw: <whatever EXPLAIN returned> }`.
     * Optional — a query with no plan still shows up, just without the badge.
     */
    explain?: Record<string, unknown>;
}

/**
 * Report one query. Below the threshold it is dropped here, so callers can hook
 * every query without worrying about volume — exactly like the PHP SDK.
 *
 * Two call shapes are accepted on purpose:
 *
 *   recordQuery({ sql, durationMs, bindings })        // idiomatic JS
 *   recordQuery(sql, durationMs, { bindings })        // same as the PHP facade
 *
 * The second exists because customers port their integration from the PHP SDK,
 * where the signature is `Zanbug::recordQuery($sql, $ms, $ctx)`. Accepting only
 * the object form made that call a SILENT no-op: no error, no query, just an
 * empty Performance tab. Silence is the worst possible failure for telemetry.
 */
export function recordQuery(q: QueryRecord): void;
export function recordQuery(
    sql: string,
    durationMs: number,
    context?: { connection?: string; bindings?: unknown[]; url?: string; method?: string },
): void;
export function recordQuery(
    a: QueryRecord | string,
    b?: number,
    c?: { connection?: string; bindings?: unknown[]; url?: string; method?: string },
): void {
    const q: QueryRecord =
        typeof a === 'string'
            ? { sql: a, durationMs: Number(b), connection: c?.connection, bindings: c?.bindings, url: c?.url, method: c?.method }
            : a;

    try {
        if (!captureQueries) return;
        if (!q || !q.sql || !isFinite(q.durationMs)) return;
        // Every query (fast ones too) counts toward the current run's DB time —
        // that total is what tells a cron apart from a cron that hammers the DB.
        noteQueryGuarded(q.durationMs, q.durationMs >= slowQueryMs);
        if (q.durationMs < slowQueryMs) return;

        Zanbug.recordMetric({
            name: 'SLOW_QUERY',
            value: Math.round(q.durationMs),
            data: {
                sql: String(q.sql).slice(0, 5000),
                connection: q.connection,
                bindings: Array.isArray(q.bindings) ? q.bindings.slice(0, 30) : undefined,
                url: q.url,
                method: q.method,
                explain: q.explain,
            },
        });
    } catch {
        /* never let telemetry break a query path */
    }
}

function noteQueryGuarded(durationMs: number, slow: boolean): void {
    try {
        const b = Zanbug as unknown as { noteQuery?: (ms: number, slow: boolean) => void };
        if (typeof b.noteQuery === 'function') b.noteQuery(durationMs, slow);
    } catch {
        /* older core */
    }
}

/**
 * Run one unit of work (a queue job, a scheduled task, a message handler) as
 * its own run inside a long-lived worker: duration, CPU, DB time and outcome
 * are recorded per job, and any error thrown inside is attributed to it.
 * The job handle lives in AsyncLocalStorage, so concurrent jobs stay apart.
 *
 *   await runJob('SendInvoiceEmail', () => handle(msg));
 *   await runJob('nightly-report', run, 'cron');
 *
 * Rethrows the error after recording — it never changes control flow.
 */
export async function runJob<T>(
    name: string,
    fn: () => T | Promise<T>,
    source: 'queue' | 'cron' | 'scheduler' | 'script' = 'queue',
    meta?: Record<string, unknown>,
): Promise<T> {
    const b = Zanbug as unknown as {
        beginJob?: (n: string, m?: Record<string, unknown>, s?: string) => string;
        endJob?: (h?: string | number, code?: number, err?: string | null) => void;
    };
    if (typeof b.beginJob !== 'function' || typeof b.endJob !== 'function') {
        return fn(); // older core: run the work, skip attribution
    }
    let handle = '';
    try {
        handle = b.beginJob(name, meta, source) || '';
    } catch {
        /* never block the job */
    }
    const parent = currentScope() || {};
    return runWithRequestScope({ ...parent, job: handle }, async () => {
        try {
            const out = await fn();
            try { b.endJob!(handle, 0); } catch { /* ignore */ }
            return out;
        } catch (e) {
            try {
                const msg = e instanceof Error ? e.name + ': ' + e.message : String(e);
                b.endJob!(handle, 1, msg.slice(0, 500));
            } catch { /* ignore */ }
            throw e;
        }
    });
}

/**
 * Prisma middleware.
 *
 *   prisma.$use(zanbugPrisma());
 */
export function zanbugPrisma() {
    return async (params: any, next: (p: any) => Promise<unknown>) => {
        const started = Date.now();
        try {
            return await next(params);
        } finally {
            recordQuery({
                sql: `${params?.model ?? 'raw'}.${params?.action ?? 'query'}`,
                durationMs: Date.now() - started,
                connection: 'prisma',
            });
        }
    };
}

/**
 * TypeORM logger. Pass as `logger` in DataSource options.
 *
 * TypeORM already measures duration for us and calls logQuerySlow itself, but
 * only above its own maxQueryExecutionTime — so we hook logQuery and time it
 * ourselves to keep one threshold (ours) in charge.
 */
export function zanbugTypeOrmLogger(connection = 'typeorm') {
    return {
        logQuery() {
            /* timing comes from logQuerySlow */
        },
        logQuerySlow(time: number, query: string, parameters?: unknown[]) {
            recordQuery({ sql: query, durationMs: time, bindings: parameters, connection });
        },
        logQueryError(_e: unknown, query: string, parameters?: unknown[]) {
            Zanbug.addBreadcrumb({
                type: 'error',
                level: 'error',
                message: `Query failed: ${String(query).slice(0, 200)}`,
                data: { bindings: Array.isArray(parameters) ? parameters.slice(0, 10) : undefined },
            });
        },
        logSchemaBuild() {},
        logMigration() {},
        log() {},
    };
}

/**
 * Knex hook pair.
 *
 *   zanbugKnex(knex);
 */
export function zanbugKnex(knex: any, connection = 'knex'): void {
    try {
        const started = new Map<string, number>();
        knex.on('query', (q: any) => {
            if (q && q.__knexQueryUid) started.set(q.__knexQueryUid, Date.now());
        });
        knex.on('query-response', (_r: unknown, q: any) => {
            const uid = q && q.__knexQueryUid;
            if (!uid) return;
            const t0 = started.get(uid);
            started.delete(uid);
            if (t0 == null) return;
            recordQuery({
                sql: q.sql,
                durationMs: Date.now() - t0,
                bindings: q.bindings,
                connection,
            });
        });
        knex.on('query-error', (_e: unknown, q: any) => {
            if (q && q.__knexQueryUid) started.delete(q.__knexQueryUid);
        });
    } catch {
        /* ignore */
    }
}

/**
 * Is this a single read-only statement we may safely EXPLAIN?
 *
 * EXPLAIN without ANALYZE only plans — it does not execute — but a statement
 * that is not a plain SELECT is refused anyway: this runs against the
 * customer's production database, so the bar is "obviously harmless", not
 * "probably fine". Same posture as the PHP SDK.
 */
function isPlainSelect(sql: string): boolean {
    const s = String(sql).trim();
    if (!/^(select|with)\b/i.test(s)) return false;
    // One statement only. A trailing semicolon is fine; a second statement is not.
    if (/;\s*\S/.test(s)) return false;
    if (/\b(insert|update|delete|drop|alter|create|truncate|grant|copy)\b/i.test(s)) return false;
    return s.length <= 8000;
}

/** Guard so the EXPLAIN we issue is never itself timed and EXPLAINed. */
let explaining = false;

/**
 * Wrap a `pg` Pool/Client so every query is timed, and slow SELECTs are
 * EXPLAINed so the panel can show 🔴 "no index · full scan" / 🟢 "index used".
 *
 * Returns the same object, patched in place.
 */
export function zanbugPg<T extends { query: (...a: any[]) => any }>(client: T, connection = 'pg'): T {
    try {
        const original = client.query.bind(client);
        (client as any).query = function (...args: any[]) {
            const started = Date.now();
            const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
            const values = Array.isArray(args[1])
                ? args[1]
                : Array.isArray(args[0]?.values)
                  ? args[0].values
                  : undefined;
            const result = original(...args);

            // pg returns a promise unless a callback was passed.
            if (result && typeof result.then === 'function') {
                return result.finally(() => {
                    const durationMs = Date.now() - started;
                    const text = String(sql ?? '');

                    const worthExplaining =
                        captureQueries &&
                        explainQueries &&
                        !explaining &&
                        durationMs >= slowQueryMs &&
                        isPlainSelect(text);

                    if (!worthExplaining) {
                        recordQuery({ sql: text, durationMs, connection, bindings: values });
                        return;
                    }

                    explaining = true;
                    Promise.resolve(original('EXPLAIN (FORMAT JSON) ' + text, values))
                        .then((r: any) =>
                            recordQuery({
                                sql: text,
                                durationMs,
                                connection,
                                bindings: values,
                                explain: { driver: 'pgsql', raw: r?.rows ?? r },
                            }),
                        )
                        // A failed EXPLAIN must not lose the query itself — the
                        // slow query is the finding; the plan is a bonus.
                        .catch(() => recordQuery({ sql: text, durationMs, connection, bindings: values }))
                        .then(() => {
                            explaining = false;
                        });
                });
            }
            return result;
        };
    } catch {
        /* ignore */
    }
    return client;
}

/**
 * MongoDB: time every command via the driver's own monitoring events.
 *
 *   const client = new MongoClient(uri, { monitorCommands: true });
 *   zanbugMongo(client);
 *
 * `monitorCommands: true` is required — without it the driver emits nothing and
 * this is a silent no-op, so it is checked and reported in debug mode.
 *
 * Mongo has no SQL, so `sql` carries `db.collection.command` plus the filter as
 * JSON. That is what the panel groups on and what the AI reads; the shape is
 * different from a SELECT but the question ("which call is slow and why") is
 * the same.
 */
export function zanbugMongo(mongoClient: any, connection = 'mongodb'): any {
    try {
        if (!mongoClient || typeof mongoClient.on !== 'function') return mongoClient;

        // requestId → command, kept only between started and succeeded/failed.
        const inflight = new Map<number, { name: string; ns: string; brief: string }>();

        mongoClient.on('commandStarted', (e: any) => {
            try {
                // Never report the driver's own bookkeeping as a slow query.
                if (e?.commandName === 'ismaster' || e?.commandName === 'hello' || e?.commandName === 'ping') return;

                const cmd = e?.command || {};
                const name = String(e?.commandName || 'command');
                const coll = typeof cmd[name] === 'string' ? cmd[name] : '';
                const ns = `${e?.databaseName || 'db'}${coll ? '.' + coll : ''}`;

                // The filter/pipeline, truncated — enough to identify the query,
                // not a copy of the customer's data.
                let brief = '';
                const shape = cmd.filter ?? cmd.query ?? cmd.pipeline ?? cmd.documents;
                if (shape !== undefined) {
                    try {
                        brief = JSON.stringify(shape).slice(0, 2000);
                    } catch {
                        brief = '';
                    }
                }
                inflight.set(e.requestId, { name, ns, brief });
                // Bound the map: a dropped connection can leave entries behind.
                if (inflight.size > 500) inflight.clear();
            } catch {
                /* ignore */
            }
        });

        const finish = (e: any) => {
            try {
                const started = inflight.get(e?.requestId);
                if (!started) return;
                inflight.delete(e.requestId);

                // durationMS is what the driver measured; nanoseconds in some
                // versions, milliseconds in others — `duration` is the ms field.
                const ms = Number(e?.duration ?? e?.durationMS ?? 0);
                recordQuery({
                    sql: `${started.ns}.${started.name}(${started.brief})`,
                    durationMs: ms,
                    connection,
                });
            } catch {
                /* ignore */
            }
        };

        mongoClient.on('commandSucceeded', finish);
        mongoClient.on('commandFailed', finish);
    } catch {
        /* ignore */
    }
    return mongoClient;
}

/** Manual capture, re-exported for symmetry with the PHP facade. */
export { capture };
export { checkForUpdate, updateSdk } from './update';
export type { UpdateCheck, UpdateResult, UpdateOptions } from './update';
