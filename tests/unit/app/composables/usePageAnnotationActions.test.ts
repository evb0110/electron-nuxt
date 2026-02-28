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
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { usePageAnnotationActions } from '@app/composables/usePageAnnotationActions';

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
        selectedShapeId: { value: 'shape-1' as string | null },
        updateShape: vi.fn(),
        getSelectedShape: vi.fn(() => null),
        saveDocument: vi.fn(async () => new Uint8Array([
            9,
            9,
        ])),
    };

    const deps = {
        pdfViewerRef: ref(viewer),
        annotationTool: ref<'none' | 'highlight' | 'underline'>('highlight'),
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
        dragMode: ref(true),
        currentPage: ref(3),
        workingCopyPath: ref<string | null>('/tmp/work.pdf'),
        closeAnnotationContextMenu: vi.fn(),
        showAnnotationContextMenu: vi.fn(),
        handleAnnotationToolChange: vi.fn(),
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
