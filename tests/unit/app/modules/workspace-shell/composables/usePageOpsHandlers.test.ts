import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { ICropMargins } from '@app/types/crop';

const operationMocks = vi.hoisted(() => ({
    deletePages: vi.fn(),
    extractPages: vi.fn(),
    rotatePages: vi.fn(),
    insertPages: vi.fn(),
    insertFile: vi.fn(),
    reorderPages: vi.fn(),
    cropPages: vi.fn(),
    removeCrop: vi.fn(),
}));

vi.mock('@app/composables/pdf/usePageOperations', () => ({ usePageOperations: () => ({
    isOperationInProgress: ref(false),
    deletePages: operationMocks.deletePages,
    extractPages: operationMocks.extractPages,
    rotatePages: operationMocks.rotatePages,
    insertPages: operationMocks.insertPages,
    insertFile: operationMocks.insertFile,
    reorderPages: operationMocks.reorderPages,
    cropPages: operationMocks.cropPages,
    removeCrop: operationMocks.removeCrop,
}) }));

const { usePageOpsHandlers } = await import('@app/modules/workspace-shell/composables/usePageOpsHandlers');

function createHarness() {
    const invalidateThumbnailPages = vi.fn();
    const invalidatePages = vi.fn();
    const reloadWaiterCancel = vi.fn();
    const preparePdfReloadWaiter = vi.fn(() => ({
        promise: Promise.resolve(),
        cancel: reloadWaiterCancel,
    }));

    const handlers = usePageOpsHandlers({
        workingCopyPath: ref('/tmp/work.pdf'),
        currentPage: ref(4),
        totalPages: ref(10),
        selectedThumbnailPages: ref<number[]>([]),
        setSelectedThumbnailPages: vi.fn(),
        invalidateThumbnailPages,
        pdfViewerRef: ref({ invalidatePages }),
        pageContextMenu: ref({
            visible: false,
            pages: [],
        }),
        closePageContextMenu: vi.fn(),
        onExportPages: vi.fn(),
        ensureHistoryBaselineForExternalMutation: vi.fn(async () => true),
        reloadWorkingCopyIntoHistory: vi.fn(async () => true),
        preparePdfReloadWaiter,
        clearOcrCache: vi.fn(),
        resetSearchCache: vi.fn(),
    });

    return {
        handlers,
        invalidateThumbnailPages,
        invalidatePages,
        preparePdfReloadWaiter,
        reloadWaiterCancel,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    operationMocks.rotatePages.mockResolvedValue(true);
    operationMocks.cropPages.mockResolvedValue(true);
    operationMocks.removeCrop.mockResolvedValue(true);
});

describe('usePageOpsHandlers crop reload strategy', () => {
    it('waits for document reload after rotation instead of selectively invalidating stale thumbnails', async () => {
        const {
            handlers,
            invalidateThumbnailPages,
            invalidatePages,
            preparePdfReloadWaiter,
        } = createHarness();

        await handlers.handlePageRotate([
            2,
            3,
        ], 90);

        expect(invalidateThumbnailPages).not.toHaveBeenCalled();
        expect(invalidatePages).not.toHaveBeenCalled();
        expect(preparePdfReloadWaiter).toHaveBeenCalledWith(4, { captureScrollSnapshot: false });
        expect(operationMocks.rotatePages).toHaveBeenCalledWith([
            2,
            3,
        ], 90);
    });

    it('cancels the page-only reload waiter when rotation fails', async () => {
        const {
            handlers,
            reloadWaiterCancel,
        } = createHarness();
        operationMocks.rotatePages.mockResolvedValueOnce(false);

        const result = await handlers.handlePageRotate([2], 90);

        expect(result).toBe(false);
        expect(reloadWaiterCancel).toHaveBeenCalledOnce();
    });

    it('lets crop operations reload fully instead of reusing stale page geometry', async () => {
        const {
            handlers,
            invalidateThumbnailPages,
            invalidatePages,
            preparePdfReloadWaiter,
        } = createHarness();

        const margins: ICropMargins = {
            top: 12,
            bottom: 24,
            left: 36,
            right: 48,
        };

        await handlers.handleCropPages([4], margins);
        await handlers.handleRemoveCrop([4]);

        expect(invalidateThumbnailPages).not.toHaveBeenCalled();
        expect(invalidatePages).not.toHaveBeenCalled();
        expect(preparePdfReloadWaiter).toHaveBeenNthCalledWith(1, 4, { captureScrollSnapshot: false });
        expect(preparePdfReloadWaiter).toHaveBeenNthCalledWith(2, 4, { captureScrollSnapshot: false });
        expect(operationMocks.cropPages).toHaveBeenCalledWith([4], margins);
        expect(operationMocks.removeCrop).toHaveBeenCalledWith([4]);
    });

    it('cancels the page-only reload waiter when crop fails', async () => {
        const {
            handlers,
            reloadWaiterCancel,
        } = createHarness();
        operationMocks.cropPages.mockResolvedValueOnce(false);

        const result = await handlers.handleCropPages([4], {
            top: 1,
            bottom: 2,
            left: 3,
            right: 4,
        });

        expect(result).toBe(false);
        expect(reloadWaiterCancel).toHaveBeenCalledOnce();
    });
});
