import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { IPageGeometry } from '@contracts/shared';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { ICropSelectionResult } from '@app/types/crop';

type TCreateTextMarkupOptions = Parameters<IPdfViewerExpose['createTextMarkupFromText']>[0];
type TCreatePointNoteOptions = Parameters<IPdfViewerExpose['createPointNoteAnnotation']>[0];
type TCreateShapeOptions = Parameters<IPdfViewerExpose['createShapeAnnotation']>[0];

const mocks = vi.hoisted(() => ({
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    getPageGeometry: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', () => ({ getPageOpsCapability: () => ({ getPageGeometry: (...args: unknown[]) => mocks.getPageGeometry(...args) }) }));
vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: {
    diagnostic: (...args: unknown[]) => mocks.diagnostic(...args),
    diagnosticThrottled: (...args: unknown[]) => mocks.diagnosticThrottled(...args),
    warn: (...args: unknown[]) => mocks.warn(...args),
} }));

function createPdfViewerExpose(overrides: Partial<IPdfViewerExpose> = {}): IPdfViewerExpose {
    const viewer: IPdfViewerExpose = {
        getViewerContainer: () => null,
        getPagePreview: () => null,
        scrollToPage: vi.fn(),
        captureRegionToClipboard: vi.fn(async () => false),
        isCapturingRegion: false,
        startCropSelection: vi.fn(async () => null),
        cancelCropSelection: vi.fn(),
        isCropSelecting: false,
        saveDocument: vi.fn(async () => null),
        highlightSelection: vi.fn(async () => false),
        commentSelection: vi.fn(async () => false),
        createTextMarkupFromText: vi.fn(async (options: TCreateTextMarkupOptions) => ({
            created: false,
            pageNumber: options.pageNumber,
            requestedText: options.text,
            matchedText: null,
            occurrence: options.occurrence ?? 1,
            subtype: 'Highlight' as const,
        })),
        commentAtPoint: vi.fn(async () => false),
        createPointNoteAnnotation: vi.fn(async (options: TCreatePointNoteOptions) => ({
            created: false,
            pageNumber: options.pageNumber,
            pageX: options.pageX,
            pageY: options.pageY,
        })),
        createShapeAnnotation: vi.fn(async (options: TCreateShapeOptions) => ({
            created: false,
            pageNumber: options.pageNumber,
            shape: null,
        })),
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

    return {
        ...viewer,
        ...overrides,
    };
}

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

        const viewer = createPdfViewerExpose({startCropSelection: vi.fn(async () => selectionResult)});

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

    it('ignores a crop selection if the working copy changes before selection resolves', async () => {
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
        const workingCopyPath = ref<string | null>('/tmp/original.pdf');
        const viewer = createPdfViewerExpose({startCropSelection: vi.fn(async () => {
            workingCopyPath.value = '/tmp/replaced.pdf';
            return selectionResult;
        })});

        const { useWorkspaceCrop } = await import('@app/modules/workspace-shell/composables/useWorkspaceCrop');
        const crop = useWorkspaceCrop({
            pdfViewerRef: ref<IPdfViewerExpose | null>(viewer),
            workingCopyPath,
        });

        await crop.handleCrop();

        expect(viewer.startCropSelection).toHaveBeenCalledOnce();
        expect(mocks.getPageGeometry).not.toHaveBeenCalled();
        expect(crop.cropDialogLoading.value).toBe(false);
        expect(crop.cropDialogOpen.value).toBe(false);
    });
});
