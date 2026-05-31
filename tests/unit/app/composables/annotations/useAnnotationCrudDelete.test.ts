import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
    type Ref,
    type ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

vi.mock('pdfjs-dist', () => ({AnnotationEditorType: {
    DISABLE: -1,
    NONE: 0,
    FREETEXT: 1,
    HIGHLIGHT: 2,
    STAMP: 3,
    INK: 4,
    POPUP: 5,
}}));

vi.mock('@app/services/pdfjs/runtimeLib', () => ({AnnotationEditorType: {
    DISABLE: -1,
    NONE: 0,
    FREETEXT: 1,
    HIGHLIGHT: 2,
    STAMP: 3,
    INK: 4,
    POPUP: 5,
}}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}}));

interface IFakeEditor {
    id: string;
    uid: string | null;
    annotationElementId: string | null;
    parentPageIndex: number;
    _editorType?: number | undefined;
    comment: string | { text?: string };
    div: HTMLElement | undefined;
    addToAnnotationStorage: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    toggleComment: ReturnType<typeof vi.fn>;
}

interface IFakeUiManager {
    getMode: ReturnType<typeof vi.fn>;
    getEditors: ReturnType<typeof vi.fn>;
    getEditor?: ReturnType<typeof vi.fn>;
    getLayer?: ReturnType<typeof vi.fn>;
    setSelected: ReturnType<typeof vi.fn>;
    selectComment?: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    waitForEditorsRendered: ReturnType<typeof vi.fn>;
    unselectAll: ReturnType<typeof vi.fn>;
    __editors: IFakeEditor[];
}

function createFakeEditor(overrides: Partial<IFakeEditor> = {}): IFakeEditor {
    return {
        id: overrides.id ?? 'editor-1',
        uid: overrides.uid ?? 'editor-1',
        annotationElementId: overrides.annotationElementId ?? null,
        parentPageIndex: overrides.parentPageIndex ?? 0,
        _editorType: overrides._editorType,
        comment: overrides.comment ?? '',
        div: overrides.div,
        addToAnnotationStorage: overrides.addToAnnotationStorage ?? vi.fn(),
        remove: overrides.remove ?? vi.fn(),
        delete: overrides.delete ?? vi.fn(),
        toggleComment: overrides.toggleComment ?? vi.fn(),
    };
}

interface ICreateUiManagerOpts {
    omitGetEditor?: boolean;
    omitGetLayer?: boolean;
    omitSelectComment?: boolean;
}

function createFakeUiManager(
    editors: IFakeEditor[] = [],
    opts: ICreateUiManagerOpts = {},
): IFakeUiManager {
    const layer = {getEditorByUID: (uid: string) => editors.find(e => e.uid === uid) ?? null};
    const manager: IFakeUiManager = {
        getMode: vi.fn(() => 0),
        getEditors: vi.fn((pageIndex: number) => editors.filter(e => e.parentPageIndex === pageIndex)),
        setSelected: vi.fn(),
        delete: vi.fn(),
        waitForEditorsRendered: vi.fn(async () => {}),
        unselectAll: vi.fn(),
        __editors: editors,
    };
    if (!opts.omitGetEditor) {
        manager.getEditor = vi.fn((id: string) => editors.find(e => e.id === id) ?? null);
    }
    if (!opts.omitGetLayer) {
        manager.getLayer = vi.fn(() => layer);
    }
    if (!opts.omitSelectComment) {
        manager.selectComment = vi.fn(() => {});
    }
    return manager;
}

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'editor-1',
        stableKey: overrides.stableKey ?? 'editor:0:editor-1',
        sortIndex: overrides.sortIndex ?? null,
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? 'note text',
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? null,
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? null,
        uid: overrides.uid ?? 'editor-1',
        annotationId: overrides.annotationId ?? null,
        source: overrides.source ?? 'editor',
        hasNote: overrides.hasNote ?? true,
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.1,
            width: 0.1,
            height: 0.05,
        },
    };
}

interface IHarnessOverrides {
    editors?: IFakeEditor[];
    uiManagerNull?: boolean;
    uiManagerOpts?: ICreateUiManagerOpts;
    annotationStorageGetEditor?: (annotationElementId: string) => IFakeEditor | null;
    cache?: IAnnotationCommentSummary[];
    commentToReturnFromCache?: IAnnotationCommentSummary | null;
    syncCallback?: () => void;
}

