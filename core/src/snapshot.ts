import type { Snapshot, SnapshotOptions } from './types';
import { isBrowser } from './env';
import { nowIso } from './utils';

/**
 * DOM snapshot taken at error time.
 *
 * This is deliberately NOT a pixel screenshot. Serializing the DOM is smaller
 * than an image, keeps text selectable, lets the panel inspect elements, and
 * needs no extra library (html2canvas would add ~200KB to every customer's
 * bundle and still mis-renders modern CSS). The trade-off is that canvas and
 * video content come back blank — an acceptable loss for debugging layout and
 * state at the moment of failure.
 *
 * PRIVACY: this leaves the end user's screen and lands on the Zanbug server.
 * `maskInputs` defaults to true and every form value is replaced before
 * serialization. Turning it off is a conscious choice the developer makes.
 */

const MASK_CHAR = '•';

/** Elements that carry no visual meaning or would re-execute on replay. */
const DROP_TAGS = ['SCRIPT', 'NOSCRIPT', 'TEMPLATE'];

function maskValue(value: string): string {
    const len = Math.min(value.length, 12);
    return len > 0 ? MASK_CHAR.repeat(len) : '';
}

/**
 * Replace form values in the CLONE. Inputs are the highest-risk content on a
 * page: passwords, card numbers, personal details, search terms.
 */
function maskFormFields(root: Element): void {
    const fields = root.querySelectorAll('input, textarea, select');
    for (let i = 0; i < fields.length; i++) {
        const el = fields[i] as HTMLInputElement;
        try {
            const type = (el.getAttribute('type') || '').toLowerCase();

            // A password field's length is itself a hint — use a fixed mask.
            if (type === 'password') {
                el.setAttribute('value', MASK_CHAR.repeat(8));
                continue;
            }
            // Checkboxes/radios carry no free text; keep their state.
            if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') {
                continue;
            }

            const current = el.getAttribute('value') || '';
            if (current) el.setAttribute('value', maskValue(current));

            if (el.tagName === 'TEXTAREA' && el.textContent) {
                el.textContent = maskValue(el.textContent);
            }
        } catch {
            /* keep going — one bad node must not lose the whole snapshot */
        }
    }
}

/** Blank out anything the developer flagged as sensitive. */
function maskSelectors(root: Element, selectors: string[]): void {
    for (const sel of selectors) {
        try {
            const nodes = root.querySelectorAll(sel);
            for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i] as HTMLElement;
                if (el.textContent) el.textContent = MASK_CHAR.repeat(6);
            }
        } catch {
            /* an invalid selector is the developer's typo, not a crash */
        }
    }
}

/**
 * Copy live form state onto the clone's attributes.
 *
 * `cloneNode` copies attributes, not properties — a user-typed value lives in
 * `el.value` and would vanish. Copying it first, then masking, means the
 * snapshot shows "a filled field" rather than an empty one.
 */
function materializeFormState(source: Element, clone: Element): void {
    try {
        const src = source.querySelectorAll('input, textarea, select');
        const dst = clone.querySelectorAll('input, textarea, select');
        const n = Math.min(src.length, dst.length);
        for (let i = 0; i < n; i++) {
            const s = src[i] as HTMLInputElement;
            const d = dst[i] as HTMLInputElement;
            if (s.tagName === 'SELECT') {
                d.setAttribute('data-zanbug-selected', String((s as unknown as HTMLSelectElement).selectedIndex));
                continue;
            }
            if (typeof s.value === 'string' && s.value !== '') d.setAttribute('value', s.value);
            if (s.checked) d.setAttribute('checked', 'checked');
        }
    } catch {
        /* ignore */
    }
}

/** Concatenate same-origin stylesheet text so the replay renders standalone. */
function collectCss(maxBytes: number): string {
    let css = '';
    try {
        const sheets = document.styleSheets;
        for (let i = 0; i < sheets.length; i++) {
            if (css.length > maxBytes) break;
            try {
                // Cross-origin sheets throw on cssRules access — expected, skip.
                const rules = (sheets[i] as CSSStyleSheet).cssRules;
                if (!rules) continue;
                for (let j = 0; j < rules.length; j++) {
                    css += rules[j].cssText + '\n';
                    if (css.length > maxBytes) break;
                }
            } catch {
                continue;
            }
        }
    } catch {
        /* ignore */
    }
    return css.length > maxBytes ? css.slice(0, maxBytes) : css;
}

