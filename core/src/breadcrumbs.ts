import type { Breadcrumb } from './types';
import { nowIso } from './utils';

/**
 * Fixed-size ring buffer of recent activity.
 *
 * Breadcrumbs are what turn "TypeError: cannot read x of undefined" into a
 * story: the click, the route change, the 500 from /api/orders, then the
 * crash. The buffer is capped so a long-lived SPA session cannot grow it
 * without bound.
 */
export class BreadcrumbBuffer {
    private items: Breadcrumb[] = [];

    constructor(private max: number) {}

    add(crumb: Omit<Breadcrumb, 'timestamp'> & { timestamp?: string }): void {
        try {
            const full: Breadcrumb = {
                type: crumb.type,
                message: crumb.message,
                level: crumb.level,
                data: crumb.data,
                timestamp: crumb.timestamp || nowIso(),
            };
            this.items.push(full);
            if (this.items.length > this.max) {
                this.items.splice(0, this.items.length - this.max);
            }
        } catch {
            /* never let telemetry break the app */
        }
    }

    /** Snapshot for sending. Copied so a later push cannot mutate a sent event. */
    all(): Breadcrumb[] {
        return this.items.slice();
    }

    clear(): void {
        this.items = [];
    }

    setMax(max: number): void {
        this.max = max;
        if (this.items.length > max) {
            this.items.splice(0, this.items.length - max);
        }
    }
}
