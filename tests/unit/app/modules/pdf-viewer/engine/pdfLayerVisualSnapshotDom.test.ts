// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { activatePdfLayerVisualSnapshotHost } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotDom';
import { pdfLayerVisualSnapshotActiveClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotActiveClass';

describe('PDF layer visual snapshot host', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('releases each activation once', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const releaseFirst = activatePdfLayerVisualSnapshotHost(host);
        const releaseSecond = activatePdfLayerVisualSnapshotHost(host);

        releaseFirst();
        releaseFirst();
        expect(host.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(true);

        releaseSecond();
        expect(host.classList.contains(pdfLayerVisualSnapshotActiveClass)).toBe(false);
    });
});
