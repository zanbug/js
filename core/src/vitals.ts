import type { VitalMetric, VitalsOptions } from './types';
import { isBrowser } from './env';
import { nowIso, safe, selectorFor } from './utils';

/**
 * Web Vitals and render-performance collection.
 *
 * This is the browser's answer to the "why is my page slow, what do I do about
 * it" question — the same role slow-query capture plays on the server side.
 * Everything here rides on PerformanceObserver, which the browser computes
 * anyway, so the CPU cost is effectively zero. No external dependency: the
 * web-vitals package would add weight for logic that is a few hundred lines.
 *
 * Metrics are buffered and flushed once, when the page is hidden. A page load
 * has no single "done" moment — LCP and CLS keep changing until the user
 * leaves — so reporting early would report the wrong number.
 */

// Google's good / needs-improvement thresholds. Above the second value is poor.
const THRESHOLDS: Record<string, [number, number]> = {
    LCP: [2500, 4000],
    FCP: [1800, 3000],
    CLS: [0.1, 0.25],
    INP: [200, 500],
    TTFB: [800, 1800],
};

export function rate(name: string, value: number): VitalMetric['rating'] | undefined {
    const t = THRESHOLDS[name];
    if (!t) return undefined;
    if (value <= t[0]) return 'good';
    if (value <= t[1]) return 'needs-improvement';
    return 'poor';
}

type Flush = (metrics: VitalMetric[]) => void;

export class VitalsCollector {
    private metrics: VitalMetric[] = [];
    private observers: PerformanceObserver[] = [];
    private flushed = false;
    /** LCP/CLS/INP are "final value wins" — keyed so later values replace. */
    private latest: Record<string, VitalMetric> = {};

    constructor(
        private opts: Required<VitalsOptions>,
        private flush: Flush,
    ) {}

    start(): void {
        if (!isBrowser || !this.opts.enabled) return;
        if (typeof PerformanceObserver !== 'function') return;

        this.observeTtfb();
        this.observePaint();
        this.observeLcp();
        this.observeCls();
        this.observeInp();
        this.observeLongTasks();
        this.observeResources();
        this.installFlushTriggers();
    }

    stop(): void {
        for (const o of this.observers) safe(() => o.disconnect());
        this.observers = [];
    }

    /** Manually add a metric — adapters use this for component render times. */
    push(metric: VitalMetric): void {
        try {
            this.metrics.push({
                ...metric,
                rating: metric.rating ?? rate(metric.name, metric.value),
                url: metric.url ?? location.href,
                occurred_at: metric.occurred_at ?? nowIso(),
            });
        } catch {
            /* ignore */
        }
    }

    private set(name: string, value: number, extra: Partial<VitalMetric> = {}): void {
        this.latest[name] = {
            name,
            value: Math.round(value * 1000) / 1000,
            rating: rate(name, value),
            url: safe(() => location.href),
            occurred_at: nowIso(),
            ...extra,
        };
    }

    private observe(type: string, cb: (entries: PerformanceEntryList) => void, buffered = true): void {
        safe(() => {
            const obs = new PerformanceObserver((list) => safe(() => cb(list.getEntries())));
            // `buffered` replays entries that fired before the SDK loaded —
            // without it, a late-initialised SDK misses FCP and LCP entirely.
            obs.observe({ type, buffered } as PerformanceObserverInit);
            this.observers.push(obs);
        });
    }

    private observeTtfb(): void {
        safe(() => {
            const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
            if (nav && typeof nav.responseStart === 'number' && nav.responseStart > 0) {
                this.set('TTFB', nav.responseStart, { navigation_type: nav.type });
            }
        });
    }

    private observePaint(): void {
        this.observe('paint', (entries) => {
            for (const e of entries) {
                if (e.name === 'first-contentful-paint') this.set('FCP', e.startTime);
            }
        });
    }

