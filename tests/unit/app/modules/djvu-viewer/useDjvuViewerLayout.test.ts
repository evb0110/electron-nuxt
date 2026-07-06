import {
    computed,
    ref,
} from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDjvuViewerLayout } from '@app/modules/djvu-viewer/runtime/useDjvuViewerLayout';

function setDevicePixelRatio(value: number) {
    vi.stubGlobal('window', {devicePixelRatio: value});
}

function createLayoutHarness() {
    const pageSizes = ref([{
        width: 1_000,
        height: 1_200,
        dpi: 72,
    }]);

    return useDjvuViewerLayout({
        containerHeight: ref(1_000),
        containerWidth: ref(1_200),
        currentPage: ref(1),
        getRenderedPageNumbers: () => [1],
        isContinuousScroll: computed(() => true),
        manualZoom: computed(() => 1),
        pageSizes,
        totalPages: computed(() => pageSizes.value.length),
        viewMode: computed<TPdfViewMode>(() => 'single'),
        viewerContainer: ref(null),
        zoomMode: computed(() => 'custom' as const),
    });
}

describe('useDjvuViewerLayout', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('requests DjVu preview pixels for high-DPI displays', () => {
        setDevicePixelRatio(2);

        expect(createLayoutHarness().getNeededDeviceWidth(1)).toBe(2_000);
    });

    it('caps DjVu preview device-pixel ratio to bound preview memory', () => {
        setDevicePixelRatio(3);

        expect(createLayoutHarness().getNeededDeviceWidth(1)).toBe(2_000);
    });
});
