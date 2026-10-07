import type {
    Breadcrumb,
    ZanbugEvent,
    ZanbugOptions,
    EventStore,
    Level,
    MobileScreenshot,
    ResolvedOptions,
    ScopeData,
    ScreenshotProvider,
    UserInfo,
    VitalMetric,
} from './types';
import { resolveOptions } from './config';
import { Transport } from './transport';
import { BreadcrumbBuffer } from './breadcrumbs';
import { normalizeError, parseStack } from './stacktrace';
import { takeSnapshot } from './snapshot';
import { VitalsCollector } from './vitals';
import { installConsole } from './integrations/console';
import { installNetwork } from './integrations/network';
import { installGlobalHandlers } from './integrations/globals';
import { installDomBreadcrumbs } from './integrations/dom';
import { sendInstallPing } from './ping';
import { deviceInfo, isBrowser, isNode } from './env';
import { RunTracker } from './runs';
import { redact, redactUrl } from './redact';
import { matchesAny, nowIso, raceTimeout, randomId, safe, sampled, truncate } from './utils';

/**
 * The SDK client.
 *
 * One rule governs every method here: nothing may throw into the host
 * application, and nothing may block it. Every public entry point is wrapped,
 * every optional browser API is feature-detected, and delivery is
 * fire-and-forget. A monitoring tool that can take down the app it monitors is
 * worse than no monitoring at all.
 */
export class ZanbugClient {
    private opts: ResolvedOptions;
    private transport: Transport;
    private crumbs: BreadcrumbBuffer;
    private vitals?: VitalsCollector;
    private runs?: RunTracker;
    private teardown: Array<() => void> = [];

    private user: UserInfo | null = null;
    private context: Record<string, unknown> = {};
    /** Set by a server adapter so concurrent requests do not share identity. */
    private scopeProvider: (() => ScopeData | null | undefined) | null = null;
    private screenshotProvider: ScreenshotProvider | null = null;
    /** Screenshots still being taken for events already in the queue. */
    private pendingShots = new Set<Promise<void>>();
    private sessionId = randomId();
    private startedAt = Date.now();

    /** Events waiting to be sent, coalesced so an error storm is one request. */
    private queue: ZanbugEvent[] = [];
    /** Offline queue backing store — mobile only. See setEventStore(). */
    private store: EventStore | null = null;
    private replayed = false;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    /** Metrics (slow queries, render timings) when there is no vitals collector. */
    private metricQueue: VitalMetric[] = [];
    private metricTimer: ReturnType<typeof setTimeout> | null = null;
    /** Guard against reporting an error that our own reporting caused. */
    private sending = false;

    /**
     * Error objects already reported, so a throw seen by two handlers is only
     * sent once. A WeakSet holds no strong reference, so entries disappear with
     * the errors themselves and this can never grow into a leak.
     */
    private seen = new WeakSet<object>();
    private started = false;

    constructor(options: ZanbugOptions = {}) {
        this.opts = resolveOptions(options);
        this.transport = new Transport(this.opts.host, this.opts.apiKey, this.opts.debug);
        this.crumbs = new BreadcrumbBuffer(this.opts.maxBreadcrumbs);
    }

    get options(): ResolvedOptions {
        return this.opts;
    }

    /** Wire up integrations. Safe to call twice — the second call is ignored. */
    start(): void {
        if (this.started) return;
        this.started = true;

        // No API key → the SDK is inert. Same contract as the PHP SDK: an app
        // shipped without configuration must behave as if we were not there.
        if (!this.opts.enabled) {
            this.debug('disabled (no API key)');
            return;
        }

        safe(() => this.installIntegrations());
        safe(() => sendInstallPing(this.opts, this.transport));
        // Per-process run attribution (which cron/CLI/queue job loaded the
        // server). Servers only: a browser tab is not a "run".
        if (isNode && this.opts.captureRuns) {
            safe(() => { this.runs = new RunTracker(this.transport, this.opts); });
        }
    }

