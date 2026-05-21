import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import { useAnnotationShapes } from '@app/composables/pdf/useAnnotationShapes';
import { useManagedEmbeddedPdfShapes } from '@app/composables/pdf/useManagedEmbeddedPdfShapes';

describe('useManagedEmbeddedPdfShapes', () => {
    it('rerenders hidden annotation pages without invalidating the mounted canvas first', async () => {
        const pendingTasks: Array<Promise<unknown>> = [];
        const invalidatePages = vi.fn();
        const renderVisiblePages = vi.fn(async () => {});
        const managedShapes = useManagedEmbeddedPdfShapes({
            viewerContainer: ref(null),
            workingCopyPath: ref(null),
            sourcePdfData: ref(null),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            bufferPages: ref(0),
            shapeComposable: useAnnotationShapes(),
            suppressCommentAnnotationId: vi.fn(),
            logger: {
                debug: vi.fn(),
                warn: vi.fn(),
            },
            runGuardedTask: (task) => {
                pendingTasks.push(Promise.resolve(task()));
            },
            nextTick,
            isPageRendered: pageNumber => pageNumber === 1,
            invalidatePages,
            renderVisiblePages,
            hideManagedAnnotationEditors: vi.fn(),
            currentPage: ref(1),
        });

        managedShapes.refreshHiddenAnnotationPage({ pageNumber: 1 });
        await Promise.all(pendingTasks);

        expect(invalidatePages).not.toHaveBeenCalled();
        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 1,
                end: 1,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
    });
});
