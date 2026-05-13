import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { IPageGeometry } from '@contracts/shared';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspaceOrchestration.types';
import type { ICropSelectionResult } from '@app/types/crop';

const mocks = vi.hoisted(() => ({
    getPageGeometry: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', () => ({ getPageOpsCapability: () => ({ getPageGeometry: (...args: unknown[]) => mocks.getPageGeometry(...args) }) }));
vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: { warn: (...args: unknown[]) => mocks.warn(...args) } }));

describe('useWorkspaceCrop', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('opens the crop dialog only after geometry and margins are ready', async () => {
        let resolveGeometry: ((value: IPageGeometry) => void) | undefined;

        mocks.getPageGeometry.mockImplementation(() =>
            new Promise<IPageGeometry>((resolve) => {
                resolveGeometry = resolve;
            }),
        );

        const selectionResult: ICropSelectionResult = {
            pageNumber: 1,
            pageRect: {
                width: 100,
                height: 50,
            },
            pageLocalRect: {
                x: 10,
                y: 5,
                width: 70,
                height: 40,
            },
        };

        const viewer: IPdfViewerExpose = {
            getViewerContainer: () => null,
            scrollToPage: vi.fn(),
            captureRegionToClipboard: vi.fn(async () => false),
            isCapturingRegion: false,
            startCropSelection: vi.fn(async () => selectionResult),
            cancelCropSelection: vi.fn(),
            isCropSelecting: false,
            saveDocument: vi.fn(async () => null),
            highlightSelection: vi.fn(async () => false),
            commentSelection: vi.fn(async () => false),
            commentAtPoint: vi.fn(async () => false),
            startCommentPlacement: vi.fn(),
            cancelCommentPlacement: vi.fn(),
            undoAnnotation: vi.fn(),
            redoAnnotation: vi.fn(),
            focusAnnotationComment: vi.fn(async () => {}),
            updateAnnotationComment: vi.fn(() => false),
            deleteAnnotationComment: vi.fn(async () => false),
            suppressAnnotationId: vi.fn(),
            suppressAnnotationStableKey: vi.fn(),
            removeAnnotationFromDom: vi.fn(),
            removeAnnotationFromInternalCache: vi.fn(),
            getMarkupSubtypeOverrides: () => new Map(),
            getAllShapes: () => [],
            getDeletedEmbeddedShapeAnnotationIds: () => [],
            loadShapes: vi.fn(),
            clearShapes: vi.fn(),
            clearSelectedShape: vi.fn(),
            deleteSelectedShape: vi.fn(),
            hasShapes: false,
            selectedShapeId: null,
            updateShape: vi.fn(),
            getSelectedShape: () => null,
            startImagePlacement: vi.fn(async () => false),
            clearPendingImagePlacement: vi.fn(),
            restorePendingImagePlacement: vi.fn(),
            invalidatePages: vi.fn(),
            requestScrollToCurrentResult: vi.fn(),
        };

        const { useWorkspaceCrop } = await import('@app/modules/workspace-shell/composables/useWorkspaceCrop');
        const crop = useWorkspaceCrop({
            pdfViewerRef: ref<IPdfViewerExpose | null>(viewer),
            workingCopyPath: ref('/tmp/work.pdf'),
        });

        const cropPromise = crop.handleCrop();
        await Promise.resolve();

        expect(crop.cropDialogLoading.value).toBe(true);
        expect(crop.cropDialogOpen.value).toBe(false);

        if (!resolveGeometry) {
            throw new Error('Expected crop geometry request to be pending');
        }

        resolveGeometry({
            mediaBox: {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            cropBox: null,
            rotation: 90,
        });

        await cropPromise;

        expect(crop.cropDialogLoading.value).toBe(false);
        expect(crop.cropDialogOpen.value).toBe(true);
        expect(crop.cropDialogPageNumber.value).toBe(1);
        expect(crop.cropDialogRotation.value).toBe(90);
        expect(crop.cropDialogMargins.value).toEqual({
            top: 20,
            bottom: 10,
            left: 20,
            right: 20,
        });
    });
});
