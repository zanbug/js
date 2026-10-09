/**
 * Public types for the Zanbug JavaScript SDK.
 *
 * Field names on the wire mirror the PHP SDK exactly, because both talk to the
 * same ingest endpoints and the same server-side fingerprinting. Renaming a
 * field here silently changes how errors group — don't.
 */

export type Level = 'error' | 'warning' | 'info' | 'debug' | 'fatal';

export type BreadcrumbType =
    | 'console'
    | 'navigation'
    | 'click'
    | 'http'
    | 'error'
    | 'manual';

export interface Breadcrumb {
    type: BreadcrumbType;
    /** Short human label, e.g. "GET /api/orders → 500". */
    message: string;
    level?: Level;
    /** ISO-8601. */
    timestamp: string;
    data?: Record<string, unknown>;
}

export interface StackFrame {
    file?: string;
    line?: number;
    column?: number;
    function?: string;
    /** false for node_modules / framework frames — the panel collapses those. */
    in_app?: boolean;
}

export interface UserInfo {
    id?: string | number;
    email?: string;
    name?: string;
    [key: string]: unknown;
}

/** What the browser measured about page load and responsiveness. */
export interface VitalMetric {
    /** LCP | FCP | CLS | INP | TTFB | LONG_TASK | RESOURCE */
    name: string;
    value: number;
    /** Google's good/needs-improvement/poor bucket, computed SDK-side. */
    rating?: 'good' | 'needs-improvement' | 'poor';
    url?: string;
    /** Element selector or resource URL the metric is attributed to. */
    target?: string;
    navigation_type?: string;
    occurred_at?: string;
    data?: Record<string, unknown>;
}

/** A serialized DOM snapshot taken at error time (never a pixel image). */
export interface Snapshot {
    kind: 'dom';
    html: string;
    /** Inlined same-origin stylesheet text, so the replay renders standalone. */
    css?: string;
    viewport?: { width: number; height: number; scrollX: number; scrollY: number };
    url?: string;
    taken_at?: string;
}

/**
 * A real pixel screenshot, sent by the MOBILE SDKs.
 *
 * A phone has no DOM, so the browser trick of serializing the page and
 * re-rendering it in an iframe is unavailable — the only faithful record of
 * what the user saw is an image. That shifts responsibility for privacy onto
 * the SDK: once the pixels exist, nothing downstream can tell a password field
 * from any other grey rectangle, so masking has to happen BEFORE the capture.
 */
/**
 * Returns a screenshot of the current screen, or null. Installed by mobile
 * adapters via `setScreenshotProvider()`; called once per captured error,
 * after the event is already queued. Must never throw (guarded anyway).
 */
export type ScreenshotProvider = () => Promise<MobileScreenshot | null | undefined> | MobileScreenshot | null | undefined;

export interface MobileScreenshot {
    kind: 'screenshot';
    /** Base64 PNG or JPEG. A `data:` URL prefix is accepted and stripped. */
    data: string;
    /** Route/screen name, so the panel can label it. */
    screen?: string;
    width?: number;
    height?: number;
    /** Whether the SDK masked sensitive views before capturing. */
    masked?: boolean;
    taken_at?: string;
}

export interface ZanbugEvent {
    exception_class?: string;
    message?: string;
    level?: Level;
    type?: string;
    file?: string;
    line?: number;
    handled?: boolean;
    stacktrace?: StackFrame[];
    release?: string;
    environment?: string;
    request?: Record<string, unknown>;
    user?: UserInfo | null;
    session?: Record<string, unknown>;
    device?: Record<string, unknown>;
    context?: Record<string, unknown>;
    breadcrumbs?: Breadcrumb[];
    snapshot?: Snapshot | null;
    /** Mobile only — the browser SDKs send `snapshot` instead. */
    screenshot?: MobileScreenshot | null;
    /** Server groups by this when present; otherwise it derives one. */
    fingerprint?: string;
}

/**
 * Where the offline queue is kept between app launches.
 *
 * Only mobile needs this. A browser tab can flush on `visibilitychange` and a
 * server process can await flush() before exiting, but a phone loses network
 * in a lift and a fatal JS error can take the app down before a single request
 * completes — so the events have to survive the process, not just the session.
 *
 * Deliberately tiny and async: React Native's AsyncStorage, MMKV and
 * expo-secure-store all satisfy it without an adapter.
 */
export interface EventStore {
    load: () => Promise<string | null>;
    save: (raw: string) => Promise<void>;
    clear: () => Promise<void>;
}

/**
 * Data belonging to ONE in-flight request, supplied by a server adapter.
 *
 * The browser has one user and one page per client, so `setUser`/`setContext`
 * on the client are correct there. A Node server is the opposite: one client
 * object serves every concurrent request, so writing the signed-in user onto it
 * means request A's error can be reported carrying request B's identity. That
 * is both wrong and a privacy leak.
 *
 * The adapter therefore keeps this per request (AsyncLocalStorage) and hands it
 * over through `setScopeProvider`. Precedence at capture time:
 *
 *   explicit argument  >  request scope  >  client-wide value
 */
export interface ScopeData {
    request?: Record<string, unknown>;
    /** Node: run-attribution job handle (from beginJob) active in this async scope. */
    job?: string;
    user?: UserInfo | null;
    context?: Record<string, unknown>;
}

