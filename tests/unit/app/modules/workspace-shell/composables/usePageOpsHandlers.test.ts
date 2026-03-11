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

    const handlers = usePageOpsHandlers({
        workingCopyPath: ref('/tmp/work.pdf'),
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
        reloadWorkingCopyIntoHistory: vi.fn(async () => true),
        clearOcrCache: vi.fn(),
        resetSearchCache: vi.fn(),
    });

    return {
        handlers,
        invalidateThumbnailPages,
        invalidatePages,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    operationMocks.rotatePages.mockResolvedValue(true);
    operationMocks.cropPages.mockResolvedValue(true);
    operationMocks.removeCrop.mockResolvedValue(true);
});

describe('usePageOpsHandlers crop reload strategy', () => {
    it('keeps rotation on the selective invalidation path', async () => {
        const {
            handlers,
            invalidateThumbnailPages,
            invalidatePages,
        } = createHarness();

        await handlers.handlePageRotate([
            2,
            3,
        ], 90);

        expect(invalidateThumbnailPages).toHaveBeenCalledWith([
            2,
            3,
        ]);
        expect(invalidatePages).toHaveBeenCalledWith([
            2,
            3,
        ]);
        expect(operationMocks.rotatePages).toHaveBeenCalledWith([
            2,
            3,
        ], 90);
    });

    it('lets crop operations reload fully instead of reusing stale page geometry', async () => {
        const {
            handlers,
            invalidateThumbnailPages,
            invalidatePages,
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
        expect(operationMocks.cropPages).toHaveBeenCalledWith([4], margins);
        expect(operationMocks.removeCrop).toHaveBeenCalledWith([4]);
    });
});