    // ---- run attribution (Node) -------------------------------------
    /** Override the auto-detected command label (argv-based by default). */
    setCommand(command: string): void { safe(() => this.runs?.setCommand(command)); }
    /** cron | scheduler | queue | script — override the auto-detected source. */
    setRunSource(source: string): void { safe(() => this.runs?.setSource(source)); }
    setExitCode(code: number): void { safe(() => this.runs?.setExitCode(code)); }
    /** Start a per-job run inside a long-lived worker. Returns a handle for endJob(). */
    beginJob(name: string, meta?: Record<string, unknown>, source = 'queue'): string {
        return safe(() => this.runs?.beginJob(name, meta, source)) || '';
    }
    endJob(handleOrExit?: string | number, exitCode?: number, error?: string | null): void {
        safe(() => this.runs?.endJob(handleOrExit, exitCode, error));
    }
    /** Adapters report every query here (fast ones too) so a run's total DB time is real. */
    noteQuery(durationMs: number, slow = false): void { safe(() => this.runs?.noteQuery(durationMs, slow)); }
    /** Resolve the current job handle from request/job scope (AsyncLocalStorage). */
    setJobProvider(provider: (() => string | null | undefined) | null): void {
        safe(() => this.runs?.setJobProvider(provider));
    }

    private installIntegrations(): void {
        const o = this.opts;

        if (o.globalHandlers) {
            this.teardown.push(
                installGlobalHandlers({
                    capture: (err, extra) => this.capture(err, extra),
                    flush: () => this.flush(),
                }),
            );
        }

        if (o.console) {
            this.teardown.push(
                installConsole(o.console, {
                    breadcrumb: (level, message) =>
                        this.addBreadcrumb({ type: 'console', level, message }),
                    capture: (level, message, args) => {
                        // console.error(err) — prefer the real Error argument so
                        // the event carries a stack instead of a stringified one.
                        const real = args.find((a) => a instanceof Error);
                        this.capture(real ?? message, {
                            handled: true,
                            type: 'console',
                            level,
                        });
                    },
                }),
            );
        }

        if (o.network) {
            this.teardown.push(
                installNetwork(
                    o.network,
                    {
                        breadcrumb: (message, data, failed) =>
                            this.addBreadcrumb({
                                type: 'http',
                                level: failed ? 'error' : 'info',
                                message,
                                data,
                            }),
                        capture: (message, data) =>
                            this.capture(new Error(message), {
                                handled: true,
                                type: 'http',
                                context: data,
                                // Also top-level: the panel's Request tab reads
                                // the `request` column, not context.request, so
                                // without this the tab sat empty for every
                                // failed call the SDK reported.
                                request: httpRequestInfo(data),
                            }),
                    },
                    o.redactKeys,
                    o.host,
                ),
            );
        }

        if (o.domBreadcrumbs) {
            this.teardown.push(
                installDomBreadcrumbs({
                    click: (label, data) =>
                        this.addBreadcrumb({ type: 'click', message: `Clicked ${label}`, data }),
                    navigate: (from, to) =>
                        this.addBreadcrumb({
                            type: 'navigation',
                            message: `${redactUrl(from, o.redactKeys)} → ${redactUrl(to, o.redactKeys)}`,
                        }),
                }),
            );
        }

        if (o.vitals && isBrowser) {
            // Sample per session, not per metric: half a page's vitals would be
            // meaningless, and the decision has to be stable for the session.
            if (sampled(o.vitals.sampleRate)) {
                this.vitals = new VitalsCollector(o.vitals, (metrics) => this.sendVitals(metrics));
                this.vitals.start();
                this.teardown.push(() => this.vitals?.stop());
            } else {
                this.debug('vitals not sampled for this session');
            }
        }

        if (isBrowser) {
            this.teardown.push(this.installUnloadFlush());
        }
    }

    /**
     * Send whatever is queued before the page goes away.
     *
     * Events are batched with a short debounce so an error loop becomes one
     * request instead of hundreds. That debounce loses the last batch whenever
     * the user navigates immediately after the error — which is the common
     * case, not an edge case: click a link, something throws, the document is
     * torn down before the timer fires. Observed exactly that while testing:
     * an uncaught TypeError never arrived while the beacon-based vitals from the
     * same page did.
     *
     * `visibilitychange` is the reliable signal (mobile Safari often skips
     * `beforeunload`), and `pagehide` covers the bfcache case. Both drain with
     * `beacon: true`, the only delivery a closing document is guaranteed to
     * complete.
     */
    private installUnloadFlush(): () => void {
        const onHide = () => {
            // `hidden` also fires on tab switch, which is fine — flushing early
            // costs one request and never loses data.
            if (document.visibilityState === 'hidden') void this.drain(true);
        };
        const onPageHide = () => void this.drain(true);

        safe(() => document.addEventListener('visibilitychange', onHide, true));
        safe(() => window.addEventListener('pagehide', onPageHide, true));

        return () => {
            safe(() => document.removeEventListener('visibilitychange', onHide, true));
            safe(() => window.removeEventListener('pagehide', onPageHide, true));
        };
    }

