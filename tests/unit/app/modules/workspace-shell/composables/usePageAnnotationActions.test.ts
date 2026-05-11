import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { retry } from 'es-toolkit/function';
import {
    nextTick,
    ref,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotation-defaults';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdf-image-placement';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';

const { deleteEmbeddedAnnotationOffThread } = vi.hoisted(() => ({deleteEmbeddedAnnotationOffThread: vi.fn(async (
    _data: Uint8Array,
    _comment: IAnnotationCommentSummary,
) => new Uint8Array([
    8,
    8,
]))}));

vi.mock('@app/composables/pdf/pdfSerializationWorkerClient', () => ({deleteEmbeddedAnnotationOffThread}));

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

interface ITestViewerRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface ITestViewerPageContainer { getBoundingClientRect: () => ITestViewerRect; }

interface ITestViewerContainer {
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    querySelector: (selector: string) => ITestViewerPageContainer | null;
}

function createHarness() {
    const selectedShape = ref<IShapeAnnotation | null>(null);
    const viewerContainer = ref<ITestViewerContainer | null>(null);

    const viewer = {
        getViewerContainer: vi.fn(() => viewerContainer.value as HTMLElement | null),
        commentSelection: vi.fn(async () => false),
        commentAtPoint: vi.fn(async () => true),
        startCommentPlacement: vi.fn(),
        cancelCommentPlacement: vi.fn(),
        focusAnnotationComment: vi.fn(async () => {}),
        highlightSelection: vi.fn(async () => true),
        updateAnnotationComment: vi.fn(() => true),
        deleteAnnotationComment: vi.fn(async (_comment: IAnnotationCommentSummary) => true),
        registerAnnotationHistoryCommand: vi.fn(),
        suppressAnnotationId: vi.fn(),
        suppressAnnotationStableKey: vi.fn(),
        unsuppressAnnotationId: vi.fn(),
        unsuppressAnnotationStableKey: vi.fn(),
        removeAnnotationFromDom: vi.fn(),
        removeAnnotationFromInternalCache: vi.fn(),
        selectedShapeId: null as string | null,
        updateShape: vi.fn(),
        getSelectedShape: vi.fn(() => selectedShape.value),
        deleteSelectedShape: vi.fn(),
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
        loadPdfFromData: vi.fn(async (_data: Uint8Array, _opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        }) => {}),
        waitForPdfReload: vi.fn(async (_page: number) => {}),
        removeAnnotationFromCache: vi.fn(),
        restoreAnnotationToCache: vi.fn(),
        queuePendingEmbeddedAnnotationDelete: vi.fn(),
        unqueuePendingEmbeddedAnnotationDelete: vi.fn(),
        getEmbeddedMutationBaseData: vi.fn(async () => new Uint8Array([
            6,
            6,
        ])),
        embedPlacedImageToPage: vi.fn(async (_data: Uint8Array, _placement: IPdfPlacedImageFinalizePayload) => new Uint8Array([
            7,
            7,
        ])),
    };

    return {
        viewer,
        selectedShape,
        viewerContainer,
        deps,
        actions: usePageAnnotationActions(deps),
    };
}

