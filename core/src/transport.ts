import { CircuitBreaker } from './breaker';
import { isBrowser, isNode, nodeModule } from './env';
import { safe } from './utils';

/**
 * UTF-8 byte length without depending on Buffer (absent in edge runtimes) or
 * TextEncoder (absent in very old Node).
 */
function byteLength(s: string): number {
    try {
        if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).length;
    } catch {
        /* fall through */
    }
    try {
        const B: any = (globalThis as any).Buffer;
        if (B && typeof B.byteLength === 'function') return B.byteLength(s);
    } catch {
        /* fall through */
    }
    // Manual UTF-8 count — correct for the surrogate pairs emojis produce.
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 0x80) n += 1;
        else if (c < 0x800) n += 2;
        else if (c >= 0xd800 && c <= 0xdbff) {
            n += 4;
            i++;
        } else n += 3;
    }
    return n;
}

/**
 * Delivery of payloads to the Zanbug ingest API.
 *
 * Mirrors the PHP SDK's transport philosophy: pick the best mechanism the
 * runtime offers, fall back automatically, and never block or throw. The
 * browser adds one concern PHP does not have — a page can be closing while a
 * request is in flight, which is what `sendBeacon` and `keepalive` exist for.
 */

export interface SendOptions {
    /** Use a delivery mechanism that survives page unload. */
    beacon?: boolean;
    timeoutMs?: number;
}

export class Transport {
    private breaker: CircuitBreaker;

    constructor(
        private host: string,
        private apiKey: string,
        private debug = false,
    ) {
        this.breaker = CircuitBreaker.for(host.replace(/\/+$/, ''));
    }

    /** Server errors and unreachable hosts count against the breaker; 4xx means the server is alive. */
    private record(status: number | null): void {
        if (status === null || status === 0 || status >= 500) this.breaker.failure();
        else this.breaker.success();
    }

    /** Fire-and-forget POST. Resolves to true when the server accepted it. */
    async send(path: string, body: unknown, opts: SendOptions = {}): Promise<boolean> {
        const url = this.host.replace(/\/+$/, '') + path;
        // Zanbug is down — skip instantly instead of waiting out a timeout.
        if (!this.breaker.allow()) {
            this.log('circuit open, skipping send');
            return false;
        }
        let json: string;
        try {
            json = JSON.stringify(body);
        } catch {
            return false;
        }

        // Page-unload path: sendBeacon is the only mechanism the browser
        // guarantees to flush after the document goes away.
        if (opts.beacon && isBrowser) {
            const sent = safe(() => {
                const nav: any = navigator;
                if (typeof nav.sendBeacon !== 'function') return false;
                // sendBeacon cannot set headers, so the key travels in the body
                // as `_key` (the server accepts it there for exactly this case).
                // Not a query parameter — that would land in the access log.
                //
                // The MIME type must be text/plain, not application/json.
                // application/json makes the request non-simple, which triggers
                // a CORS preflight; sendBeacon always sends credentials, and a
                // credentialed request cannot accept the wildcard
                // Access-Control-Allow-Origin the ingest API returns. The result
                // was silent: vitals from any customer domain were dropped by
                // the browser before they were ever sent. text/plain is a
                // CORS-safelisted type, so there is no preflight at all.
                const blob = new Blob([JSON.stringify({ ...(body as object), _key: this.apiKey })], {
                    type: 'text/plain;charset=UTF-8',
                });
                return nav.sendBeacon(url, blob);
            }, false);
            if (sent) return true;
            // fall through to fetch
        }

        if (typeof fetch === 'function') {
            return this.viaFetch(url, json, opts);
        }
        if (isNode) {
            return this.viaNodeHttp(url, json, opts);
        }

        this.log('no transport available');
        return false;
    }

    private async viaFetch(url: string, json: string, opts: SendOptions): Promise<boolean> {
        try {
            const controller =
                typeof AbortController === 'function' ? new AbortController() : undefined;
            const timer = controller
                ? setTimeout(() => safe(() => controller.abort()), opts.timeoutMs ?? 8000)
                : undefined;

            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Zanbug-Key': this.apiKey,
                },
                body: json,
                // keepalive lets the request outlive the page in browsers that
                // support it; it is ignored elsewhere.
                keepalive: opts.beacon === true,
                signal: controller ? controller.signal : undefined,
                // Never send the site's cookies to Zanbug.
                credentials: 'omit',
                mode: 'cors',
            } as RequestInit);

            if (timer) clearTimeout(timer);
            this.record(res.status);
            if (!res.ok) this.log('ingest rejected', res.status);
            return res.ok;
        } catch (e) {
            this.record(null);
            this.log('fetch failed', e);
            return false;
        }
    }

    /**
     * Node without global fetch — that is Node 17 and older, which a fair
     * number of customers still run in production. Uses the http/https module
     * loaded the bundler-opaque way, because `globalThis.require` does not
     * exist under ESM and this path would otherwise silently deliver nothing.
     */
    private async viaNodeHttp(url: string, json: string, opts: SendOptions): Promise<boolean> {
        const isHttps = url.indexOf('https://') === 0;
        const mod = await nodeModule(isHttps ? 'https' : 'http');
        if (!mod || typeof mod.request !== 'function') return false;

        return new Promise((resolve) => {
            try {
                const u = new URL(url);
                const req = mod.request(
                    {
                        method: 'POST',
                        hostname: u.hostname,
                        port: u.port || (isHttps ? 443 : 80),
                        path: u.pathname + u.search,
                        timeout: opts.timeoutMs ?? 8000,
                        headers: {
                            'Content-Type': 'application/json',
                            // Byte length, not string length — a multi-byte
                            // message would otherwise truncate the body.
                            'Content-Length': byteLength(json),
                            'X-Zanbug-Key': this.apiKey,
                        },
                    },
                    (res: any) => {
                        res.resume();
                        this.record(res.statusCode);
                        resolve(res.statusCode >= 200 && res.statusCode < 300);
                    },
                );
                req.on('error', () => {
                    this.record(null);
                    resolve(false);
                });
                req.on('timeout', () => {
                    safe(() => req.destroy());
                    this.record(null);
                    resolve(false);
                });
                req.write(json);
                req.end();
            } catch {
                resolve(false);
            }
        });
    }

    private log(...args: unknown[]): void {
        if (!this.debug) return;
        safe(() => console.warn('[zanbug]', ...args));
    }
}
