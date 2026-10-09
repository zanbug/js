import type { NetworkOptions } from '../types';
import { matchesAny, safe } from '../utils';
import { redactUrl, redact } from '../redact';
import { isReactNative } from '../env';

/**
 * fetch / XMLHttpRequest instrumentation.
 *
 * "The button did nothing" is almost always a failed request. Recording method,
 * URL, status and duration turns that into an obvious answer.
 *
 * For FAILED requests (status >= 400) the response body is also captured — that
 * is where the API's error message and the unexpected shape live, and it is what
 * a developer actually needs. JSON bodies are parsed and redacted key-by-key so
 * password/token-like fields never leave the page; other types are truncated
 * text. SUCCESSFUL responses are never captured (privacy + size).
 */

/** Truncate + redact a response body for storage. Returns a string or a redacted object. */
function shapeBody(raw: string, contentType: string, redactKeys: string[], max: number): unknown {
    if (!raw) return undefined;
    const clipped = raw.length > max ? raw.slice(0, max) + '…' : raw;
    if (contentType.indexOf('json') !== -1) {
        try {
            return redact(JSON.parse(clipped), redactKeys);
        } catch {
            return clipped; // not valid JSON after truncation — keep as text
        }
    }
    return clipped;
}

export interface NetworkHooks {
    breadcrumb: (message: string, data: Record<string, unknown>, failed: boolean) => void;
    capture: (message: string, data: Record<string, unknown>) => void;
}

