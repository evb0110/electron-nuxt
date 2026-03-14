import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { retry } from 'es-toolkit/function';
import { ref } from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdf-image-placement';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';

function createComment(stableKey: string): IAnnotationCommentSummary {
    return {
        id: stableKey,
        stableKey,
        pageIndex: 0,
        pageNumber: 1,
        text: `comment-${stableKey}`,
        author: null,
        modifiedAt: null,
        color: null,
        uid: null,
        annotationId: null,
        source: 'pdf',
    };
}

function deferred<T>() {
    let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });

    return {
        promise,
        resolve: (value: T) => resolve?.(value),
    };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 300) {
    const intervalMs = 5;
    try {
        await retry(async () => {
            if (!condition()) {
                throw new Error('Condition not met');
            }
        }, {
            retries: Math.max(0, Math.ceil(timeoutMs / intervalMs) - 1),
            delay: intervalMs,
        });
    } catch {
        throw new Error('Timed out waiting for condition');
    }
}

function createHarness() {
    const viewer = {
        commentSelection: vi.fn(async () => false),
        commentAtPoint: vi.fn(async () => true),
        startCommentPlacement: vi.fn(),
        cancelCommentPlacement: vi.fn(),
        focusAnnotationComment: vi.fn(async () => {}),
        highlightSelection: vi.fn(async () => true),
        updateAnnotationComment: vi.fn(() => true),
        deleteAnnotationComment: vi.fn(async (_comment: IAnnotationCommentSummary) => true),
        suppressAnnotationId: vi.fn(),
        removeAnnotationFromDom: vi.fn(),
        removeAnnotationFromInternalCache: vi.fn(),
        selectedShapeId: 'shape-1' as string | null,
        updateShape: vi.fn(),
        getSelectedShape: vi.fn(() => null),
        saveDocument: vi.fn(async () => new Uint8Array([
            9,
            9,
        ])),
        startImagePlacement: vi.fn(async () => true),
        restorePendingImagePlacement: vi.fn(),
    };

    const annotationTool = ref<TAnnotationTool>('highlight');
    const dragMode = ref(true);
    const handleAnnotationToolChange = vi.fn((tool: TAnnotationTool) => {
        annotationTool.value = tool;
        dragMode.value = false;
    });

    const deps = {
        pdfViewerRef: ref(viewer),
        annotationTool,
        annotationKeepActive: ref(false),
        annotationPlacingPageNote: ref(false),
        annotationSettings: ref({ ...DEFAULT_ANNOTATION_SETTINGS }),
        annotationActiveCommentStableKey: ref<string | null>(null),
        annotationContextMenu: ref({
            visible: true,
            comment: null as IAnnotationCommentSummary | null,
            hasSelection: false,
            selectionText: '',
            pageNumber: null as number | null,
            pageX: null as number | null,
            pageY: null as number | null,
        }),
        showSidebar: ref(false),
        sidebarTab: ref<'annotations' | 'thumbnails' | 'bookmarks' | 'search'>('search'),
        dragMode,
        currentPage: ref(3),
        workingCopyPath: ref<string | null>('/tmp/work.pdf'),
        closeAnnotationContextMenu: vi.fn(),
        showAnnotationContextMenu: vi.fn(),
        handleAnnotationToolChange,
        openAnnotationNoteWindow: vi.fn(),
        removeAnnotationNoteWindow: vi.fn(),
        setAnnotationNoteWindowError: vi.fn(),
        isSameAnnotationComment: vi.fn((a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => a.stableKey === b.stableKey),
        annotationNoteWindows: ref<Array<{ comment: IAnnotationCommentSummary }>>([]),
        deleteEmbeddedByRef: vi.fn(async () => null),
        loadPdfFromData: vi.fn(async (_data: Uint8Array, _opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        }) => {}),
        waitForPdfReload: vi.fn(async (_page: number) => {}),
        removeAnnotationFromCache: vi.fn(),
        persistPdfDataSilently: vi.fn(async () => {}),
        markAnnotationSaved: vi.fn(),
        resetAnnotationStorageModified: vi.fn(),
        embedPlacedImageToPage: vi.fn(async (_data: Uint8Array, _placement: IPdfPlacedImageFinalizePayload) => new Uint8Array([
            7,
            7,
        ])),
    };

    return {
        viewer,
        deps,
        actions: usePageAnnotationActions(deps),
    };
}

