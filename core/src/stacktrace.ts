import type { StackFrame } from './types';

/**
 * Error.stack parsing.
 *
 * There is no standard for `Error.stack`, so this handles the three shapes that
 * matter in practice: V8 (Chrome/Node/Edge), SpiderMonkey (Firefox) and
 * JavaScriptCore (Safari). Anything unrecognised degrades to a single frame
 * carrying the raw line rather than being dropped — a partial stack still
 * beats none in the panel.
 */

// V8:  "    at fnName (/path/file.js:10:5)"  |  "    at /path/file.js:10:5"
const V8_LINE = /^\s*at (?:(.+?)\s+\()?(?:(.+?):(\d+):(\d+)|([^)]+))\)?\s*$/;

// Firefox/Safari:  "fnName@/path/file.js:10:5"  |  "@/path/file.js:10:5"
const MOZ_LINE = /^\s*(?:(.*?)@)?(.+?):(\d+):(\d+)\s*$/;

/** Frames from these paths are framework/vendor noise, collapsed in the panel. */
const VENDOR_PATTERNS = [
    'node_modules',
    'webpack-internal',
    'webpack://',
    '/.next/',
    '/.nuxt/',
    'node:internal',
    'internal/process',
];

function isInApp(file?: string): boolean {
    if (!file) return false;
    for (const p of VENDOR_PATTERNS) {
        if (file.indexOf(p) !== -1) return false;
    }
    return true;
}

function toFrame(fn: string | undefined, file: string, line: string, col: string): StackFrame {
    const f: StackFrame = {
        file: file || undefined,
        line: line ? parseInt(line, 10) : undefined,
        column: col ? parseInt(col, 10) : undefined,
        in_app: isInApp(file),
    };
    if (fn && fn !== '<anonymous>') f.function = fn.trim();
    return f;
}

export function parseStack(stack: unknown, limit = 50): StackFrame[] {
    if (typeof stack !== 'string' || stack === '') return [];

    const frames: StackFrame[] = [];
    const lines = stack.split('\n');

    for (const raw of lines) {
        if (frames.length >= limit) break;
        const line = raw.replace(/\r$/, '');
        if (!line.trim()) continue;
        // The first line is usually "TypeError: message" — not a frame.
        if (!/^\s*at\s/.test(line) && line.indexOf('@') === -1) continue;

        let m = V8_LINE.exec(line);
        if (m) {
            // Group 5 is the "at /path:1:1" form with no function name, in which
            // case the location still needs splitting off the tail.
            if (m[5] && !m[2]) {
                const loc = /^(.*?):(\d+):(\d+)$/.exec(m[5]);
                frames.push(
                    loc
                        ? toFrame(m[1], loc[1], loc[2], loc[3])
                        : { function: m[1], file: m[5], in_app: isInApp(m[5]) },
                );
            } else {
                frames.push(toFrame(m[1], m[2] || '', m[3] || '', m[4] || ''));
            }
            continue;
        }

        m = MOZ_LINE.exec(line);
        if (m) {
            frames.push(toFrame(m[1], m[2] || '', m[3] || '', m[4] || ''));
            continue;
        }

        frames.push({ function: line.trim(), in_app: false });
    }

    return frames;
}

/**
 * Normalise anything a JS app can throw into an error-shaped object.
 * `throw 'a string'` and `Promise.reject({code: 500})` are both common; both
 * must produce a usable event rather than "undefined".
 */
export function normalizeError(input: unknown): {
    name: string;
    message: string;
    stack?: string;
} {
    if (input instanceof Error) {
        return {
            name: input.name || 'Error',
            message: input.message || String(input),
            stack: input.stack,
        };
    }

    if (typeof input === 'string') return { name: 'Error', message: input };

    if (input && typeof input === 'object') {
        const o = input as any;
        // DOMException, ErrorEvent, and plain {name, message} objects.
        if (typeof o.message === 'string') {
            return {
                name: typeof o.name === 'string' ? o.name : 'Error',
                message: o.message,
                stack: typeof o.stack === 'string' ? o.stack : undefined,
            };
        }
        try {
            return { name: 'Error', message: JSON.stringify(o) };
        } catch {
            return { name: 'Error', message: '[object]' };
        }
    }

    return { name: 'Error', message: String(input) };
}
