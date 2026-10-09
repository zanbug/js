import { ZanbugClient } from './client';
import type {
    Breadcrumb,
    ZanbugOptions,
    EventStore,
    Level,
    MobileScreenshot,
    ScopeData,
    ScreenshotProvider,
    UserInfo,
    VitalMetric,
} from './types';
import { SDK_VERSION } from './env';
import { safe } from './utils';

export { ZanbugClient } from './client';
export { parseStack, normalizeError } from './stacktrace';
export { redact, redactUrl } from './redact';
export {
    SDK_VERSION,
    SDK_NAME,
    runtimeName,
    runtimeVersion,
    dependencyVersion,
    setDeviceExtra, env, legacyEnvKey } from './env';
export type {
    Breadcrumb,
    BreadcrumbType,
    ZanbugEvent,
    ZanbugOptions,
    ConsoleOptions,
    EventStore,
    Level,
    MobileScreenshot,
    NetworkOptions,
    ScopeData,
    ScreenshotProvider,
    Snapshot,
    SnapshotOptions,
    StackFrame,
    UserInfo,
    VitalMetric,
    VitalsOptions,
} from './types';

/**
 * Module-level singleton.
 *
 * Almost every app wants exactly one client, and the framework adapters need a
 * way to reach it from code the app never touches (an error boundary, an
 * exception filter). A singleton keeps `import { Zanbug } from '@zanbug/js'`
 * working everywhere; `new ZanbugClient()` is still there for the rare app
 * that reports to two projects.
 *
 * The singleton lives on globalThis, not in a module variable.
 *
 * A module variable assumes one copy of this package per process, and modern
 * bundlers break that assumption routinely. Next.js is the clearest case: it
 * bundles `instrumentation.ts` and every route handler separately, so the copy
 * that ran init() is NOT the copy a route's `capture()` call reaches. The
 * result was silent — the install ping arrived, the route threw, and nothing
 * was ever reported. The same happens with a pnpm monorepo that hoists two
 * versions, and it is the JS echo of the PHP mixed-install failure.
 *
 * A well-known key on globalThis is the one thing every copy agrees on.
 */
const SINGLETON_KEY = '__zanbug_client__';

type GlobalWithClient = typeof globalThis & { [SINGLETON_KEY]?: ZanbugClient | null };

function readClient(): ZanbugClient | null {
    return safe(() => (globalThis as GlobalWithClient)[SINGLETON_KEY] ?? null, null) ?? null;
}

function writeClient(value: ZanbugClient | null): void {
    safe(() => {
        (globalThis as GlobalWithClient)[SINGLETON_KEY] = value;
    });
}

export function init(options: ZanbugOptions = {}): ZanbugClient {
    // Re-initialising would leave the previous client's hooks installed, so the
    // old one is torn down first.
    const previous = readClient();
    if (previous) safe(() => previous.close());

    const created = new ZanbugClient(options);
    writeClient(created);
    created.start();
    return created;
}

/** The active client, or null when init() has not been called. */
export function getClient(): ZanbugClient | null {
    return readClient();
}

/**
 * Every helper below is a no-op before init(). That is deliberate: a component
 * that calls captureError must not crash because the app forgot to configure
 * monitoring, or because it is running in a test.
 */

export function capture(
    error: unknown,
    extra?: {
        handled?: boolean;
        level?: Level;
        type?: string;
        context?: Record<string, unknown>;
        /** HTTP details, for server adapters that have the request in hand. */
        request?: Record<string, unknown>;
        /** Mobile: a real PNG of the screen at error time. */
        screenshot?: MobileScreenshot | null;
    },
): void {
    readClient()?.capture(error, extra);
}

export function captureMessage(message: string, level: Level = 'info'): void {
    readClient()?.captureMessage(message, level);
}

export function setUser(user: UserInfo | null): void {
    readClient()?.setUser(user);
}

export function setContext(key: string, value: unknown): void {
    readClient()?.setContext(key, value);
}

export function addBreadcrumb(crumb: Omit<Breadcrumb, 'timestamp'> & { timestamp?: string }): void {
    readClient()?.addBreadcrumb(crumb);
}

export function recordMetric(metric: VitalMetric): void {
    readClient()?.recordMetric(metric);
}

// ---- run attribution (Node: which cron / CLI / queue job loaded the server) ----
export function setCommand(command: string): void { readClient()?.setCommand(command); }
export function setRunSource(source: string): void { readClient()?.setRunSource(source); }
export function setExitCode(code: number): void { readClient()?.setExitCode(code); }
export function beginJob(name: string, meta?: Record<string, unknown>, source = 'queue'): string {
    return readClient()?.beginJob(name, meta, source) || '';
}
export function endJob(handleOrExit?: string | number, exitCode?: number, error?: string | null): void {
    readClient()?.endJob(handleOrExit, exitCode, error);
}
export function noteQuery(durationMs: number, slow = false): void { readClient()?.noteQuery(durationMs, slow); }
export function setJobProvider(provider: (() => string | null | undefined) | null): void {
    readClient()?.setJobProvider(provider);
}

/**
 * Server adapters call this to supply per-request data. See `ScopeData`.
 *
 * Adapters MUST feature-detect before calling — a mixed install can pair a new
 * adapter with an older core, and on the PHP side exactly that combination
 * (`Client::setQueryRunner()` missing) took a customer's site down:
 *
 *   if (typeof (Zanbug as any).setScopeProvider === 'function') { ... }
 */
export function setScopeProvider(
    provider: (() => ScopeData | null | undefined) | null,
): void {
    readClient()?.setScopeProvider(provider);
}

/**
 * Mobile adapters call this to give the queue somewhere to survive a restart.
 * See `EventStore`.
 *
 * Same feature-detection rule as setScopeProvider above:
 *
 *   if (typeof (Zanbug as any).setEventStore === 'function') { ... }
 */
export function setEventStore(store: EventStore | null): void {
    readClient()?.setEventStore(store);
}

/**
 * Mobile adapters call this so EVERY captured error carries a screenshot,
 * including plain `Zanbug.capture(e)` calls and failed HTTP requests. See
 * `ZanbugClient.setScreenshotProvider`. Same feature-detection rule:
 *
 *   if (typeof (Zanbug as any).setScreenshotProvider === 'function') { ... }
 */
export function setScreenshotProvider(provider: ScreenshotProvider | null): void {
    readClient()?.setScreenshotProvider(provider);
}

export async function flush(): Promise<void> {
    await readClient()?.flush();
}

export function close(): void {
    readClient()?.close();
    writeClient(null);
}

/**
 * Namespace form, so `Zanbug.capture(e)` reads the same as the PHP facade.
 *
 * Deliberately NOT also a default export: mixing default and named exports
 * makes the CommonJS build require `.default`, which is exactly the kind of
 * "works in one install shape, breaks in another" trap that took a customer's
 * site down on the PHP side. One import style, everywhere:
 *
 *   import { Zanbug } from '@zanbug/js';
 *   const { Zanbug } = require('@zanbug/js');
 */
export const Zanbug = {
    VERSION: SDK_VERSION,
    init,
    getClient,
    capture,
    captureMessage,
    setUser,
    setContext,
    addBreadcrumb,
    recordMetric,
    setCommand,
    setRunSource,
    setExitCode,
    beginJob,
    endJob,
    noteQuery,
    setJobProvider,
    setScopeProvider,
    setEventStore,
    setScreenshotProvider,
    flush,
    close,
};
