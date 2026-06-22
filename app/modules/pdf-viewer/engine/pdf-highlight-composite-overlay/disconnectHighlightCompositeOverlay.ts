import type { IHighlightCompositeHost } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/highlightCompositeSource';

const OVERLAY_CLASS = 'pdf-highlight-composite-overlay';

const ORIGINAL_HIDDEN_CLASS = 'pdf-highlight-composite-source';

const PRESERVE_SNAPSHOT_CLASS = 'pdf-layer-preserve-snapshot';

const OBSERVER_KEY = '__evbHighlightCompositeObserver';

const SCHEDULED_KEY = '__evbHighlightCompositeScheduled';

const RAF_ID_KEY = '__evbHighlightCompositeRefreshRafId';

function queryAll<T extends Element>(
    root: ParentNode | null | undefined,
    selector: string,
) {
    return typeof root?.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll<T>(selector))
        : [];
}

function removeCompositeOverlay(host: HTMLElement) {
    if (typeof host.querySelector === 'function') {
        host.querySelector<SVGSVGElement>(
            `:scope > .${OVERLAY_CLASS}:not(.${PRESERVE_SNAPSHOT_CLASS})`,
        )?.remove();
    }
    queryAll<SVGElement>(
        host,
        `:scope > svg.${ORIGINAL_HIDDEN_CLASS}:not(.${PRESERVE_SNAPSHOT_CLASS})`,
    ).forEach((svg) => {
        svg.classList.remove(ORIGINAL_HIDDEN_CLASS);
    });
}

export function disconnectHighlightCompositeOverlay(pageContainer: HTMLElement) {
    const host = pageContainer.querySelector<IHighlightCompositeHost>('.page_canvas, .canvasWrapper');
    host?.[OBSERVER_KEY]?.disconnect();
    if (host) {
        const rafId = host[RAF_ID_KEY];
        if (typeof rafId === 'number' && typeof window !== 'undefined') {
            window.cancelAnimationFrame(rafId);
        }
        host[OBSERVER_KEY] = undefined;
        host[SCHEDULED_KEY] = undefined;
        host[RAF_ID_KEY] = undefined;
        removeCompositeOverlay(host);
    }
}