export function installNetwork(
    opts: Required<NetworkOptions>,
    hooks: NetworkHooks,
    redactKeys: string[],
    ownHost: string,
): () => void {
    const undo: Array<() => void> = [];

    const ignored = (url: string): boolean => {
        // Never record our own ingest traffic: it would create a feedback loop
        // where reporting an error generates a breadcrumb that is then reported.
        if (url.indexOf('/api/ingest/') !== -1) return true;
        if (ownHost && url.indexOf(ownHost) === 0) return true;
        return matchesAny(url, opts.ignoreUrls);
    };

    const record = (
        method: string,
        rawUrl: string,
        status: number | undefined,
        startedAt: number,
        errored: boolean,
        responseBody?: unknown,
        requestBody?: unknown,
    ) => {
        try {
            const url = redactUrl(rawUrl, redactKeys);
            const duration = Math.round(now() - startedAt);
            const failed = errored || (typeof status === 'number' && status >= 400);

            const data: Record<string, unknown> = {
                method,
                url,
                status_code: status,
                duration_ms: duration,
            };
            // Only attach bodies for failures, and only when we actually captured them.
            if (requestBody !== undefined) data.request_body = requestBody;
            if (responseBody !== undefined) data.response_body = responseBody;

            const label = `${method} ${url} → ${errored ? 'failed' : status} (${duration}ms)`;
            hooks.breadcrumb(label, data, failed);

            // A 5xx or a transport failure is a real incident; a 404 usually is
            // not, so only the former becomes its own event.
            if (opts.captureFailures && (errored || (status !== undefined && status >= 500))) {
                hooks.capture(label, data);
            }
        } catch {
            /* ignore */
        }
    };

    // Should we read the body for this outcome? Only failures, only when enabled.
    const wantsBody = (status: number | undefined, errored: boolean): boolean =>
        opts.captureBody && (errored || (typeof status === 'number' && status >= 400));

    // React Native's `fetch` is a polyfill built on XMLHttpRequest, so patching
    // both records every call TWICE — two breadcrumbs and two events for one
    // request, with slightly different durations because one wraps the other.
    // Seen in a real release APK. XHR alone catches everything on a phone
    // (fetch, axios, anything else), so the fetch patch is skipped there.
    //
    // Conditioned on XHR actually existing, not on the runtime alone: a stripped
    // RN-like environment with fetch but no XMLHttpRequest would otherwise end
    // up with no network capture at all, which is a worse failure than a double
    // record.
    const xhrAvailable = typeof XMLHttpRequest === 'function';
    const fetchIsAliasedToXhr = isReactNative && xhrAvailable;

    if (opts.enabled && !fetchIsAliasedToXhr && typeof fetch === 'function') {
        const original = fetch;
        const patched = function (this: unknown, input: any, init?: any) {
            let url = '';
            let method = 'GET';
            const started = now();

            try {
                url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
                method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
            } catch {
                /* ignore */
            }

            if (!url || ignored(url)) return original.apply(this as any, [input, init] as any);

            // The request body it was called with — captured up front (a string body
            // is common; anything exotic like FormData/Blob is skipped). Shaped later,
            // only if the request turns out to have failed.
            const reqRaw = safe(() => (init && typeof init.body === 'string') ? (init.body as string) : undefined) as string | undefined;

            return original.apply(this as any, [input, init] as any).then(
                (res: Response) => {
                    const status = res ? res.status : undefined;
                    const req = (reqRaw && wantsBody(status, false)) ? shapeBody(reqRaw, 'application/json', redactKeys, opts.maxBodyChars) : undefined;
                    // Read the response body only for failures. Clone first so the app's own
                    // res.json()/res.text() still works — the stream can be read once.
                    if (res && wantsBody(status, false)) {
                        // `safe(...) || record(...)` was wrong here: the callback
                        // returns nothing, so the fallback ALWAYS ran and every
                        // failed request was recorded twice — two breadcrumbs and
                        // two events for one call, in every runtime. The flag
                        // says plainly whether the async path took over.
                        let readingBody = false;
                        safe(() => {
                            const ct = String(res.headers && res.headers.get ? res.headers.get('content-type') || '' : '');
                            const clone = res.clone();
                            readingBody = true;
                            clone.text().then(
                                (txt) => record(method, url, status, started, false, shapeBody(txt, ct, redactKeys, opts.maxBodyChars), req),
                                () => record(method, url, status, started, false, undefined, req),
                            );
                        });
                        if (!readingBody) {
                            record(method, url, status, started, false, undefined, req);
                        }
                    } else {
                        record(method, url, status, started, false);
                    }
                    return res;
                },
                (err: unknown) => {
                    const req = reqRaw ? shapeBody(reqRaw, 'application/json', redactKeys, opts.maxBodyChars) : undefined;
                    record(method, url, undefined, started, true, undefined, req);
                    throw err;
                },
            );
        };
        (globalThis as any).fetch = patched;
        undo.push(() => {
            (globalThis as any).fetch = original;
        });
    }

    if (opts.enabled && typeof XMLHttpRequest === 'function') {
        const proto = XMLHttpRequest.prototype as any;
        const origOpen = proto.open;
        const origSend = proto.send;

        proto.open = function (method: string, url: string, ...rest: unknown[]) {
            safe(() => {
                this.__zanbug = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
            });
            return origOpen.apply(this, [method, url, ...rest] as any);
        };

        proto.send = function (...args: unknown[]) {
            const meta = safe(() => this.__zanbug) as { method: string; url: string } | undefined;
            if (meta && meta.url && !ignored(meta.url)) {
                const started = now();
                const reqRaw = safe(() => (typeof args[0] === 'string') ? (args[0] as string) : undefined) as string | undefined;
                safe(() => {
                    this.addEventListener('loadend', () => {
                        // status 0 means the request never completed (CORS,
                        // offline, aborted) — that is a failure, not a 0 code.
                        const status = this.status || undefined;
                        const errored = !status;
                        let resBody: unknown;
                        let reqBody: unknown;
                        if (wantsBody(status, errored)) {
                            const ct = safe(() => String(this.getResponseHeader && this.getResponseHeader('content-type') || '')) as string || '';
                            const txt = safe(() => (this.responseType === '' || this.responseType === 'text') ? String(this.responseText || '') : '') as string || '';
                            if (txt) resBody = shapeBody(txt, ct, redactKeys, opts.maxBodyChars);
                            if (reqRaw) reqBody = shapeBody(reqRaw, 'application/json', redactKeys, opts.maxBodyChars);
                        }
                        record(meta.method, meta.url, status, started, errored, resBody, reqBody);
                    });
                });
            }
            return origSend.apply(this, args as any);
        };

        undo.push(() => {
            proto.open = origOpen;
            proto.send = origSend;
        });
    }

    return () => {
        for (const fn of undo) safe(fn);
    };
}

function now(): number {
    try {
        return typeof performance !== 'undefined' && typeof performance.now === 'function'
            ? performance.now()
            : Date.now();
    } catch {
        return Date.now();
    }
}
