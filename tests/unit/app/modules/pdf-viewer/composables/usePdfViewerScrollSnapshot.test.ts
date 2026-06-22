import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { cast } from '@tests/helpers/cast';

const captureScrollSnapshotMock = vi.hoisted(() => vi.fn());
const restoreScrollFromSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/captureScrollSnapshot', () => ({captureScrollSnapshot: captureScrollSnapshotMock}));

vi.mock('@app/modules/pdf-viewer/engine/pdf-page-render-pipeline/restoreScrollFromSnapshot', () => ({restoreScrollFromSnapshot: restoreScrollFromSnapshotMock}));

const { usePdfViewerScrollSnapshot } = await import(
    '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfViewerScrollSnapshot'
);

describe('usePdfViewerScrollSnapshot', () => {
    it('keeps a DOM-derived snapshot when currentPage is stale and far away', () => {
        const domSnapshot = {
            width: 500,
            height: 800,
            centerX: 250,
            centerY: 400,
            anchorPage: 12,
        };
        captureScrollSnapshotMock.mockReturnValue(domSnapshot);

        const snapshot = usePdfViewerScrollSnapshot({
            viewerContainer: ref(cast<HTMLElement>({})),
            currentPage: ref(3),
            resolveHorizontalScrollClampForActiveSpread: () => null,
            syncHorizontalScrollForZoomMode: vi.fn(),
            scrollToPage: vi.fn(),
        }).captureViewerScrollSnapshot();

        expect(snapshot).toBe(domSnapshot);
        expect(captureScrollSnapshotMock).toHaveBeenCalledExactlyOnceWith(expect.anything());
    });
});
