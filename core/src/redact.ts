/**
 * PII / secret redaction.
 *
 * The SDK sends request metadata and breadcrumbs to a server the developer
 * controls but their end users do not. Anything that looks like a credential
 * is replaced before it leaves the process. This runs on data the SDK collects
 * itself AND on data the app hands us via setContext/addBreadcrumb.
 */

export const DEFAULT_REDACT_KEYS = [
    'password',
    'passwd',
    'pwd',
    'secret',
    'token',
    'access_token',
    'refresh_token',
    'api_key',
    'apikey',
    'authorization',
    'auth',
    'cookie',
    'set-cookie',
    'session',
    'csrf',
    'xsrf',
    'card',
    'card_number',
    'cardnumber',
    'cvv',
    'cvc',
    'pin',
    'ssn',
    'iban',
];

export const REDACTED = '[redacted]';

function isSensitiveKey(key: string, extra: string[]): boolean {
    const k = key.toLowerCase();
    for (const s of DEFAULT_REDACT_KEYS) {
        if (k.indexOf(s) !== -1) return true;
    }
    for (const s of extra) {
        if (s && k.indexOf(s.toLowerCase()) !== -1) return true;
    }
    return false;
}

/**
 * Deep-redact an object by key name. Depth-limited so a pathological structure
 * cannot lock up the main thread.
 */
export function redact<T>(value: T, extraKeys: string[] = [], depth = 0): T {
    if (depth > 6 || value == null) return value;

    try {
        if (Array.isArray(value)) {
            return value.slice(0, 100).map((v) => redact(v, extraKeys, depth + 1)) as unknown as T;
        }
        if (typeof value === 'object') {
            const src = value as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            let count = 0;
            for (const key in src) {
                if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
                if (++count > 100) break;
                out[key] = isSensitiveKey(key, extraKeys)
                    ? REDACTED
                    : redact(src[key], extraKeys, depth + 1);
            }
            return out as unknown as T;
        }
    } catch {
        /* fall through — return the value untouched rather than crash */
    }

    return value;
}

/**
 * Strip credentials out of a URL: query params named like secrets, plus any
 * user:pass@ prefix. Returns the input unchanged if it cannot be parsed.
 */
export function redactUrl(url: string, extraKeys: string[] = []): string {
    try {
        // Deliberately NOT using `new URL()`.
        //
        // React Native ships an incomplete URL polyfill: `searchParams` is a stub
        // there, so `searchParams.set()` changed nothing and `toString()` handed
        // back the original query. The try/catch then swallowed the difference and
        // the SDK uploaded `?token=supersecret` verbatim — a silent privacy leak,
        // seen in a real release APK. String surgery has no such dependency.
        //
        // It also keeps the marker readable: rebuilding through URL percent-encoded
        // it into `token=%5Bredacted%5D`, which a developer then has to decode.
        let out = url;

        // Strip credentials in `scheme://user:pass@host`. Only up to the first
        // '/' after the authority, so a colon inside a path or query is safe.
        out = out.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i, (_m, scheme) => scheme);

        const start = out.indexOf('?');
        if (start < 0) return out;

        // A fragment is not part of the query and must survive untouched.
        const hash = out.indexOf('#', start);
        const end = hash < 0 ? out.length : hash;

        const query = out.slice(start + 1, end);
        if (!query) return out;

        const cleaned = query
            .split('&')
            .map((pair) => {
                const eq = pair.indexOf('=');
                if (eq <= 0) return pair;

                const rawKey = pair.slice(0, eq);
                let key = rawKey;
                try {
                    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
                } catch {
                    /* a malformed escape: match on the raw key instead */
                }
                return isSensitiveKey(key, extraKeys) ? `${rawKey}=${REDACTED}` : pair;
            })
            .join('&');

        return `${out.slice(0, start)}?${cleaned}${out.slice(end)}`;
    } catch {
        // Returning the original would leak whatever we failed to clean, so give
        // back something that cannot: the URL without its query at all.
        try {
            return String(url).split('?')[0];
        } catch {
            return '';
        }
    }
}

/** Header maps arrive in several shapes (Headers, array pairs, plain object). */
export function redactHeaders(
    headers: unknown,
    extraKeys: string[] = [],
): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const put = (k: string, v: unknown) => {
            out[k] = isSensitiveKey(k, extraKeys) ? REDACTED : String(v);
        };

        const h = headers as any;
        if (!h) return undefined;

        if (typeof h.forEach === 'function' && typeof h.get === 'function') {
            h.forEach((v: unknown, k: string) => put(k, v));
            return out;
        }
        if (Array.isArray(h)) {
            for (const pair of h) {
                if (Array.isArray(pair) && pair.length >= 2) put(String(pair[0]), pair[1]);
            }
            return out;
        }
        if (typeof h === 'object') {
            for (const k in h) {
                if (Object.prototype.hasOwnProperty.call(h, k)) put(k, h[k]);
            }
            return out;
        }
    } catch {
        /* ignore */
    }
    return undefined;
}
