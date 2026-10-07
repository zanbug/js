/**
 * Per-process run attribution for Node (the JS twin of the PHP RunTracker).
 *
 * WHAT IT ANSWERS: "which cron / script / queue job loaded the server, for how
 * long, with how much CPU, memory and DB time — and what else was running at
 * the same moment?" One record is sent when the process ends (or per job when
 * the process is a long-running worker). Slow queries captured meanwhile are
 * tagged with the same `run_id`, so the panel can join them.
 *
 * Rules carried over from the PHP side (each one came from a real bug):
 *  - never throw, never keep the event loop alive (timers are unref'd)
 *  - a worker that ran jobs reports the JOBS, not itself (`jobsSeen`)
 *  - a zero-exit dispatcher (queue worker with no jobs) is noise → skipped
 *  - `finish()` runs on `beforeExit` ONLY. There is deliberately no SIGTERM
 *    listener: registering one changes the process's default behaviour (Node
 *    stops exiting on SIGTERM once a handler exists), which would turn a
 *    monitoring SDK into the reason a customer's deploy hangs.
 */

import type { ResolvedOptions } from './types';
import { SDK_VERSION, isNode, nodeBuiltin } from './env';
import { nowIso, randomId, safe } from './utils';

export type RunSource = 'cron' | 'scheduler' | 'queue' | 'artisan' | 'script';

const SOURCES: RunSource[] = ['cron', 'scheduler', 'queue', 'artisan', 'script'];
const FLUSH_EVERY = 20;
const FLUSH_SECONDS = 15;
const MAX_ANCESTORS = 4;

interface TransportLike {
    send(path: string, body: unknown, opts?: { timeoutMs?: number }): Promise<boolean>;
}

export interface RunRecord {
    run_id: string;
    command: string;
    source: RunSource;
    runtime: 'node';
    job_class: string | null;
    started_at: string;
    finished_at: string;
    duration_ms: number;
    cpu_ms: number;
    peak_memory_bytes: number;
    query_count: number;
    query_total_ms: number;
    slow_query_count: number;
    exit_code: number | null;
    hostname: string | null;
    pid: number;
    sdk_version: string;
    meta: Record<string, string | number | boolean | null>;
}

interface JobState {
    id: string;
    runId: string;
    name: string;
    source: RunSource;
    meta: Record<string, string | number | boolean | null>;
    startedAt: number;
    startedIso: string;
    cpu: { user: number; system: number };
    rss: number;
    queries: number;
    queryMs: number;
    slow: number;
}

type Scalar = string | number | boolean | null;

function scalars(input: unknown, max = 20): Record<string, Scalar> {
    const out: Record<string, Scalar> = {};
    if (!input || typeof input !== 'object') return out;
    let n = 0;
    for (const k of Object.keys(input as Record<string, unknown>)) {
        const v = (input as Record<string, unknown>)[k];
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            out[String(k).slice(0, 60)] = typeof v === 'string' ? v.slice(0, 300) : v;
            if (++n >= max) break;
        }
    }
    return out;
}

function cpuMsSince(start?: { user: number; system: number }): number {
    try {
        const u = process.cpuUsage(start);
        return Math.round((u.user + u.system) / 1000);
    } catch {
        return 0;
    }
}

function peakRssBytes(): number {
    try {
        const p: any = process;
        if (typeof p.resourceUsage === 'function') {
            const r = p.resourceUsage();
            // maxRSS is kilobytes on Linux/macOS, bytes nowhere we care about.
            if (r && typeof r.maxRSS === 'number') return r.maxRSS * 1024;
        }
        return process.memoryUsage().rss;
    } catch {
        return 0;
    }
}

function rssBytes(): number {
    try {
        return process.memoryUsage().rss;
    } catch {
        return 0;
    }
}

