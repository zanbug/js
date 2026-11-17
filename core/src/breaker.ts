/**
 * Circuit breaker for the Zanbug transport.
 *
 * When Zanbug is unreachable (server down, hosting suspended, packets dropped)
 * every send would otherwise sit out its full timeout — piling up sockets and
 * timers, and in serverless/edge handlers that `await` a flush, delaying the
 * customer's own response. After a failed send the breaker opens: sends are
 * skipped instantly until a cool-down passes, then ONE probe goes through.
 * Repeated failures back the cool-down off (30s, 60s, 120s … capped at 10 min);
 * a success closes it.
 *
 * State is per host, in memory, shared by every Transport in the process.
 * (The PHP SDK shares it across workers via a temp file; a JS process is
 * long-lived, so memory is enough.)
 */

const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 600_000;
/** How long a probe holds the breaker shut for every other caller. */
const PROBE_LEASE_MS = 5_000;

interface State {
    fails: number;
    until: number;
}

export class CircuitBreaker {
    private static shared = new Map<string, CircuitBreaker>();

    /** One breaker per host, so all clients in a process agree. */
    static for(host: string): CircuitBreaker {
        let b = CircuitBreaker.shared.get(host);
        if (!b) {
            b = new CircuitBreaker();
            CircuitBreaker.shared.set(host, b);
        }
        return b;
    }

    private state: State = { fails: 0, until: 0 };

    constructor(private clock: () => number = Date.now) {}

    /** True when a send may go out now. */
    allow(): boolean {
        const { until } = this.state;
        if (until <= 0) return true; // closed
        const now = this.clock();
        if (now < until) return false; // open
        // Cool-down over: lease a single probe, keep everyone else out meanwhile.
        this.state.until = now + PROBE_LEASE_MS;
        return true;
    }

    success(): void {
        this.state = { fails: 0, until: 0 };
    }

    failure(): void {
        const fails = this.state.fails + 1;
        const cool = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** Math.min(fails - 1, 10));
        this.state = { fails, until: this.clock() + cool };
    }
}
