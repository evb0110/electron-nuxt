import type { IRoundedScrollPosition } from '@app/modules/pdf-viewer/engine/pdf-rerender-restoration/pdfRerenderRestorationTypes';

export function getRoundedScrollPosition(container: HTMLElement | null): IRoundedScrollPosition {
    return {
        scrollTop: container ? Math.round(container.scrollTop) : null,
        scrollLeft: container ? Math.round(container.scrollLeft) : null,
    };
}
