import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createPdfNavigationLayoutAuthority} from '@app/modules/pdf-viewer/runtime/navigation/createPdfNavigationLayoutAuthority';

describe('createPdfNavigationLayoutAuthority', () => {
    it('protects and prepares the complete paged target row before navigation applies', async () => {
        const ensurePageMetricsInRange = vi.fn(async () => true);
        const computeFitScale = vi.fn();
        const setupPagePlaceholders = vi.fn();
        const authority = createPdfNavigationLayoutAuthority({
            computeFitScale,
            ensurePageMetricsInRange,
            getNavigationTargetPage: () => 4,
            numPages: ref(10),
            setupPagePlaceholders,
            viewMode: ref('facing'),
            visibleRange: ref({
                start: 1,
                end: 2,
            }),
            zoomMode: ref('fit-height'),
        });

        expect(authority.getProtectedVisibleRange()).toEqual({
            start: 3,
            end: 4,
        });
        expect(authority.isVisibleRenderRangeCurrent({
            start: 3,
            end: 4,
        })).toBe(true);
        expect(authority.isVisibleRenderRangeCurrent({
            start: 1,
            end: 2,
        })).toBe(false);

        await authority.prepareNavigationLayout(4, new AbortController().signal);

        expect(ensurePageMetricsInRange).toHaveBeenCalledWith(3, 4);
        expect(computeFitScale).toHaveBeenCalledWith(4);
        expect(setupPagePlaceholders).toHaveBeenCalledOnce();
    });

    it('hydrates metrics without rewriting custom zoom layout and honors cancellation', async () => {
        const ensurePageMetricsInRange = vi.fn(async () => true);
        const computeFitScale = vi.fn();
        const setupPagePlaceholders = vi.fn();
        const authority = createPdfNavigationLayoutAuthority({
            computeFitScale,
            ensurePageMetricsInRange,
            getNavigationTargetPage: () => null,
            numPages: ref(10),
            setupPagePlaceholders,
            viewMode: ref('single'),
            visibleRange: ref({
                start: 5,
                end: 5,
            }),
            zoomMode: ref('custom'),
        });

        const controller = new AbortController();
        controller.abort();
        await authority.prepareNavigationLayout(5, controller.signal);

        expect(ensurePageMetricsInRange).toHaveBeenCalledWith(5, 5);
        expect(computeFitScale).not.toHaveBeenCalled();
        expect(setupPagePlaceholders).not.toHaveBeenCalled();
        expect(authority.getProtectedVisibleRange()).toEqual({
            start: 5,
            end: 5,
        });
    });
});