async function createHarness(overrides: IHarnessOverrides = {}) {
    const { useAnnotationCrud } = await import('@app/composables/pdf/annotations/useAnnotationCrud');

    const editors = overrides.editors ?? [];
    const uiManager = overrides.uiManagerNull ? null : createFakeUiManager(editors, overrides.uiManagerOpts);
    const annotationUiManager = cast<ShallowRef<AnnotationEditorUIManager | null>>(
        shallowRef(uiManager),
    );
    const pdfDocument = cast<ShallowRef<PDFDocumentProxy | null>>(
        shallowRef({ annotationStorage: { getEditor: overrides.annotationStorageGetEditor ?? (() => null) } }),
    );
    const annotationCommentsCache = ref<IAnnotationCommentSummary[]>(overrides.cache ?? []) as Ref<IAnnotationCommentSummary[]>;

    const pendingCommentEditorKeys = new Set<string>();
    pendingCommentEditorKeys.add('pending:editor-1');

    const syncAnnotationComments = vi.fn(async () => {
        overrides.syncCallback?.();
    });
    const scheduleAnnotationCommentsSync = vi.fn();
    const debouncedSyncInlineCommentIndicators = vi.fn();
    const emitAnnotationModified = vi.fn();
    const updateModeWithRetry = vi.fn(async () => null);
    const forgetSummaryText = vi.fn();
    const rememberSummaryText = vi.fn();
    const resolveCommentFromCache = vi.fn((c: IAnnotationCommentSummary) => {
        if (overrides.commentToReturnFromCache !== undefined) {
            return overrides.commentToReturnFromCache;
        }
        return c;
    });

    const callOrder: string[] = [];
    emitAnnotationModified.mockImplementation(() => callOrder.push('emitAnnotationModified'));
    scheduleAnnotationCommentsSync.mockImplementation(() => callOrder.push('scheduleAnnotationCommentsSync'));
    debouncedSyncInlineCommentIndicators.mockImplementation(() => callOrder.push('debouncedSyncInlineCommentIndicators'));
    forgetSummaryText.mockImplementation(() => callOrder.push('forgetSummaryText'));

    const crud = useAnnotationCrud({
        viewerContainer: ref(null),
        pdfDocument,
        annotationUiManager,
        numPages: ref(1),
        currentPage: ref(1),
        annotationTool: ref<TAnnotationTool>('none'),
        annotationCommentsCache,
        getIdentity: () => ({
            resolveCommentFromCache,
            getEditorIdentity: (editor: IPdfjsEditor) => editor.uid ?? editor.id ?? '',
            getEditorPendingKey: (editor: IPdfjsEditor) => `pending:${editor.id ?? editor.uid ?? 'unknown'}`,
            hydrateSummaryFromMemory: (s: IAnnotationCommentSummary) => s,
            computeSummaryStableKey: () => 'stable',
            rememberSummaryText,
            forgetSummaryText,
            commentMergePriority: () => 0,
        }),
        getSync: () => ({
            pendingCommentEditorKeys,
            trackedCreatedEditors: new WeakSet<object>(),
            syncAnnotationComments,
            scheduleAnnotationCommentsSync,
            toEditorSummary: vi.fn(),
            setActiveCommentStableKey: vi.fn(),
            clearSyncState: vi.fn(),
        }),
        getFreeTextResize: () => ({ ensureFreeTextEditorCanResize: vi.fn() }),
        getToolManager: () => ({ updateModeWithRetry }),
        getInlineIndicators: () => ({
            debouncedSyncInlineCommentIndicators,
            syncInlineCommentIndicators: vi.fn(),
            pulseCommentIndicator: vi.fn(),
            resolveCommentFromIndicatorElement: vi.fn(() => null),
            findCommentFromInlineTarget: vi.fn(() => null),
        }),
        getHighlight: () => ({
            isPlacingComment: ref(false),
            placeCommentAtClientPoint: vi.fn(async () => true),
            findPageContainerFromClientPoint: vi.fn(() => null),
            buildAnnotationContextMenuPayload: vi.fn(() => cast<never>({})),
        }),
        scrollToPage: vi.fn(),
        renderVisiblePages: vi.fn(async () => {}),
        updateVisibleRange: vi.fn(),
        emitAnnotationModified,
        emitAnnotationOpenNote: vi.fn(),
        emitAnnotationCommentClick: vi.fn(),
        emitAnnotationContextMenu: vi.fn(),
        emitAnnotationToolCancel: vi.fn(),
    });

    return {
        crud,
        uiManager,
        pendingCommentEditorKeys,
        syncAnnotationComments,
        scheduleAnnotationCommentsSync,
        debouncedSyncInlineCommentIndicators,
        emitAnnotationModified,
        updateModeWithRetry,
        forgetSummaryText,
        rememberSummaryText,
        resolveCommentFromCache,
        callOrder,
    };
}