export interface ConsoleOptions {
    /** Which console methods become breadcrumbs. */
    levels?: Array<'log' | 'info' | 'warn' | 'error' | 'debug'>;
    /**
     * Which console methods ALSO report a standalone error event.
     * Defaults to ['error'] — console.error is how most apps surface a
     * swallowed failure that never reaches window.onerror.
     */
    captureAsEvent?: Array<'warn' | 'error'>;
}

export interface NetworkOptions {
    /** Record fetch/XHR calls as breadcrumbs. */
    enabled?: boolean;
    /** Report failed requests (>=500, or network error) as their own event. */
    captureFailures?: boolean;
    /** Substrings; matching URLs are never recorded (in addition to our own). */
    ignoreUrls?: Array<string | RegExp>;
    /**
     * Capture the RESPONSE body of failed requests (status >= 400) so the actual
     * error payload — the API's message, the shape the UI didn't expect — is visible.
     * JSON is parsed and redacted key-by-key; other content types are truncated text.
     * Successful responses are never captured (privacy + size). Default: true.
     */
    captureBody?: boolean;
    /** Max characters of a captured body kept (truncated with an … marker). Default 4000. */
    maxBodyChars?: number;
}

export interface SnapshotOptions {
    enabled?: boolean;
    /**
     * Replace the value of every input/textarea/select before serializing.
     * NON-NEGOTIABLE DEFAULT: true. Turning it off ships whatever the user had
     * typed — including passwords and card numbers — to the Zanbug server.
     */
    maskInputs?: boolean;
    /** Extra CSS selectors whose text content is replaced with •. */
    maskSelectors?: string[];
    /** Skip the snapshot entirely once the HTML exceeds this many bytes. */
    maxBytes?: number;
}

export interface VitalsOptions {
    enabled?: boolean;
    /** 0..1 — fraction of sessions that report vitals. 1 = every session. */
    sampleRate?: number;
    /** Report tasks blocking the main thread longer than this (ms). */
    longTaskMs?: number;
    /** Report individual resources slower than this (ms). */
    slowResourceMs?: number;
}

export interface ZanbugOptions {
    /** Project API key. Without it the SDK is a silent no-op. */
    apiKey?: string;
    /** Zanbug host, e.g. https://zanbug.com */
    host?: string;
    /** Your app version — shown on the event and used for release grouping. */
    release?: string;
    environment?: string;
    /** Framework name reported on the install ping (adapters set this). */
    framework?: string;
    frameworkVersion?: string;
    /** Turn the whole SDK off without removing the code (e.g. in dev). */
    enabled?: boolean;
    debug?: boolean;

    /** Max breadcrumbs kept in the ring buffer. */
    maxBreadcrumbs?: number;
    /** 0..1 — fraction of errors actually sent. */
    sampleRate?: number;

    console?: boolean | ConsoleOptions;
    network?: boolean | NetworkOptions;
    snapshot?: boolean | SnapshotOptions;
    vitals?: boolean | VitalsOptions;
    /** Capture window.onerror / unhandledrejection (browser) and the Node equivalents. */
    globalHandlers?: boolean;
    /** Record clicks and route changes as breadcrumbs. */
    domBreadcrumbs?: boolean;
    /** Send the one-time install ping so the panel shows "SDK connected". */
    installPing?: boolean;
    /**
     * Node only: record one run per process (cron/CLI/queue job) with
     * duration, CPU, memory and DB time, so the panel can say WHICH command
     * loaded the server. Default true; env ZANBUG_CAPTURE_RUNS=false disables.
     */
    captureRuns?: boolean;
    /**
     * Adapters only: `{ '@zanbug/react': '1.4.1', … }` — the adapter packages
     * wrapping this core, reported on the install ping next to `@zanbug/js`
     * so the panel can show a mixed install (new adapter, old core).
     */
    sdkPackages?: Record<string, string>;
    /**
     * Whether this install updates itself (Node: autoUpdate /
     * ZANBUG_AUTO_UPDATE). Reported on the install ping only — the core never
     * updates anything by itself.
     */
    autoUpdate?: boolean;

    /** Extra request-header/body keys to redact, on top of the built-ins. */
    redactKeys?: string[];
    /** Drop an event (return null) or edit it before it is sent. */
    beforeSend?: (event: ZanbugEvent) => ZanbugEvent | null;
    /** Drop or edit a breadcrumb before it enters the buffer. */
    beforeBreadcrumb?: (crumb: Breadcrumb) => Breadcrumb | null;

    /** Errors whose message matches any of these are never sent. */
    ignoreErrors?: Array<string | RegExp>;
}

/** Fully-resolved options — every optional field has a value. */
export interface ResolvedOptions extends ZanbugOptions {
    apiKey: string;
    host: string;
    enabled: boolean;
    debug: boolean;
    maxBreadcrumbs: number;
    sampleRate: number;
    console: Required<ConsoleOptions> | false;
    network: Required<NetworkOptions> | false;
    snapshot: Required<SnapshotOptions> | false;
    vitals: Required<VitalsOptions> | false;
    globalHandlers: boolean;
    domBreadcrumbs: boolean;
    installPing: boolean;
    captureRuns: boolean;
    redactKeys: string[];
    ignoreErrors: Array<string | RegExp>;
}