/** `/var/www/app/scripts/sync.js --full` → `scripts/sync.js --full`. */
export function commandFromArgv(argv: string[] = process.argv, cwd = safeCwd()): string {
    const parts = argv.slice(1).filter((a) => typeof a === 'string');
    if (parts.length === 0) return 'node';
    let script = parts[0];
    const binMatch = /node_modules[\\/](?:\.bin[\\/]|(?:@[^\\/]+[\\/])?[^\\/]+[\\/](?:bin|dist|cli)[\\/])([^\\/]+)$/.exec(script);
    if (binMatch) {
        script = binMatch[1].replace(/\.(c|m)?js$/, '');
    } else if (cwd && script.startsWith(cwd)) {
        script = script.slice(cwd.length).replace(/^[\\/]+/, '');
    }
    return [script].concat(parts.slice(1)).join(' ').slice(0, 300);
}

function safeCwd(): string {
    try {
        return process.cwd();
    } catch {
        return '';
    }
}

/** Walk `/proc` upwards (Linux only) and return ancestor command lines. */
function ancestorCommandLines(): string[] {
    const fs = nodeBuiltin('fs');
    if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.existsSync !== 'function') return [];
    const out: string[] = [];
    try {
        if (!fs.existsSync('/proc/self/stat')) return out;
        let pid = process.ppid;
        for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
            const cmd = String(fs.readFileSync(`/proc/${pid}/cmdline`)).split('\0').join(' ').trim();
            if (cmd) out.push(cmd);
            const stat = String(fs.readFileSync(`/proc/${pid}/stat`));
            // "pid (comm) state ppid ..." — comm may contain spaces, cut after ')'.
            const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            pid = parseInt(rest[1], 10);
            if (!isFinite(pid)) break;
        }
    } catch {
        /* partial ancestry is fine */
    }
    return out;
}

const QUEUE_HINT = /(^|[\s/:.-])(queue(:work|:listen)?|workers?|consumer|bull(mq)?|agenda|bee-queue|sqs)([\s/:.-]|$)/i;
const SCHEDULER_HINT = /schedule:(run|work)|schedule-run|cron:run|node-cron|scheduler/i;
const CRON_PARENT = /(^|\/)(crond?|CRON|anacron|systemd-run)(\s|$)|\bcron\b/;
const INIT_PARENT = /(^|\/)(systemd|init|supervisord|runsv|s6-supervise|pm2|sh -c|bash -c)(\s|$)/;

export function detectSource(command: string, ancestors: string[]): RunSource {
    const forced = typeof process !== 'undefined' && process.env ? String(process.env.ZANBUG_RUN_SOURCE || process.env.BUGBAN_RUN_SOURCE || '') : ''; // legacy: bugban → zanbug (2026-10-07)
    if ((SOURCES as string[]).indexOf(forced) !== -1) return forced as RunSource;
    if (QUEUE_HINT.test(command)) return 'queue';
    for (const line of ancestors) {
        if (SCHEDULER_HINT.test(line)) return 'scheduler';
    }
    for (const line of ancestors) {
        if (CRON_PARENT.test(line)) return 'cron';
    }
    const noTty = !(process.stdout && (process.stdout as any).isTTY) && !process.env.TERM && !process.env.SSH_TTY;
    if (noTty && ancestors.length > 0 && INIT_PARENT.test(ancestors[0])) return 'cron';
    return 'script';
}

export class RunTracker {
    private readonly runId = randomId();
    private readonly startedAt = Date.now();
    private readonly startedIso = nowIso();
    private readonly startCpu = safe(() => process.cpuUsage()) || { user: 0, system: 0 };
    private command: string;
    private source: RunSource;
    private argvQueueHint: boolean;
    private exitCode: number | null = null;
    private host: string | null = null;
    private queries = 0;
    private queryMs = 0;
    private slow = 0;
    private jobs = new Map<string, JobState>();
    private order: string[] = [];
    private jobsSeen = 0;
    private buffer: RunRecord[] = [];
    private timer: any = null;
    private finished = false;
    private closed = false;
    private jobProvider: (() => string | null | undefined) | null = null;
    private readonly onBeforeExit: () => void;