function FakeHtmlElement(this: unknown) {
    void this;
}

describe('useAnnotationCrud annotation comment interactions', () => {
    beforeAll(() => {
        vi.stubGlobal('HTMLElement', FakeHtmlElement);
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('returns false without side effects when ui manager is missing', async () => {
        const harness = await createHarness({ uiManagerNull: true });
        const result = await harness.crud.deleteAnnotationComment(createComment());

        expect(result).toBe(false);
        expect(harness.emitAnnotationModified).not.toHaveBeenCalled();
        expect(harness.scheduleAnnotationCommentsSync).not.toHaveBeenCalled();
        expect(harness.debouncedSyncInlineCommentIndicators).not.toHaveBeenCalled();
        expect(harness.forgetSummaryText).not.toHaveBeenCalled();
    });

    it('focuses a sidebar comment without opening editor comment controls', async () => {
        const editor = createFakeEditor();
        const harness = await createHarness({ editors: [editor] });

        await harness.crud.focusAnnotationComment(createComment());

        expect(editor.toggleComment).not.toHaveBeenCalled();
        expect(harness.uiManager?.selectComment).not.toHaveBeenCalled();
    });

    it('deletes a standalone editor-source comment via uiManager.delete', async () => {
        const editor = createFakeEditor({
            id: 'editor-1',
            uid: 'editor-1',
            comment: 'note text',
            parentPageIndex: 0,
        });
        const harness = await createHarness({ editors: [editor] });

        const result = await harness.crud.deleteAnnotationComment(createComment());

        expect(result).toBe(true);
        expect(harness.uiManager?.setSelected).toHaveBeenCalledWith(editor);
        expect(harness.uiManager?.delete).toHaveBeenCalledTimes(1);
        expect(editor.remove).not.toHaveBeenCalled();
        expect(editor.delete).not.toHaveBeenCalled();
    });

    it('fires emitAnnotationModified, schedules sync, and updates indicators on success', async () => {
        const editor = createFakeEditor({
            id: 'editor-1',
            uid: 'editor-1',
            parentPageIndex: 0,
        });
        const harness = await createHarness({ editors: [editor] });

        await harness.crud.deleteAnnotationComment(createComment());

        expect(harness.emitAnnotationModified).toHaveBeenCalledTimes(1);
        expect(harness.scheduleAnnotationCommentsSync).toHaveBeenCalledWith(true);
        expect(harness.debouncedSyncInlineCommentIndicators).toHaveBeenCalledTimes(1);
    });

    it('forgets summary text for both resolved and original comment after deletion', async () => {
        const editor = createFakeEditor({
            id: 'editor-1',
            uid: 'editor-1',
            parentPageIndex: 0,
        });
        const harness = await createHarness({ editors: [editor] });
        const comment = createComment();

        await harness.crud.deleteAnnotationComment(comment);

        expect(harness.forgetSummaryText).toHaveBeenCalledTimes(2);
    });

    it('removes pending editor key from sync set after successful deletion', async () => {
        const editor = createFakeEditor({
            id: 'editor-1',
            uid: 'editor-1',
            parentPageIndex: 0,
        });
        const harness = await createHarness({ editors: [editor] });

        expect(harness.pendingCommentEditorKeys.has('pending:editor-1')).toBe(true);

        await harness.crud.deleteAnnotationComment(createComment());

        expect(harness.pendingCommentEditorKeys.has('pending:editor-1')).toBe(false);
    });

    it('emits modified, schedule, indicator updates after the delete (not before)', async () => {
        const editor = createFakeEditor({
            id: 'editor-1',
            uid: 'editor-1',
            parentPageIndex: 0,
        });
        const harness = await createHarness({ editors: [editor] });

        await harness.crud.deleteAnnotationComment(createComment());

        const tail = harness.callOrder.slice(-3);
        expect(tail).toEqual([
            'emitAnnotationModified',
            'scheduleAnnotationCommentsSync',
            'debouncedSyncInlineCommentIndicators',
        ]);
    });

    it('falls back to editor.remove when uiManager.delete throws', async () => {
        const editor = createFakeEditor({
            id: 'editor-1',
            uid: 'editor-1',
            parentPageIndex: 0,
        });
        const harness = await createHarness({ editors: [editor] });
        harness.uiManager!.delete.mockImplementation(() => {
            throw new Error('boom');
        });

        const result = await harness.crud.deleteAnnotationComment(createComment());

        expect(result).toBe(true);
        expect(editor.remove).toHaveBeenCalledTimes(1);
        expect(editor.delete).not.toHaveBeenCalled();
        expect(harness.emitAnnotationModified).toHaveBeenCalledTimes(1);
    });

    it('falls back to legacy editor.delete when uiManager.delete and editor.remove both throw', async () => {
        const editor = createFakeEditor({
            id: 'editor-1',
            uid: 'editor-1',
            parentPageIndex: 0,
        });
        editor.remove.mockImplementation(() => {
            throw new Error('remove failed');
        });
        const harness = await createHarness({ editors: [editor] });
        harness.uiManager!.delete.mockImplementation(() => {
            throw new Error('uiManager failed');
        });

        const result = await harness.crud.deleteAnnotationComment(createComment());

        expect(result).toBe(true);
        expect(editor.delete).toHaveBeenCalledTimes(1);
    });

    it('returns false and emits no callbacks when no editor is resolvable', async () => {
        const harness = await createHarness({
            editors: [],
            cache: [],
            commentToReturnFromCache: null,
            uiManagerOpts: { omitSelectComment: true },
        });
        const orphan = createComment({
            id: 'missing-id',
            uid: 'missing-id',
            stableKey: 'editor:0:missing-id',
        });

        const result = await harness.crud.deleteAnnotationComment(orphan);

        expect(result).toBe(false);
        expect(harness.emitAnnotationModified).not.toHaveBeenCalled();
        expect(harness.scheduleAnnotationCommentsSync).not.toHaveBeenCalled();
        expect(harness.forgetSummaryText).not.toHaveBeenCalled();
    });

    it('deletes the only FreeText editor on the page when a transient note id is stale', async () => {
        const editor = createFakeEditor({
            id: 'actual-editor',
            uid: 'actual-editor',
            parentPageIndex: 0,
            _editorType: 1,
            comment: '',
        });
        const harness = await createHarness({
            editors: [editor],
            commentToReturnFromCache: null,
            uiManagerOpts: { omitSelectComment: true },
        });
        const staleNote = createComment({
            id: 'stale-note',
            uid: null,
            stableKey: 'src:editor:0:stale-note',
            text: '',
            subtype: 'FreeText',
            hasNote: true,
            markerRect: {
                left: 0.9,
                top: 0.9,
                width: 0.01,
                height: 0.01,
            },
        });

        const result = await harness.crud.deleteAnnotationComment(staleNote);

        expect(result).toBe(true);
        expect(harness.uiManager?.setSelected).toHaveBeenCalledWith(editor);
        expect(harness.uiManager?.delete).toHaveBeenCalledTimes(1);
        expect(harness.emitAnnotationModified).toHaveBeenCalledTimes(1);
    });

    it('does not throw when given an unknown id and leaves cache untouched', async () => {
        const harness = await createHarness({
            editors: [],
            cache: [],
            commentToReturnFromCache: null,
            uiManagerOpts: { omitSelectComment: true },
        });
        const unknown = createComment({
            id: 'never-existed',
            uid: 'never-existed',
            stableKey: 'editor:0:never-existed',
            text: '',
        });

        await expect(harness.crud.deleteAnnotationComment(unknown)).resolves.toBe(false);
    });

    it('does not throw when given an empty-id comment and does not mutate state', async () => {
        const harness = await createHarness({
            editors: [],
            cache: [],
            commentToReturnFromCache: null,
            uiManagerOpts: { omitSelectComment: true },
        });
        const empty = createComment({
            id: '',
            uid: null,
            stableKey: '',
            annotationId: null,
            text: '',
        });

        const result = await harness.crud.deleteAnnotationComment(empty);

        expect(result).toBe(false);
        expect(harness.pendingCommentEditorKeys.has('pending:editor-1')).toBe(true);
        expect(harness.emitAnnotationModified).not.toHaveBeenCalled();
    });

    it('switches to popup mode for pdf-source comments without an editor and restores previous mode', async () => {
        const harness = await createHarness({
            editors: [],
            commentToReturnFromCache: null,
            uiManagerOpts: { omitSelectComment: true },
        });
        const pdfComment = createComment({
            source: 'pdf',
            annotationId: 'pdf-anno-1',
            uid: null,
            id: 'pdf-anno-1',
            stableKey: 'pdf:0:pdf-anno-1',
        });

        await harness.crud.deleteAnnotationComment(pdfComment);

        const calls = harness.updateModeWithRetry.mock.calls as unknown[][];
        const switchCalls = calls.filter(call => call.length > 1 && call[1] === 5);
        const restoreCalls = calls.filter(call => call.length > 1 && call[1] === 0);
        expect(switchCalls.length).toBeGreaterThanOrEqual(1);
        expect(restoreCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('does not attempt popup mode switch for editor-source comments without annotationId', async () => {
        const harness = await createHarness({
            editors: [],
            commentToReturnFromCache: null,
            uiManagerOpts: { omitSelectComment: true },
        });
        const editorComment = createComment({
            source: 'editor',
            annotationId: null,
        });

        await harness.crud.deleteAnnotationComment(editorComment);

        expect(harness.updateModeWithRetry).not.toHaveBeenCalled();
    });

    it('triggers a sync refresh when editor not found on first lookup', async () => {
        const harness = await createHarness({
            editors: [],
            commentToReturnFromCache: null,
            uiManagerOpts: { omitSelectComment: true },
        });

        await harness.crud.deleteAnnotationComment(createComment());

        expect(harness.syncAnnotationComments).toHaveBeenCalledTimes(1);
    });

    it('uses uiManager.delete selection fallback when only selectComment matches', async () => {
        const harness = await createHarness({
            editors: [],
            commentToReturnFromCache: null,
        });
        harness.uiManager?.selectComment?.mockReturnValue(true);

        const result = await harness.crud.deleteAnnotationComment(createComment());

        expect(result).toBe(true);
        expect(harness.uiManager?.delete).toHaveBeenCalled();
        expect(harness.emitAnnotationModified).toHaveBeenCalledTimes(1);
    });

    it('updates an imported PDF note through annotationStorage editor lookup', async () => {
        const editor = createFakeEditor({
            id: 'internal-editor-1',
            uid: 'pdfjs_internal_editor_1',
            annotationElementId: '3856R',
            parentPageIndex: 0,
            comment: 'old text',
        });
        const harness = await createHarness({
            editors: [],
            annotationStorageGetEditor: (annotationElementId: string) => (
                annotationElementId === '3856R' ? editor : null
            ),
        });
        const pdfComment = createComment({
            id: '3856R',
            stableKey: 'ann:0:3856R',
            annotationId: '3856R',
            uid: null,
            source: 'pdf',
            subtype: 'FreeText',
            text: 'old text',
        });

        const result = harness.crud.updateAnnotationComment(pdfComment, 'new persisted note');

        expect(result).toBe(true);
        expect(editor.comment).toBe('new persisted note');
        expect(editor.addToAnnotationStorage).toHaveBeenCalledTimes(1);
        expect(harness.rememberSummaryText).toHaveBeenCalledWith(expect.objectContaining({
            stableKey: 'ann:0:3856R',
            annotationId: '3856R',
            text: 'new persisted note',
            hasNote: true,
        }));
        expect(harness.scheduleAnnotationCommentsSync).toHaveBeenCalledWith(true);
        expect(harness.emitAnnotationModified).toHaveBeenCalledTimes(1);
    });

    it('updates an imported PDF note through annotation element id lookup', async () => {
        const editor = createFakeEditor({
            id: 'unrelated-editor-id',
            uid: 'unrelated-uid',
            annotationElementId: '3856R',
            parentPageIndex: 0,
            comment: 'old text',
        });
        const harness = await createHarness({ editors: [editor] });
        const pdfComment = createComment({
            id: '3856R',
            stableKey: 'ann:0:3856R',
            annotationId: '3856R',
            uid: null,
            source: 'pdf',
            subtype: 'FreeText',
            text: 'old text',
        });

        const result = harness.crud.updateAnnotationComment(pdfComment, 'new persisted note');

        expect(result).toBe(true);
        expect(editor.comment).toBe('new persisted note');
        expect(editor.addToAnnotationStorage).toHaveBeenCalledTimes(1);
        expect(harness.scheduleAnnotationCommentsSync).toHaveBeenCalledWith(true);
    });
});