    // --- public API ---------------------------------------------------------

    addBreadcrumb(crumb: Omit<Breadcrumb, 'timestamp'> & { timestamp?: string }): void {
        if (!this.opts.enabled) return;
        safe(() => {
            let c: Breadcrumb = {
                ...crumb,
                data: crumb.data ? redact(crumb.data, this.opts.redactKeys) : undefined,
                timestamp: crumb.timestamp || nowIso(),
            };
            if (this.opts.beforeBreadcrumb) {
                const out = this.opts.beforeBreadcrumb(c);
                if (!out) return;
                c = out;
            }
            this.crumbs.add(c);
        });
    }

    setUser(user: UserInfo | null): void {
        safe(() => {
            this.user = user ? (redact(user, this.opts.redactKeys) as UserInfo) : null;
        });
    }

    setContext(key: string, value: unknown): void {
        safe(() => {
            this.context[key] = redact(value, this.opts.redactKeys);
        });
    }

    /**
     * Let a server adapter supply per-request data (see `ScopeData`).
     *
     * Called by @zanbug/node with an AsyncLocalStorage lookup. The provider runs
     * on every capture, so it must be cheap and must never throw — the call is
     * wrapped here regardless.
     */
    setScopeProvider(provider: (() => ScopeData | null | undefined) | null): void {
        safe(() => {
            this.scopeProvider = provider;
        });
    }

    private scope(): ScopeData {
        if (!this.scopeProvider) return {};
        return safe(() => this.scopeProvider!() || {}, {}) || {};
    }

    /**
     * Supply a screenshot for EVERY captured error (mobile).
     *
     * Installed by @zanbug/react-native so that a plain `Zanbug.capture(e)`,
     * a failed HTTP request reported by the network integration and a fatal
     * all carry a picture of the screen — not just the errors the adapter's
     * own handlers saw. Without it a bug caught in a try/catch and handed to
     * capture() showed up in the panel with no screenshot, and the developer
     * could not tell which screen it happened on.
     *
     * Order is deliberate: the event is queued and written to disk FIRST and
     * the screenshot is attached afterwards, in place, only if the event is
     * still waiting to be sent. A slow or failing capture can never cost the
     * error it belongs to. Bounded to 2 s; `drain()` waits at most 2.5 s for
     * shots still in flight. `captureMessage()` events get no screenshot.
     */
    setScreenshotProvider(provider: ScreenshotProvider | null): void {
        safe(() => {
            this.screenshotProvider = provider;
        });
    }

    private attachScreenshotLater(event: ZanbugEvent): void {
        const provider = this.screenshotProvider;
        if (!provider) return;

        const task = (async () => {
            let shot: MobileScreenshot | null = null;
            try {
                shot = (await raceTimeout(Promise.resolve(provider()), 2000)) || null;
            } catch {
                shot = null;
            }
            // Already sent (or dropped by the cap)? Then there is nothing to
            // attach to; a screenshot without its error is useless.
            if (shot && this.queue.indexOf(event) !== -1) {
                event.screenshot = shot;
                void this.persistQueue(this.queue);
            }
        })();

        const tracked: Promise<void> = task.then(
            () => {
                this.pendingShots.delete(tracked);
            },
            () => {
                this.pendingShots.delete(tracked);
            },
        );
        this.pendingShots.add(tracked);
    }

    /** Wait (bounded) for screenshots still being taken for queued events. */
    private async awaitPendingShots(): Promise<void> {
        if (this.pendingShots.size === 0) return;
        try {
            await raceTimeout(Promise.all(Array.from(this.pendingShots)), 2500);
        } catch {
            /* a lost screenshot never delays or drops the error */
        }
    }

    /**
     * Attach an offline queue (mobile). See `EventStore`.
     *
     * Queued events are written to the store BEFORE the request goes out and
     * cleared only once it succeeds, so a crash or a dead network mid-send
     * leaves them on disk for the next launch rather than losing them. Anything
     * already on disk is replayed immediately.
     *
     * Called by @zanbug/react-native; a browser or server app never needs it.
     */
    setEventStore(store: EventStore | null): void {
        safe(() => {
            this.store = store;
            if (store) void this.replayStored();
        });
    }