    private observeLcp(): void {
        this.observe('largest-contentful-paint', (entries) => {
            // Only the LAST entry counts: the browser keeps upgrading its guess
            // at the largest element as more content paints.
            const last: any = entries[entries.length - 1];
            if (!last) return;
            this.set('LCP', last.startTime, {
                target: selectorFor(last.element),
                data: { size: last.size, url: last.url || undefined },
            });
        });
    }

    private observeCls(): void {
        let clsValue = 0;
        let sessionValue = 0;
        let sessionEntries: any[] = [];

        this.observe('layout-shift', (entries) => {
            for (const entry of entries as any[]) {
                // Shifts the user caused (typing, clicking) are not penalised.
                if (entry.hadRecentInput) continue;

                const first = sessionEntries[0];
                const last = sessionEntries[sessionEntries.length - 1];

                // CLS is the worst 5-second / 1-second-gap window, not the sum
                // of everything — a long session would otherwise always fail.
                if (
                    sessionValue &&
                    entry.startTime - last.startTime < 1000 &&
                    entry.startTime - first.startTime < 5000
                ) {
                    sessionValue += entry.value;
                    sessionEntries.push(entry);
                } else {
                    sessionValue = entry.value;
                    sessionEntries = [entry];
                }

                if (sessionValue > clsValue) {
                    clsValue = sessionValue;
                    const worst = sessionEntries
                        .slice()
                        .sort((a, b) => b.value - a.value)[0];
                    this.set('CLS', clsValue, {
                        target: worst?.sources?.[0]
                            ? selectorFor(worst.sources[0].node)
                            : undefined,
                    });
                }
            }
        });
    }

    private observeInp(): void {
        let worst = 0;
        this.observe('event', (entries) => {
            for (const entry of entries as any[]) {
                const duration = entry.duration;
                if (typeof duration !== 'number' || duration <= worst) continue;
                worst = duration;
                this.set('INP', duration, {
                    target: selectorFor(entry.target),
                    data: { interaction: entry.name },
                });
            }
        });
    }

    private observeLongTasks(): void {
        this.observe('longtask', (entries) => {
            for (const e of entries) {
                if (e.duration < this.opts.longTaskMs) continue;
                this.push({
                    name: 'LONG_TASK',
                    value: Math.round(e.duration),
                    rating: e.duration > 200 ? 'poor' : 'needs-improvement',
                    target: (e as any).attribution?.[0]?.containerName || undefined,
                    data: { start: Math.round(e.startTime) },
                });
            }
        });
    }

    private observeResources(): void {
        this.observe('resource', (entries) => {
            for (const e of entries as PerformanceResourceTiming[]) {
                if (e.duration < this.opts.slowResourceMs) continue;
                // Our own ingest calls are not the customer's problem.
                if (e.name.indexOf('/api/ingest/') !== -1) continue;
                this.push({
                    name: 'RESOURCE',
                    value: Math.round(e.duration),
                    rating: e.duration > 3000 ? 'poor' : 'needs-improvement',
                    target: e.name,
                    data: {
                        type: e.initiatorType,
                        size: e.transferSize || undefined,
                        cached: e.transferSize === 0 && e.decodedBodySize > 0,
                    },
                });
            }
        });
    }

    /**
     * Flush when the page is hidden. `visibilitychange` fires reliably on
     * mobile where `beforeunload` often does not; `pagehide` covers bfcache.
     */
    private installFlushTriggers(): void {
        const doFlush = () => this.flushNow();
        safe(() => {
            document.addEventListener(
                'visibilitychange',
                () => {
                    if (document.visibilityState === 'hidden') doFlush();
                },
                { capture: true },
            );
            window.addEventListener('pagehide', doFlush, { capture: true });
        });
    }

    flushNow(): void {
        if (this.flushed) return;
        try {
            const all = this.metrics.concat(Object.keys(this.latest).map((k) => this.latest[k]));
            if (all.length === 0) return;
            this.flushed = true;
            this.metrics = [];
            this.latest = {};
            this.flush(all);
        } catch {
            /* ignore */
        }
    }
}