    constructor(
        private readonly transport: TransportLike,
        private readonly opts: ResolvedOptions,
    ) {
        this.command = safe(() => commandFromArgv()) || 'node';
        this.argvQueueHint = QUEUE_HINT.test(this.command);
        this.source = safe(() => detectSource(this.command, ancestorCommandLines())) || 'script';
        safe(() => {
            const os = nodeBuiltin('os');
            if (os && typeof os.hostname === 'function') this.host = String(os.hostname()).slice(0, 120);
        });
        this.onBeforeExit = () => {
            void this.finish();
        };
        safe(() => {
            if (isNode && typeof process.on === 'function') process.on('beforeExit', this.onBeforeExit);
        });
    }

    // ---- labelling ---------------------------------------------------

    setCommand(command: string): void {
        const c = String(command || '').trim();
        if (c) this.command = c.slice(0, 300);
    }

    setSource(source: string): void {
        if ((SOURCES as string[]).indexOf(source) !== -1) this.source = source as RunSource;
    }

    setExitCode(code: number): void {
        if (typeof code === 'number' && isFinite(code)) this.exitCode = code;
    }

    /**
     * For servers where many jobs run concurrently: return the handle of the
     * job the current async context belongs to (the Node adapter wires this to
     * AsyncLocalStorage). Without it, "current job" means "most recently begun".
     */
    setJobProvider(provider: (() => string | null | undefined) | null): void {
        this.jobProvider = typeof provider === 'function' ? provider : null;
    }

    // ---- jobs ------------------------------------------------------------

    beginJob(name: string, meta?: Record<string, unknown>, source: string = 'queue'): string {
        const id = randomId();
        const job: JobState = {
            id,
            runId: randomId(),
            name: String(name || 'job').slice(0, 300),
            source: (SOURCES as string[]).indexOf(source) !== -1 ? (source as RunSource) : 'queue',
            meta: scalars(meta),
            startedAt: Date.now(),
            startedIso: nowIso(),
            cpu: safe(() => process.cpuUsage()) || { user: 0, system: 0 },
            rss: rssBytes(),
            queries: 0,
            queryMs: 0,
            slow: 0,
        };
        this.jobs.set(id, job);
        this.order.push(id);
        return id;
    }

    /**
     * `endJob(handle, exitCode, error)` ends a specific job; `endJob(exitCode,
     * error)` ends the current one (provider, else most recent).
     */
    endJob(handleOrExit?: string | number, exitCode?: number, error?: string | null): void {
        let id: string | undefined;
        let code = 0;
        if (typeof handleOrExit === 'string') {
            id = handleOrExit;
            code = typeof exitCode === 'number' ? exitCode : 0;
        } else {
            id = this.currentJobId();
            code = typeof handleOrExit === 'number' ? handleOrExit : 0;
            error = typeof exitCode === 'string' ? (exitCode as unknown as string) : error;
        }
        if (!id) return;
        const job = this.jobs.get(id);
        if (!job) return;
        this.jobs.delete(id);
        this.order = this.order.filter((x) => x !== id);
        this.jobsSeen++;

        const meta: Record<string, Scalar> = { ...job.meta };
        if (error) meta.error = String(error).slice(0, 300);
        this.push({
            run_id: job.runId,
            command: job.name,
            source: job.source,
            runtime: 'node',
            job_class: job.name,
            started_at: job.startedIso,
            finished_at: nowIso(),
            duration_ms: Math.max(0, Date.now() - job.startedAt),
            cpu_ms: cpuMsSince(job.cpu),
            peak_memory_bytes: Math.max(job.rss, rssBytes()),
            query_count: job.queries,
            query_total_ms: Math.round(job.queryMs),
            slow_query_count: job.slow,
            exit_code: code,
            hostname: this.host,
            pid: process.pid,
            sdk_version: SDK_VERSION,
            meta: this.withEnv(meta),
        });
    }

