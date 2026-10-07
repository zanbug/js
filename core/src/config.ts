import type {
    ZanbugOptions,
    ConsoleOptions,
    NetworkOptions,
    ResolvedOptions,
    SnapshotOptions,
    VitalsOptions,
} from './types';
import { env, isBrowser } from './env';

/**
 * Option resolution.
 *
 * `true` / `false` / an object are all valid for each feature block, so the app
 * can write `console: true` or `console: { levels: [...] }`. Everything is
 * normalised here once, and the rest of the SDK only ever sees the full shape.
 */

function section<T extends object>(
    value: boolean | T | undefined,
    defaults: Required<T>,
    defaultOn: boolean,
): Required<T> | false {
    if (value === false) return false;
    if (value === true || value === undefined) return defaultOn || value === true ? defaults : false;
    return { ...defaults, ...(value as object) } as Required<T>;
}

const CONSOLE_DEFAULTS: Required<ConsoleOptions> = {
    levels: ['log', 'info', 'warn', 'error', 'debug'],
    /**
     * Whether console.error becomes an event of its own, or stays a breadcrumb.
     *
     * Browser: yes. Most real front-end failures never reach window.onerror —
     * the app catches the error, logs it, and renders "something went wrong".
     * console.error is the only signal those leave behind.
     *
     * Node: no. Server frameworks log every error they handle, so capturing the
     * log too reports the same failure twice AND defeats filtering: NestJS logs
     * a deliberate 404 that the exception filter correctly skipped, and the
     * console path turned it back into an event. Observed exactly that. The
     * framework adapter already reports real errors with route context, so here
     * the console is breadcrumbs only.
     */
    captureAsEvent: isBrowser ? ['error'] : [],
};

const NETWORK_DEFAULTS: Required<NetworkOptions> = {
    enabled: true,
    captureFailures: true,
    ignoreUrls: [],
    captureBody: true,
    maxBodyChars: 4000,
};

const SNAPSHOT_DEFAULTS: Required<SnapshotOptions> = {
    enabled: true,
    // Never flipped to false by a preset. Turning this off ships whatever the
    // end user typed — passwords included — to the Zanbug server, so it has to
    // be an explicit, deliberate line in the app's own config.
    maskInputs: true,
    maskSelectors: [],
    maxBytes: 500_000,
};

const VITALS_DEFAULTS: Required<VitalsOptions> = {
    enabled: true,
    // Vitals describe the whole audience, not one error, so a sample is enough
    // and keeps ingest volume proportional to traffic.
    sampleRate: 0.2,
    longTaskMs: 100,
    slowResourceMs: 1000,
};

export function resolveOptions(input: ZanbugOptions = {}): ResolvedOptions {
    const apiKey = input.apiKey || env('ZANBUG_API_KEY') || env('NEXT_PUBLIC_ZANBUG_API_KEY') || '';
    const host =
        input.host ||
        env('ZANBUG_HOST') ||
        env('NEXT_PUBLIC_ZANBUG_HOST') ||
        'https://zanbug.com';

    return {
        ...input,
        apiKey,
        host: host.replace(/\/+$/, ''),
        release: input.release || env('ZANBUG_RELEASE'),
        environment: input.environment || env('ZANBUG_ENV') || env('NODE_ENV') || 'production',
        // No key means no-op, exactly like the PHP SDK: an app that ships
        // without configuration must not error, it must simply do nothing.
        enabled: input.enabled !== false && apiKey !== '',
        debug: input.debug === true,
        maxBreadcrumbs: clamp(input.maxBreadcrumbs ?? 50, 1, 200),
        sampleRate: clamp(input.sampleRate ?? 1, 0, 1),

        console: section(input.console, CONSOLE_DEFAULTS, true),
        network: section(input.network, NETWORK_DEFAULTS, true),
        snapshot: section(input.snapshot, SNAPSHOT_DEFAULTS, true),
        vitals: section(input.vitals, VITALS_DEFAULTS, true),

        globalHandlers: input.globalHandlers !== false,
        domBreadcrumbs: input.domBreadcrumbs !== false,
        installPing: input.installPing !== false,
        captureRuns: input.captureRuns !== false && !/^(0|false|no|off)$/i.test((env('ZANBUG_CAPTURE_RUNS') || '').trim()),

        redactKeys: input.redactKeys || [],
        ignoreErrors: input.ignoreErrors || [],
    };
}

function clamp(n: number, min: number, max: number): number {
    if (typeof n !== 'number' || isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
}
