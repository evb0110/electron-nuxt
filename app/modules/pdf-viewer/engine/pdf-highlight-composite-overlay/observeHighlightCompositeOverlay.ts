import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';

const OVERLAY_CLASS = 'pdf-highlight-composite-overlay';

const PRESERVE_SNAPSHOT_CLASS = 'pdf-layer-preserve-snapshot';

const OBSERVER_KEY = '__evbHighlightCompositeObserver';

const SCHEDULED_KEY = '__evbHighlightCompositeScheduled';

type THighlightCompositeHost = HTMLElement & {
    [OBSERVER_KEY]?: MutationObserver | undefined;
    [SCHEDULED_KEY]?: boolean | undefined;
};

function scheduleCompositeRefresh(host: THighlightCompositeHost) {
    if (host[SCHEDULED_KEY]) {
        return;
    }
    host[SCHEDULED_KEY] = true;
    window.requestAnimationFrame(() => {
        host[SCHEDULED_KEY] = false;
        const pageContainer = host.closest<HTMLElement>('.page_container');
        if (pageContainer) {
            refreshHighlightCompositeOverlay(pageContainer);
        }
    });
}

export function observeHighlightCompositeOverlay(pageContainer: HTMLElement) {
    const host = pageContainer.querySelector<THighlightCompositeHost>('.page_canvas, .canvasWrapper');
    if (!host || host[OBSERVER_KEY] || typeof MutationObserver === 'undefined') {
        return;
    }

    const observer = new MutationObserver((mutations) => {
        const hasHighlightChange = mutations.some((mutation) => {
            const target = mutation.target;
            if (target instanceof SVGElement && target.closest(`.${OVERLAY_CLASS}`)) {
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
        subtree: true,
    });
    host[OBSERVER_KEY] = observer;
}