beforeEach(() => {
    vi.stubGlobal('useTypedI18n', () => ({
        t: (key: string) => key,
        setLocale: vi.fn(async () => {}),
        loadLocaleMessages: vi.fn(async () => {}),
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('usePageAnnotationActions', () => {
    it('starts quick note placement when selection-based note is not created', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();

        deps.showSidebar.value = true;
        deps.sidebarTab.value = 'bookmarks';
        viewer.commentSelection.mockResolvedValue(false);

        await actions.handleQuickNoteAction();

        expect(viewer.commentSelection).toHaveBeenCalledOnce();
        expect(viewer.startCommentPlacement).toHaveBeenCalledOnce();
        expect(deps.annotationPlacingPageNote.value).toBe(true);
        expect(deps.annotationTool.value).toBe('none');
        expect(deps.dragMode.value).toBe(false);
        expect(deps.showSidebar.value).toBe(true);
        expect(deps.sidebarTab.value).toBe('bookmarks');
    });

    it('clamps shape context menu popover coordinates to viewport bounds', () => {
        vi.stubGlobal('window', {
            innerWidth: 320,
            innerHeight: 220,
        });

        const {
            deps,
            actions,
        } = createHarness();

        actions.handleShapeContextMenu({
            shapeId: 'shape-1',
            clientX: 999,
            clientY: -25,
        });

        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(actions.shapePropertiesPopover.value).toEqual({
            visible: true,
            x: 52,
            y: 8,
        });
    });

    it('updates selected shape properties when selectedShapeId is exposed as unwrapped value', () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();

        viewer.selectedShapeId = 'shape-1';

        actions.handleShapePropertyUpdate({ strokeWidth: 7.5 });

        expect(deps.annotationSettings.value.shapeStrokeWidth).toBe(7.5);
        expect(viewer.updateShape).toHaveBeenCalledWith('shape-1', { strokeWidth: 7.5 });
    });

    it('creates markup from context menu and resets tool when keep-active is disabled', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();

        await actions.createContextMenuMarkup('underline');

        expect(deps.handleAnnotationToolChange).toHaveBeenCalledWith('underline');
        expect(viewer.highlightSelection).toHaveBeenCalledOnce();
        expect(deps.annotationTool.value).toBe('none');
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });

    it('starts an image placement session from file without switching annotation tools', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const documents = {
            openImageDialog: vi.fn(async () => '/tmp/test.png'),
            readFile: vi.fn(async () => [
                1,
                2,
                3,
            ]),
        };

        Object.defineProperty(globalThis, 'window', {
            value: globalThis,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(globalThis, 'electronAPI', {
            value: { documents },
            configurable: true,
            writable: true,
        });

        await actions.insertImageFromFileAt(2, 0.25, 0.5);

        expect(deps.handleAnnotationToolChange).not.toHaveBeenCalledWith('stamp');
        expect(deps.annotationTool.value).toBe('highlight');
        expect(viewer.startImagePlacement).toHaveBeenCalledOnce();
        expect(viewer.startImagePlacement).toHaveBeenCalledWith(
            expect.any(File),
            {
                pageNumber: 2,
                pageX: 0.25,
                pageY: 0.5,
            },
        );
    });

    it('finalizes a placed image by embedding it into the reloaded PDF', async () => {
        const {
            deps,
            actions,
        } = createHarness();
        const finalized = await actions.handleFinalizePlacedImage({
            pageNumber: 4,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.15,
            rotationDegrees: 90,
            fileName: 'image.png',
            mimeType: 'image/png',
            bytes: new Uint8Array([
                1,
                2,
                3,
            ]),
            targetPixelWidth: 240,
            targetPixelHeight: 120,
        });

        expect(finalized).toBe(true);
        expect(deps.embedPlacedImageToPage).toHaveBeenCalledWith(new Uint8Array([
            9,
            9,
        ]), expect.objectContaining({
            pageNumber: 4,
            rotationDegrees: 90,
            targetPixelWidth: 240,
            targetPixelHeight: 120,
        }));
        expect(deps.waitForPdfReload).toHaveBeenCalledWith(4);
        expect(deps.loadPdfFromData).toHaveBeenCalledWith(new Uint8Array([
            7,
            7,
        ]), {
            pushHistory: true,
            persistWorkingCopy: true,
        });
    });

    it('serializes delete requests through a single queue', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const commentA = createComment('a');
        const commentB = createComment('b');
        deps.annotationNoteWindows.value = [
            { comment: commentA },
            { comment: commentB },
        ];

        const gate = deferred<undefined>();
        const deleteOrder: string[] = [];
        viewer.deleteAnnotationComment.mockImplementation(async (comment: IAnnotationCommentSummary) => {
            deleteOrder.push(comment.stableKey);
            if (comment.stableKey === 'a') {
                await gate.promise;
            }
            return true;
        });

        const deleteA = actions.handleDeleteAnnotationComment(commentA);
        const deleteB = actions.handleDeleteAnnotationComment(commentB);

        await waitForCondition(() => deleteOrder.length === 1);
        expect(deleteOrder).toEqual(['a']);

        gate.resolve(undefined);
        await Promise.all([
            deleteA,
            deleteB,
        ]);

        expect(deleteOrder).toEqual([
            'a',
            'b',
        ]);
        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith('a');
        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith('b');
    });

    it('reloads current page from serialized data for embedded fallback', async () => {
        const {
            deps,
            actions,
        } = createHarness();

        const didReload = await actions.serializeCurrentPdfForEmbeddedFallback();

        expect(didReload).toBe(true);
        expect(deps.waitForPdfReload).toHaveBeenCalledWith(3);
        expect(deps.loadPdfFromData).toHaveBeenCalledWith(new Uint8Array([
            9,
            9,
        ]), {
            pushHistory: true,
            persistWorkingCopy: true,
        });
    });
});
