/** Small helpers shared across the SDK. All of them are failure-tolerant. */

/**
 * Run a function and swallow anything it throws.
 *
 * The SDK must never take the host application down — that rule is written in
 * blood after a PHP adapter crashed a customer's production site. Every entry
 * point into SDK code goes through this.
 */
export function safe<T>(fn: () => T, fallback?: T): T | undefined {
    try {
        return fn();
    } catch {
        return fallback;
    }
}

export function nowIso(): string {
    try {
        return new Date().toISOString();
    } catch {
        return '';
    }
}

export function truncate(value: unknown, max: number): string {
    const s = typeof value === 'string' ? value : stringify(value);
    return s.length > max ? s.slice(0, max) + '…' : s;
}

/** JSON.stringify that survives circular references and exotic values. */
export function stringify(value: unknown, max = 2000): string {
    try {
        const seen = new WeakSet<object>();
        const out = JSON.stringify(value, (_k, v) => {
            if (typeof v === 'bigint') return v.toString();
            if (typeof v === 'function') return '[Function]';
            if (v instanceof Error) return { name: v.name, message: v.message };
            if (typeof v === 'object' && v !== null) {
                if (seen.has(v)) return '[Circular]';
                seen.add(v);
            }
            return v;
        });
        if (out == null) return String(value);
        return out.length > max ? out.slice(0, max) + '…' : out;
    } catch {
        try {
            return String(value);
        } catch {
            return '[unserializable]';
        }
    }
}

export function matchesAny(value: string, patterns: Array<string | RegExp>): boolean {
    for (const p of patterns) {
        try {
            if (typeof p === 'string') {
                if (value.indexOf(p) !== -1) return true;
            } else if (p.test(value)) {
                return true;
            }
        } catch {
            /* a bad pattern must not break matching */
        }
    }
    return false;
}

/** Deterministic-enough id for correlating a session's events. */
export function randomId(): string {
    try {
        const c: any = (globalThis as any).crypto;
        if (c && typeof c.randomUUID === 'function') return c.randomUUID();
        if (c && typeof c.getRandomValues === 'function') {
            const b = new Uint8Array(16);
            c.getRandomValues(b);
            return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        }
    } catch {
        /* ignore */
    }
    // Math.random is fine here: this id only correlates telemetry, it is not
    // a security token.
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** 0..1 sample decision. rate >= 1 always passes, <= 0 never does. */
export function sampled(rate: number): boolean {
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return Math.random() < rate;
}

/** A CSS-ish selector for an element, used in click breadcrumbs and vitals. */
export function selectorFor(el: unknown): string | undefined {
    try {
        const node = el as any;
        if (!node || typeof node.tagName !== 'string') return undefined;
        let s = node.tagName.toLowerCase();
        if (node.id) return `${s}#${node.id}`;
        if (typeof node.className === 'string' && node.className.trim()) {
            const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
            if (cls) s += `.${cls}`;
        }
        return s;
    } catch {
        return undefined;
    }
}

/**
 * Resolve with `fallback` if `promise` has not settled within `ms`.
 *
 * The timer is unref'd where possible so telemetry never holds a Node process
 * open, and the losing promise is left to settle on its own.
 */
export function raceTimeout<T>(promise: Promise<T>, ms: number, fallback: T | null = null): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(fallback);
        }, ms);
        safe(() => {
            const t = timer as any;
            if (t && typeof t.unref === 'function') t.unref();
        });
        promise.then(
            (v) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(v);
            },
            () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(fallback);
            },
        );
    });
}