    private currentJobId(): string | undefined {
        if (this.jobProvider) {
            const fromProvider = safe(() => this.jobProvider && this.jobProvider());
            if (fromProvider && this.jobs.has(fromProvider)) return fromProvider;
        }
        return this.order.length ? this.order[this.order.length - 1] : undefined;
    }

    // ---- queries ---------------------------------------------------------

    /** Called for EVERY query (not only slow ones) so DB time per run is real. */
    noteQuery(durationMs: number, slow = false): void {
        if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs < 0) return;
        const id = this.currentJobId();
        const job = id ? this.jobs.get(id) : undefined;
        if (job) {
            job.queries++;
            job.queryMs += durationMs;
            if (slow) job.slow++;
        } else {
            this.queries++;
            this.queryMs += durationMs;
            if (slow) this.slow++;
        }
    }

    /** Tags for a slow-query row: which run/job it belongs to. */
    current(): { source: RunSource; command: string; run_id: string } {
        const id = this.currentJobId();
        const job = id ? this.jobs.get(id) : undefined;
        if (job) return { source: job.source, command: job.name, run_id: job.runId };
        return { source: this.source, command: this.command, run_id: this.runId };
    }

    // ---- lifecycle -----------------------------------------------------

    private isDispatcher(exit: number): boolean {
        // A queue worker that processed no jobs and exited cleanly says nothing
        // about load; the same run would otherwise appear on every restart.
        return exit === 0 && this.jobsSeen === 0 && (this.argvQueueHint || SCHEDULER_HINT.test(this.command));
    }

    async finish(): Promise<void> {
        if (this.finished) return;
        this.finished = true;
        safe(() => {
            if (typeof process.off === 'function') process.off('beforeExit', this.onBeforeExit);
        });
        const exit = this.exitCode !== null ? this.exitCode : typeof process.exitCode === 'number' ? process.exitCode : 0;
        // Jobs still open at exit (crash mid-job) are closed as failed.
        for (const id of this.order.slice()) this.endJob(id, exit || 1, 'process exited before the job finished');
        if (this.jobsSeen === 0 && !this.isDispatcher(exit)) {
            this.push({
                run_id: this.runId,
                command: this.command,
                source: this.source,
                runtime: 'node',
                job_class: null,
                started_at: this.startedIso,
                finished_at: nowIso(),
                duration_ms: Math.max(0, Date.now() - this.startedAt),
                cpu_ms: cpuMsSince(this.startCpu),
                peak_memory_bytes: peakRssBytes(),
                query_count: this.queries,
                query_total_ms: Math.round(this.queryMs),
                slow_query_count: this.slow,
                exit_code: exit,
                hostname: this.host,
                pid: process.pid,
                sdk_version: SDK_VERSION,
                meta: this.withEnv({}),
            });
        }
        await this.flush();
    }

    private withEnv(meta: Record<string, Scalar>): Record<string, Scalar> {
        const out: Record<string, Scalar> = { ...meta };
        if (this.opts.environment) out.environment = String(this.opts.environment);
        if (this.opts.framework) out.framework = String(this.opts.framework);
        return out;
    }

    private push(record: RunRecord): void {
        if (this.closed) return;
        this.buffer.push(record);
        if (this.buffer.length >= FLUSH_EVERY) {
            void this.flush();
            return;
        }
        if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                void this.flush();
            }, FLUSH_SECONDS * 1000);
            safe(() => this.timer && typeof this.timer.unref === 'function' && this.timer.unref());
        }
    }

    async flush(): Promise<void> {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.buffer.length === 0) return;
        const runs = this.buffer.splice(0, this.buffer.length);
        try {
            await this.transport.send('/api/ingest/runs', { runs }, { timeoutMs: 5000 });
        } catch {
            /* monitoring never breaks the host; a lost run record is acceptable */
        }
    }

    /** Stop tracking; nothing is sent after this (client.close()). */
    async close(): Promise<void> {
        safe(() => {
            if (typeof process.off === 'function') process.off('beforeExit', this.onBeforeExit);
        });
        await this.flush();
        this.closed = true;
        this.finished = true;
    }
}