    /** Re-enqueue whatever the previous run left behind, then send it. */
    private async replayStored(): Promise<void> {
        if (!this.store || this.replayed) return;
        this.replayed = true;

        try {
            const raw = await this.store.load();
            if (!raw) return;

            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed) || parsed.length === 0) {
                await this.store.clear();
                return;
            }

            // Front of the queue: these are older than anything captured in this
            // session, and the queue cap trims from the front.
            this.queue.unshift(...(parsed as ZanbugEvent[]));
            await this.drain(false);
        } catch {
            // A corrupt or unreadable store must never block startup. Drop it
            // rather than retrying a payload that will fail again every launch.
            safe(() => this.store?.clear());
        }
    }

    /** Mirror the in-memory queue to disk. Best effort, never throws. */
    private persistQueue(events: ZanbugEvent[]): Promise<void> {
        if (!this.store) return Promise.resolve();
        return (
            safe(
                () =>
                    events.length === 0
                        ? this.store!.clear()
                        : this.store!.save(JSON.stringify(events)),
                Promise.resolve(),
            ) ?? Promise.resolve()
        ).catch(() => undefined);
    }

    captureMessage(message: string, level: Level = 'info'): void {
        this.capture(new Error(message), { handled: true, level, type: 'message' });
    }

    /** Report an error. Never throws, never blocks. */
    capture(
        error: unknown,
        extra: {
            handled?: boolean;
            level?: Level;
            type?: string;
            context?: Record<string, unknown>;
            request?: Record<string, unknown>;
            /** Mobile: a real PNG of the screen at error time. */
            screenshot?: MobileScreenshot | null;
        } = {},
    ): void {
        if (!this.opts.enabled) return;
        // Reporting must not report itself.
        if (this.sending) return;

        // One throw, several observers.
        //
        // Frameworks route errors through their own handler AND log them to the
        // console, so a single React render crash arrives twice: once from the
        // console integration, once from the error boundary. Observed exactly
        // that — the event landed with occurrences=2 and the wrong type.
        //
        // Identity is the Error OBJECT, not its message: a genuine repeating
        // error (a render loop) constructs a new Error every time, so this
        // cannot swallow real recurrences the way a message-based check would.
        if (typeof error === 'object' && error !== null) {
            if (this.seen.has(error as object)) return;
            safe(() => this.seen.add(error as object));
        }

        safe(() => {
            const norm = normalizeError(error);
            // Read once: the provider crosses an AsyncLocalStorage lookup, and
            // every field below must come from the SAME request.
            const scope = this.scope();

            if (this.opts.ignoreErrors.length && matchesAny(norm.message, this.opts.ignoreErrors)) {
                return;
            }
            if (!sampled(this.opts.sampleRate)) return;

            const frames = parseStack(norm.stack);
            const top = frames.find((f) => f.in_app) || frames[0];

            let event: ZanbugEvent = {
                exception_class: norm.name,
                message: truncate(norm.message, 2000),
                level: extra.level || 'error',
                type: extra.type || 'error',
                handled: extra.handled ?? true,
                file: top?.file,
                line: top?.line,
                stacktrace: frames,
                release: this.opts.release,
                environment: this.opts.environment,
                // The request's own user wins over the client-wide one, which on
                // a server is either unset or left over from another request.
                user: scope.user !== undefined ? scope.user : this.user,
                breadcrumbs: this.crumbs.all(),
                device: deviceInfo(),
                session: {
                    id: this.sessionId,
                    started_at: new Date(this.startedAt).toISOString(),
                    duration_ms: Date.now() - this.startedAt,
                },
                request: extra.request || scope.request || this.requestInfo(),
                context: {
                    ...this.context,
                    ...(scope.context || {}),
                    ...(extra.context ? redact(extra.context, this.opts.redactKeys) : {}),
                },
                snapshot: this.opts.snapshot ? takeSnapshot(this.opts.snapshot) : null,
                // Mobile only. takeSnapshot() is a no-op without a DOM, so the
                // two are never both set.
                screenshot: extra.screenshot ?? null,
            };

            if (this.opts.beforeSend) {
                const out = this.opts.beforeSend(event);
                if (!out) return;
                event = out;
            }

            this.enqueue(event);

            // Screenshot AFTER the event is safely queued (see setScreenshotProvider).
            // An explicit screenshot from the caller always wins.
            if (event.screenshot == null && event.type !== 'message') {
                this.attachScreenshotLater(event);
            }
        });
    }

    /** Flush anything queued. Await it before a process exits. */
    async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.metricTimer) {
            clearTimeout(this.metricTimer);
            this.metricTimer = null;
        }
        await this.drain(false);
        // A CLI or worker that awaits flush() then exits must not lose the slow
        // queries it recorded a moment earlier.
        await this.drainMetrics();
        safe(() => this.vitals?.flushNow());
        if (this.runs) { try { await this.runs.flush(); } catch { /* never throw */ } }
    }

    /** Remove every hook the SDK installed. */
    close(): void {
        for (const fn of this.teardown) safe(fn);
        this.teardown = [];
        this.started = false;
        if (this.runs) { const r = this.runs; this.runs = undefined; void r.close().catch(() => undefined); }
    }

    /**
     * Adapters use this to report render timings and slow database queries.
     *
     * In the browser these ride along with the Web Vitals collector, which
     * batches them and flushes on page hide. On a server there IS no vitals
     * collector — it is browser-only, and it is also sampled — so metrics get
     * their own small queue here.
     *
     * That queue is not an optimisation. Without it `this.vitals?.push()` was
     * simply a no-op on Node, so every slow query a Node/Express/Nest/Next app
     * recorded was discarded before it reached the wire: the Performance tab
     * stayed empty forever and nothing anywhere reported a problem.
     */
    recordMetric(metric: VitalMetric): void {
        safe(() => {
            // Stamp the run/job attribution NOW, not at flush time: the batch
            // is sent seconds later, when the job that ran the query has
            // usually already finished and current() would fall back to the
            // process — every job's queries then looked like the worker's.
            if (metric.name === 'SLOW_QUERY' && this.runs) {
                const run = this.runs.current();
                if (run && Object.keys(run).length > 0) {
                    metric.data = { ...(metric.data || {}), __run: run };
                }
            }
            if (this.vitals) {
                this.vitals.push(metric);
                return;
            }

            this.metricQueue.push(metric);
            // A slow-query storm must not grow without bound.
            if (this.metricQueue.length > 100) {
                this.metricQueue.splice(0, this.metricQueue.length - 100);
            }
            if (this.metricTimer) return;

            // Longer than the event debounce: queries arrive in bursts per
            // request and there is no page-unload deadline to race on a server.
            this.metricTimer = setTimeout(() => {
                this.metricTimer = null;
                this.drainMetrics();
            }, 2000);

            const t = this.metricTimer as any;
            if (t && typeof t.unref === 'function') t.unref();
        });
    }

    private drainMetrics(): Promise<unknown> {
        if (this.metricQueue.length === 0) return Promise.resolve();
        const batch = this.metricQueue.splice(0, this.metricQueue.length);
        return safe(() => this.sendVitals(batch), Promise.resolve()) ?? Promise.resolve();
    }

    // --- internals ----------------------------------------------------------

    private requestInfo(): Record<string, unknown> | undefined {
        if (!isBrowser) return undefined;
        return safe(() => ({
            url: redactUrl(location.href, this.opts.redactKeys),
            referrer: document.referrer ? redactUrl(document.referrer, this.opts.redactKeys) : undefined,
            method: 'GET',
        }));
    }

    private enqueue(event: ZanbugEvent): void {
        this.queue.push(event);
        // Cap the queue: an error loop must not eat the page's memory.
        if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50);

        // Mobile: write through to disk immediately. A fatal JS error can kill
        // the app before the 300ms debounce below ever fires, and an event that
        // only ever existed in memory is gone with it.
        void this.persistQueue(this.queue);

        if (this.flushTimer) return;
        // A short window coalesces a burst (a render loop throwing on every
        // frame) into one request instead of hundreds.
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.drain(false);
        }, 300);

        safe(() => {
            const t = this.flushTimer as any;
            // Do not hold a Node process open just to flush telemetry.
            if (t && typeof t.unref === 'function') t.unref();
        });
    }

    private async drain(beacon: boolean): Promise<void> {
        if (this.queue.length === 0) return;
        // Give in-flight screenshots a bounded chance to land on their events
        // before the batch leaves. Once sent, an event cannot be amended.
        if (!beacon) await this.awaitPendingShots();
        if (this.queue.length === 0) return;
        const batch = this.queue.splice(0, this.queue.length);

        // The guard covers only the SYNCHRONOUS part of the send — serializing
        // the batch and handing it to fetch/sendBeacon. That is where our own
        // code could throw and be re-reported into a loop.
        //
        // It must NOT stay set across the network wait. It used to, and that
        // silently dropped real application errors: on a server handling two
        // concurrent requests, an error thrown while the previous batch was
        // still in flight hit `if (this.sending) return` and vanished — no
        // event, no warning. Reproduced exactly that with two overlapping
        // requests; the slower one's error never arrived.
        let inFlight: Promise<boolean>;
        this.sending = true;
        try {
            inFlight = this.transport.send('/api/ingest/events', { events: batch }, { beacon });
        } finally {
            this.sending = false;
        }
        const ok = await inFlight;

        // Offline queue (mobile). The batch stays on disk until the server has
        // actually taken it; a phone that lost signal mid-request keeps its
        // events for the next launch instead of dropping them.
        if (this.store) {
            if (ok) {
                await this.persistQueue(this.queue);
            } else {
                this.queue.unshift(...batch);
                if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50);
                await this.persistQueue(this.queue);
            }
        }
    }

    /**
     * Returns a promise so `flush()` can await delivery. In the browser nothing
     * awaits it — the page may be unloading — but a CLI or worker that flushes
     * and then exits would otherwise kill the request mid-flight.
     */
    private sendVitals(metrics: VitalMetric[]): Promise<unknown> {
        const pending: Array<Promise<unknown>> = [];
        safe(() => {
            // Slow database queries share the metric pipeline for batching, but
            // they are NOT web vitals: the server has had /api/ingest/queries
            // since the PHP SDKs, with its own grouping, EXPLAIN handling and
            // Performance tab. Route them there in that endpoint's shape so a
            // Node app's slow queries land next to a Laravel app's.
            const queries: Array<Record<string, unknown>> = [];
            const vitals: VitalMetric[] = [];

            for (const m of metrics) {
                if (m.name === 'SLOW_QUERY') {
                    const d = (m.data || {}) as Record<string, unknown>;
                    const run = (d.__run as Record<string, unknown> | undefined)
                        || (this.runs ? this.runs.current() : {});
                    queries.push({
                        // Which command / job this query ran under (Node only),
                        // captured when the query was recorded (see recordMetric).
                        ...run,
                        sql: d.sql,
                        duration_ms: m.value,
                        connection: d.connection,
                        bindings: d.bindings,
                        url: d.url,
                        method: d.method,
                        // The query plan, when the adapter could get one. The
                        // server turns it into the 🔴 full scan / 🟢 index badge.
                        explain: d.explain,
                        occurred_at: m.occurred_at,
                    });
                } else {
                    vitals.push(m);
                }
            }

            const url = safe(() => redactUrl(location.href, this.opts.redactKeys));

            if (queries.length) {
                pending.push(this.transport.send('/api/ingest/queries', { queries }, { beacon: true }));
            }

            if (vitals.length) {
                pending.push(
                    this.transport.send(
                    '/api/ingest/vitals',
                    {
                        vitals,
                        url,
                        release: this.opts.release,
                        environment: this.opts.environment,
                        session_id: this.sessionId,
                        device: deviceInfo(),
                    },
                        // The page is usually unloading when vitals flush —
                        // beacon is the only delivery that survives that.
                        { beacon: true },
                    ),
                );
            }
        });

        return Promise.all(pending).catch(() => undefined);
    }

    private debug(...args: unknown[]): void {
        if (!this.opts.debug) return;
        safe(() => console.info('[zanbug]', ...args));
    }
}

/**
 * Shape a failed HTTP call into the `request` column the panel reads.
 *
 * The path is cut out of the URL by hand rather than with `new URL()`: React
 * Native's URL polyfill is incomplete, and relying on it there is exactly what
 * made redaction silently fail once already.
 */
function httpRequestInfo(data: Record<string, unknown>): Record<string, unknown> {
    const url = typeof data.url === 'string' ? data.url : '';
    let path = url;
    try {
        // Drop scheme+host if present, then the fragment; keep the query, which
        // is already redacted by the time it gets here.
        const afterScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
        path = (afterScheme || url).split('#')[0] || '/';
    } catch {
        /* keep the whole URL */
    }

    return {
        method: typeof data.method === 'string' ? data.method : 'GET',
        url,
        path,
        status: data.status_code,
        duration_ms: data.duration_ms,
    };
}
