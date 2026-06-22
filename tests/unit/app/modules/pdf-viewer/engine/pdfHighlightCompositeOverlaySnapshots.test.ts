// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { disconnectHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/disconnectHighlightCompositeOverlay';
import { refreshHighlightCompositeOverlay } from '@app/modules/pdf-viewer/engine/pdf-highlight-composite-overlay/refreshHighlightCompositeOverlay';

function createCompositeOverlayPage() {
    const pageContainer = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'page_canvas';
    const preservedOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    preservedOverlay.classList.add('pdf-highlight-composite-overlay', 'pdf-layer-preserve-snapshot');
    const liveOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    liveOverlay.classList.add('pdf-highlight-composite-overlay');
    host.append(preservedOverlay, liveOverlay);
    pageContainer.append(host);
    document.body.append(pageContainer);
    return {
        host,
        liveOverlay,
        pageContainer,
        preservedOverlay,
    };
}

describe('pdfHighlightCompositeOverlay preserved snapshots', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('keeps preserved composite overlay snapshots during refresh cleanup', () => {
        const {
            host,
            liveOverlay,
            pageContainer,
            preservedOverlay,
        } = createCompositeOverlayPage();

        refreshHighlightCompositeOverlay(pageContainer);

        expect(host.contains(preservedOverlay)).toBe(true);
        expect(host.contains(liveOverlay)).toBe(false);
    });

    it('keeps preserved composite overlay snapshots during disconnect cleanup', () => {
        const {
            host,
            liveOverlay,
            pageContainer,
            preservedOverlay,
        } = createCompositeOverlayPage();

        disconnectHighlightCompositeOverlay(pageContainer);

        expect(host.contains(preservedOverlay)).toBe(true);
        expect(host.contains(liveOverlay)).toBe(false);
    });
});