/** Why the last snapshot was dropped — reported in the event so it is not silent. */
let lastSkip: { reason: string; bytes: number; limit: number } | null = null;

export function snapshotSkipInfo(): { reason: string; bytes: number; limit: number } | null {
    return lastSkip;
}

const DATA_URI_ATTRS = ['src', 'srcset', 'href', 'poster', 'xlink:href'];
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

/**
 * Remove the bulk that does not affect layout:
 *  - data: URIs (base64 images/fonts) → a 1px placeholder, size attrs kept;
 *  - <style> text → dropped, its rules are re-sent through collectCss()
 *    (document.styleSheets includes inline sheets), so nothing is lost twice;
 *  - inline <svg> bodies larger than 2 KB → emptied, the box keeps its size;
 *  - inline style="background:url(data:…)" → url stripped.
 */
function shrink(root: Element): void {
    try {
        const all = root.getElementsByTagName('*');
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            for (const a of DATA_URI_ATTRS) {
                const v = el.getAttribute(a);
                if (v && v.length > 200 && v.slice(0, 5).toLowerCase() === 'data:') {
                    el.setAttribute(a, a === 'srcset' ? PIXEL + ' 1x' : PIXEL);
                }
            }
            const st = el.getAttribute('style');
            if (st && st.length > 200 && st.indexOf('data:') !== -1) {
                el.setAttribute('style', st.replace(/url\((['"]?)data:[^)]*\1\)/gi, 'none'));
            }
        }
        const styles = root.getElementsByTagName('style');
        for (let i = 0; i < styles.length; i++) styles[i].textContent = '';
        const svgs = root.getElementsByTagName('svg');
        for (let i = 0; i < svgs.length; i++) {
            const svg = svgs[i];
            if ((svg.innerHTML || '').length > 2048) svg.innerHTML = '';
        }
    } catch {
        /* best effort — fall back to the size check */
    }
}

export function takeSnapshot(opts: Required<SnapshotOptions>): Snapshot | null {
    lastSkip = null;
    if (!isBrowser || !opts.enabled) return null;

    try {
        const source = document.documentElement;
        if (!source) return null;

        const clone = source.cloneNode(true) as Element;

        // Order matters: materialize live values first, then mask them.
        materializeFormState(source, clone);
        if (opts.maskInputs) maskFormFields(clone);
        if (opts.maskSelectors && opts.maskSelectors.length) {
            maskSelectors(clone, opts.maskSelectors);
        }

        for (const tag of DROP_TAGS) {
            const nodes = clone.getElementsByTagName(tag);
            // Live HTMLCollection shrinks as we remove — always take index 0.
            while (nodes.length > 0) {
                const n = nodes[0];
                if (n.parentNode) n.parentNode.removeChild(n);
                else break;
            }
        }

        // A <base> makes relative asset URLs resolve against the original page
        // when the panel renders the snapshot from a different origin.
        try {
            const head = clone.querySelector('head');
            if (head && !head.querySelector('base')) {
                const base = document.createElement('base');
                base.setAttribute('href', document.baseURI || location.href);
                head.insertBefore(base, head.firstChild);
            }
        } catch {
            /* ignore */
        }

        let html = clone.outerHTML || '';
        if (html.length > opts.maxBytes) {
            // Admin SPAs (React/Vue tables, icon sprites, base64 images, CSS-in-JS
            // <style> blocks) routinely pass the limit. Shed the heavy parts that
            // carry no layout before giving up: half a DOM renders as garbage,
            // but a DOM without inline images still shows what the user saw.
            shrink(clone);
            html = clone.outerHTML || '';
        }
        if (html.length > opts.maxBytes) {
            lastSkip = { reason: 'too_large', bytes: html.length, limit: opts.maxBytes };
            return null;
        }
        lastSkip = null;

        const css = collectCss(Math.max(0, opts.maxBytes - html.length));

        return {
            kind: 'dom',
            html,
            css: css || undefined,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight,
                scrollX: window.scrollX || 0,
                scrollY: window.scrollY || 0,
            },
            url: location.href,
            taken_at: nowIso(),
        };
    } catch (e) {
        lastSkip = { reason: 'error: ' + String((e as Error)?.message || e).slice(0, 120), bytes: 0, limit: opts.maxBytes };
        return null;
    }
}
