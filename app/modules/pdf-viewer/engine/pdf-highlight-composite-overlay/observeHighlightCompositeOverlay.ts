import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';
import type { IHighlightCompositeHost } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/highlightCompositeSource';

const OVERLAY_CLASS = 'pdf-highlight-composite-overlay';

const ORIGINAL_HIDDEN_CLASS = 'pdf-highlight-composite-source';

const PRESERVE_SNAPSHOT_CLASS = 'pdf-layer-preserve-snapshot';

const OBSERVER_KEY = '__evbHighlightCompositeObserver';

const SCHEDULED_KEY = '__evbHighlightCompositeScheduled';

const RAF_ID_KEY = '__evbHighlightCompositeRefreshRafId';

function normalizeObservedClassName(className: string) {
    return className
        .split(/\s+/)
        .filter(name => name.length > 0 && name !== ORIGINAL_HIDDEN_CLASS)
        .join(' ');
}

function isOwnCompositeClassMutation(mutation: MutationRecord) {
    if (
        mutation.type !== 'attributes'
        || mutation.attributeName !== 'class'
        || !(mutation.target instanceof SVGElement)
    ) {
        return false;
    }
    return normalizeObservedClassName(mutation.oldValue ?? '')
        === normalizeObservedClassName(mutation.target.getAttribute('class') ?? '');
}

function scheduleCompositeRefresh(host: IHighlightCompositeHost) {
    if (host[SCHEDULED_KEY]) {
        return;
    }
    host[SCHEDULED_KEY] = true;
    const rafId = window.requestAnimationFrame(() => {
        if (host[RAF_ID_KEY] !== rafId) {
            return;
        }
        host[SCHEDULED_KEY] = false;
        host[RAF_ID_KEY] = undefined;
        const pageContainer = host.closest<HTMLElement>('.page_container');
        if (pageContainer) {
            refreshHighlightCompositeOverlay(pageContainer);
        }
    });
    host[RAF_ID_KEY] = rafId;
}

export function observeHighlightCompositeOverlay(pageContainer: HTMLElement) {
    const host = pageContainer.querySelector<IHighlightCompositeHost>('.page_canvas, .canvasWrapper');
    if (!host || host[OBSERVER_KEY] || typeof MutationObserver === 'undefined') {
        return;
    }

    const observer = new MutationObserver((mutations) => {
        const hasHighlightChange = mutations.some((mutation) => {
            const target = mutation.target;
            if (target instanceof SVGElement && target.closest(`.${OVERLAY_CLASS}`)) {
                return false;
            }
            if (isOwnCompositeClassMutation(mutation)) {
                return false;
            }
            return Array.from(mutation.addedNodes).some(node => (
                node instanceof SVGElement
                && node.classList.contains('highlight')
                && !node.classList.contains(PRESERVE_SNAPSHOT_CLASS)
            ))
                || Array.from(mutation.removedNodes).some(node => (
                    node instanceof SVGElement
                    && node.classList.contains('highlight')
                    && !node.classList.contains(PRESERVE_SNAPSHOT_CLASS)
                ))
                || (
                    target instanceof SVGElement
                    && target.classList.contains('highlight')
                    && !target.classList.contains(PRESERVE_SNAPSHOT_CLASS)
                );
        });
        if (hasHighlightChange) {
            scheduleCompositeRefresh(host);
        }
    });
    observer.observe(host, {
        childList: true,
        attributes: true,
        attributeFilter: [
            'class',
            'style',
            'fill',
            'fill-opacity',
        ],
        attributeOldValue: true,
        subtree: true,
    });
    host[OBSERVER_KEY] = observer;
}
