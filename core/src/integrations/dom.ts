import { isBrowser } from '../env';
import { safe, selectorFor, truncate } from '../utils';

/**
 * Click and navigation breadcrumbs.
 *
 * These are the "what was the user doing" half of the story. Only the element's
 * selector and its visible label are recorded — never the value of any field
 * the user typed into.
 *
 * SPA route changes do not fire a page load, so history.pushState/replaceState
 * are wrapped as well; without that a React or Vue app looks like it never
 * navigates.
 */

export interface DomHooks {
    click: (label: string, data: Record<string, unknown>) => void;
    navigate: (from: string, to: string) => void;
}

/** A short human label for a clicked element, safe to record. */
function labelFor(el: Element): string {
    return (
        safe(() => {
            const aria = el.getAttribute('aria-label');
            if (aria) return truncate(aria, 60);

            const tag = el.tagName.toLowerCase();
            // Inputs: the label is the placeholder or name, NEVER the value.
            if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                const ph = el.getAttribute('placeholder') || el.getAttribute('name') || '';
                return ph ? `${tag}[${truncate(ph, 40)}]` : tag;
            }

            const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
            return text ? truncate(text, 60) : tag;
        }) || 'element'
    );
}

export function installDomBreadcrumbs(hooks: DomHooks): () => void {
    if (!isBrowser) return () => {};

    const undo: Array<() => void> = [];

    const onClick = (event: Event) => {
        safe(() => {
            const target = event.target as Element;
            if (!target || typeof (target as any).tagName !== 'string') return;

            // Walk up to the nearest interactive ancestor: a click usually
            // lands on the <span> inside a <button>, which is not the story.
            let el: Element | null = target;
            for (let i = 0; i < 4 && el; i++) {
                const tag = el.tagName.toLowerCase();
                if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') break;
                el = el.parentElement;
            }
            const chosen = el || target;

            hooks.click(labelFor(chosen), {
                selector: selectorFor(chosen),
                href: safe(() => chosen.getAttribute('href')) || undefined,
            });
        });
    };

    safe(() => document.addEventListener('click', onClick, { capture: true, passive: true }));
    undo.push(() => safe(() => document.removeEventListener('click', onClick, true)));

    // --- SPA navigation -----------------------------------------------------
    let current = safe(() => location.href) || '';

    const report = () => {
        safe(() => {
            const next = location.href;
            if (next !== current) {
                hooks.navigate(current, next);
                current = next;
            }
        });
    };

    safe(() => {
        const history = window.history as any;
        const origPush = history.pushState;
        const origReplace = history.replaceState;

        if (typeof origPush === 'function') {
            history.pushState = function (...args: unknown[]) {
                const r = origPush.apply(this, args as any);
                report();
                return r;
            };
            undo.push(() => {
                history.pushState = origPush;
            });
        }
        if (typeof origReplace === 'function') {
            history.replaceState = function (...args: unknown[]) {
                const r = origReplace.apply(this, args as any);
                report();
                return r;
            };
            undo.push(() => {
                history.replaceState = origReplace;
            });
        }
    });

    safe(() => window.addEventListener('popstate', report));
    undo.push(() => safe(() => window.removeEventListener('popstate', report)));

    return () => {
        for (const fn of undo) safe(fn);
    };
}