beforeEach(() => {
    deleteEmbeddedAnnotationOffThread.mockClear();
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

    it('updates draw defaults when the selected shape is an ink drawing', () => {
        const {
            deps,
            viewer,
            selectedShape,
            actions,
        } = createHarness();

        selectedShape.value = {
            id: 'shape-ink',
            type: 'polyline',
            pageIndex: 0,
            x: 0.2,
            y: 0.2,
            width: 0.2,
            height: 0.2,
            color: '#e11d48',
            opacity: 0.9,
            strokeWidth: 2,
            source: 'embedded',
            pdfSubtype: 'Ink',
            points: [
                {
                    x: 0.2,
                    y: 0.2,
                },
                {
                    x: 0.4,
                    y: 0.4,
                },
            ],
            strokes: [[
                {
                    x: 0.2,
                    y: 0.2,
                },
                {
                    x: 0.4,
                    y: 0.4,
                },
            ]],
        };
        deps.pdfViewerRef.value = {
            ...viewer,
            selectedShapeId: 'shape-ink',
        };

        actions.handleShapePropertyUpdate({ opacity: 0.45 });

        expect(deps.annotationSettings.value.inkOpacity).toBe(0.45);
        expect(viewer.updateShape).toHaveBeenCalledWith('shape-ink', { opacity: 0.45 });
    });

    it('opens shape properties automatically for a newly selected shape', async () => {
        const {
            deps,
            viewer,
            selectedShape,
            viewerContainer,
            actions,
        } = createHarness();

        vi.stubGlobal('window', {
            innerWidth: 1400,
            innerHeight: 1000,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });

        viewerContainer.value = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            querySelector: (selector: string) => (
                selector === '.page_container[data-page="1"]'
                    ? { getBoundingClientRect: () => ({
                        left: 100,
                        top: 80,
                        width: 600,
                        height: 800,
                    }) }
                    : null
            ),
        };

        selectedShape.value = {
            id: 'shape-1',
            type: 'line',
            pageIndex: 0,
            x: 0.25,
            y: 0.4,
            x2: 0.8,
            y2: 0.2,
            width: 0.55,
            height: 0.2,
            color: '#3b82f6',
            opacity: 1,
            strokeWidth: 4,
        };
        deps.pdfViewerRef.value = {
            ...viewer,
            selectedShapeId: 'shape-1',
        };

        await nextTick();
        await nextTick();

        expect(actions.selectedShapeForProperties.value?.id).toBe('shape-1');
        expect(actions.shapePropertiesPopover.value.visible).toBe(true);
        expect(actions.shapePropertiesPopover.value.x).toBeGreaterThan(580);
        expect(actions.shapePropertiesPopover.value.y).toBeGreaterThanOrEqual(200);
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
            viewer,
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
            6,
            6,
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
        expect(viewer.saveDocument).not.toHaveBeenCalled();
    });

    it('uses planned embedded mutation bytes before finalizing placed images', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.getEmbeddedMutationBaseData.mockResolvedValueOnce(new Uint8Array([
            9,
            9,
        ]));

        await actions.handleFinalizePlacedImage({
            pageNumber: 4,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.15,
            rotationDegrees: 0,
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

        expect(viewer.saveDocument).not.toHaveBeenCalled();
        expect(deps.embedPlacedImageToPage).toHaveBeenCalledWith(new Uint8Array([
            9,
            9,
        ]), expect.any(Object));
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

    it('queues embedded delete for save instead of persisting immediately', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('editor-backed');
        comment.source = 'editor';
        comment.annotationId = '12R0';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.suppressAnnotationStableKey).toHaveBeenCalledWith(comment.stableKey);
        expect(viewer.suppressAnnotationId).toHaveBeenCalledWith('12R0');
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(comment);
        expect(viewer.removeAnnotationFromInternalCache).toHaveBeenCalledWith(comment.stableKey);
        expect(deps.removeAnnotationFromCache).toHaveBeenCalledWith(comment.stableKey);
        expect(deps.queuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(comment);
        expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledOnce();
    });

    it('registers undo for deferred embedded deletes', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('undoable-delete');
        comment.annotationId = '12R0';

        await actions.handleDeleteAnnotationComment(comment);

        const command = viewer.registerAnnotationHistoryCommand.mock.calls[0]?.[0];
        expect(command).toBeDefined();

        command.undo();

        expect(deps.unqueuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(comment.stableKey);
        expect(viewer.unsuppressAnnotationStableKey).toHaveBeenCalledWith(comment.stableKey);
        expect(viewer.unsuppressAnnotationId).toHaveBeenCalledWith('12R0');
        expect(deps.restoreAnnotationToCache).toHaveBeenCalledWith(comment);
    });

    it('reloads embedded image deletes from serialized bytes so stamp canvases do not stay stale', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('stamp-delete');
        comment.source = 'editor';
        comment.annotationId = '12R0';
        comment.subtype = 'Stamp';

        await actions.handleDeleteAnnotationComment(comment);

        expect(deleteEmbeddedAnnotationOffThread).toHaveBeenCalledWith(new Uint8Array([
            6,
            6,
        ]), comment);
        expect(viewer.saveDocument).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).toHaveBeenCalledWith(new Uint8Array([
            8,
            8,
        ]), {
            pushHistory: true,
            persistWorkingCopy: true,
        });
        expect(deps.waitForPdfReload).toHaveBeenCalledWith(1);
        expect(viewer.suppressAnnotationStableKey).not.toHaveBeenCalled();
        expect(deps.queuePendingEmbeddedAnnotationDelete).not.toHaveBeenCalled();
    });

    it('uses planned embedded mutation bytes before embedded stamp delete reloads', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.getEmbeddedMutationBaseData.mockResolvedValueOnce(new Uint8Array([
            9,
            9,
        ]));
        const comment = createComment('stamp-delete-with-live-edits');
        comment.source = 'editor';
        comment.annotationId = '12R0';
        comment.subtype = 'Stamp';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.saveDocument).not.toHaveBeenCalled();
        expect(deleteEmbeddedAnnotationOffThread).toHaveBeenCalledWith(new Uint8Array([
            9,
            9,
        ]), comment);
        expect(deps.loadPdfFromData).toHaveBeenCalledWith(new Uint8Array([
            8,
            8,
        ]), {
            pushHistory: true,
            persistWorkingCopy: true,
        });
    });

    it('marks embedded delete dirty when viewer delete could not resolve the note locally', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('queued-delete');
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.suppressAnnotationStableKey).toHaveBeenCalledWith(comment.stableKey);
        expect(deps.queuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(comment);
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
