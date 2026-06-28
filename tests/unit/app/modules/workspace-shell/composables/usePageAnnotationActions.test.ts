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
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import { usePageAnnotationActions } from '@app/modules/workspace-shell/composables/usePageAnnotationActions';

const { resolveAnnotationCommentTextMarkupColor } = vi.hoisted(() => ({resolveAnnotationCommentTextMarkupColor: vi.fn(() => null as string | null)}));

vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/resolveAnnotationCommentTextMarkupColor', () => ({resolveAnnotationCommentTextMarkupColor}));

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

function createPdfFreeTextComment(
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
        ...createComment('ann:504:12R0'),
        source: 'pdf',
        annotationId: '12R',
        subtype: 'FreeText',
        hasNote: true,
        text: 'note text',
        pageIndex: 504,
        pageNumber: 505,
        ...overrides,
    };
}

function createEditorOpenNote(
    baseComment: IAnnotationCommentSummary,
    overrides: Partial<IAnnotationCommentSummary> = {},
): IAnnotationCommentSummary {
    return {
        ...baseComment,
        stableKey: 'uid:504:open-note',
        id: 'open-note',
        source: 'editor',
        annotationId: null,
        uid: 'open-note',
        ...overrides,
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

function installSplitImagePickerPlatform(imagePath: string, options: { cleanupError?: Error } = {}) {
    const legacyDocuments = {
        openImageDialog: vi.fn(() => Promise.reject(new Error('legacy image dialog should not be used'))),
        readFile: vi.fn(() => Promise.reject(new Error('legacy image read should not be used'))),
        cleanupFile: vi.fn(() => Promise.reject(new Error('legacy image cleanup should not be used'))),
    };
    const imageBytes = Uint8Array.from([
        1,
        2,
        3,
    ]);
    const cleanupFile = vi.fn(() => (
        options.cleanupError
            ? Promise.reject(options.cleanupError)
            : Promise.resolve()
    ));
    const documentPicker = { openImageDialog: vi.fn(() => Promise.resolve(imagePath)) };
    const documentFiles = { readFile: vi.fn(() => Promise.resolve(imageBytes)) };
    const documentWorkingCopy = { cleanupFile };

    vi.stubGlobal('window', {
        ...globalThis,
        electronAPI: {
            documentFiles,
            documentPicker,
            documentWorkingCopy,
            documents: legacyDocuments,
        },
    });

    return {
        documentFiles,
        documentPicker,
        documentWorkingCopy,
        legacyDocuments,
    };
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
        invalidatePages: vi.fn(),
        updateAnnotationComment: vi.fn(() => true),
        deleteAnnotationComment: vi.fn(async (_comment: IAnnotationCommentSummary) => true),
        registerAnnotationHistoryCommand: vi.fn(),
        suppressAnnotationId: vi.fn(),
        suppressAnnotationStableKey: vi.fn(),
        unsuppressAnnotationId: vi.fn(),
        unsuppressAnnotationStableKey: vi.fn(),
        removeAnnotationFromDom: vi.fn(),
        removeAnnotationFromInternalCache: vi.fn(),
        updateSelectedTextMarkupAnnotationColor: vi.fn(() => true),
        updateTextMarkupAnnotationColor: vi.fn(() => true),
        selectedShapeId: null as string | null,
        updateShape: vi.fn(),
        getSelectedShape: vi.fn(() => selectedShape.value),
        deleteSelectedShape: vi.fn(),
        saveDocument: vi.fn(async () => new Uint8Array([
            9,
            9,
        ])),
        startImagePlacement: vi.fn(async (
            _file?: File,
            _placement?: {
                pageNumber?: number | null;
                pageX?: number | null;
                pageY?: number | null;
            },
        ) => true),
        clearPendingImagePlacement: vi.fn(),
        restorePendingImagePlacement: vi.fn(),
        restoreAnnotationToInternalCache: vi.fn(),
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
        annotationNoteWindows: ref<Array<{
            comment: IAnnotationCommentSummary;
            text?: string | undefined;
            createdAtMs?: number | undefined;
        }>>([]),
        loadPdfFromData: vi.fn(async (_data: Uint8Array, _opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        }) => {}),
        waitForPdfReload: vi.fn(async (_page: number) => {}),
        invalidateThumbnailPages: vi.fn(),
        removeAnnotationFromCache: vi.fn(),
        restoreAnnotationToCache: vi.fn(),
        queuePendingEmbeddedAnnotationDelete: vi.fn(),
        unqueuePendingEmbeddedAnnotationDelete: vi.fn(),
        isNativeFreeTextNoteSaved: vi.fn(() => false),
        markPreservedAnnotationSourceDirty: vi.fn(),
        setPreservedAnnotationSourceDirty: vi.fn(),
        getAnnotationCommentsSnapshot: vi.fn((): IAnnotationCommentSummary[] => []),
        getAnnotationCommentsStatusSnapshot: vi.fn((): TAnnotationCommentsStatus => 'loading'),
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
    resolveAnnotationCommentTextMarkupColor.mockReset();
    resolveAnnotationCommentTextMarkupColor.mockReturnValue(null);
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
    it('keeps a newly opened editor note in the sidebar cache before text is entered', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment('new-editor-note');
            comment.source = 'editor';
            comment.subtype = 'FreeText';
            comment.hasNote = true;
            comment.text = '\u200B';

            actions.handleOpenAnnotationNote(comment);

            const expected = expect.objectContaining({
                stableKey: 'new-editor-note',
                createdAt: new Date('2026-05-26T12:00:00Z').getTime(),
            });
            expect(deps.restoreAnnotationToCache).toHaveBeenCalledWith(expected);
            expect(viewer.restoreAnnotationToInternalCache).toHaveBeenCalledWith(expected);
            expect(deps.openAnnotationNoteWindow).toHaveBeenCalledWith(expected);
            expect(deps.annotationActiveCommentStableKey.value).toBe('new-editor-note');
        } finally {
            vi.useRealTimers();
        }
    });

    it('registers a fresh editor note as its own undoable annotation command', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment('fresh-editor-note');
            comment.source = 'editor';
            comment.subtype = 'FreeText';
            comment.hasNote = true;
            comment.text = '\u200B\uFEFF ';

            actions.handleOpenAnnotationNote(comment);
            const noteComment = deps.openAnnotationNoteWindow.mock.calls[0]?.[0];
            deps.annotationNoteWindows.value = [{ comment: noteComment! }];
            vi.runOnlyPendingTimers();

            expect(noteComment).toEqual(expect.objectContaining({
                stableKey: 'fresh-editor-note',
                createdAt: new Date('2026-05-26T12:00:00Z').getTime(),
            }));
            const command = viewer.registerAnnotationHistoryCommand.mock.calls[0]?.[0];
            expect(command).toBeDefined();

            command!.undo();

            expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith('fresh-editor-note');
            expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(noteComment);
            expect(viewer.removeAnnotationFromInternalCache).toHaveBeenCalledWith('fresh-editor-note');
            expect(deps.removeAnnotationFromCache).toHaveBeenCalledWith('fresh-editor-note');
            expect(deps.invalidateThumbnailPages).toHaveBeenCalledWith([1]);

            command!.cmd();

            expect(deps.restoreAnnotationToCache).toHaveBeenLastCalledWith(noteComment);
            expect(viewer.restoreAnnotationToInternalCache).toHaveBeenLastCalledWith(noteComment);
            expect(deps.openAnnotationNoteWindow).toHaveBeenLastCalledWith(noteComment);
            expect(deps.annotationActiveCommentStableKey.value).toBe('fresh-editor-note');
        } finally {
            vi.useRealTimers();
        }
    });

    it('registers fresh note undo after the open note identity is synchronized', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment('src:editor:0:transient-note');
            comment.source = 'editor';
            comment.id = 'transient-note';
            comment.subtype = 'FreeText';
            comment.hasNote = true;
            comment.text = '\u200B';
            comment.markerRect = {
                left: 0.25,
                top: 0.35,
                width: 0.01,
                height: 0.01,
            };

            actions.handleOpenAnnotationNote(comment);
            const noteComment = deps.openAnnotationNoteWindow.mock.calls[0]?.[0] as IAnnotationCommentSummary;
            deps.annotationNoteWindows.value = [{ comment: {
                ...noteComment,
                id: 'actual-editor',
                uid: 'actual-editor',
                stableKey: 'uid:0:actual-editor',
            } }];
            vi.runOnlyPendingTimers();

            expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('redoes a fresh editor note with the latest saved note text and identity', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment('src:editor:0:transient-note');
            comment.source = 'editor';
            comment.id = 'transient-note';
            comment.subtype = 'FreeText';
            comment.hasNote = true;
            comment.text = '\u200B';
            comment.markerRect = {
                left: 0.25,
                top: 0.35,
                width: 0.01,
                height: 0.01,
            };

            actions.handleOpenAnnotationNote(comment);
            const openedComment = deps.openAnnotationNoteWindow.mock.calls[0]?.[0] as IAnnotationCommentSummary;
            const savedComment: IAnnotationCommentSummary = {
                ...openedComment,
                id: 'actual-editor',
                uid: 'actual-editor',
                stableKey: 'uid:0:actual-editor',
                text: 'Saved note text',
                modifiedAt: Date.now() + 1_000,
            };
            deps.annotationNoteWindows.value = [{
                comment: savedComment,
                text: 'Saved note text',
            }];
            vi.runOnlyPendingTimers();

            const command = viewer.registerAnnotationHistoryCommand.mock.calls[0]?.[0];
            expect(command).toBeDefined();

            command!.undo();

            expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(savedComment);
            expect(viewer.removeAnnotationFromInternalCache).toHaveBeenCalledWith('uid:0:actual-editor');
            expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith('uid:0:actual-editor');

            command!.cmd();

            expect(deps.restoreAnnotationToCache).toHaveBeenLastCalledWith(savedComment);
            expect(viewer.restoreAnnotationToInternalCache).toHaveBeenLastCalledWith(savedComment);
            expect(deps.openAnnotationNoteWindow).toHaveBeenLastCalledWith(savedComment);
            expect(deps.annotationActiveCommentStableKey.value).toBe('uid:0:actual-editor');
        } finally {
            vi.useRealTimers();
        }
    });

    it('undoes the latest fresh empty editor note directly', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
        try {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const highlight = createComment('highlight');
            highlight.source = 'editor';
            highlight.subtype = 'Highlight';
            const note = createComment('fresh-note');
            note.source = 'editor';
            note.subtype = 'FreeText';
            note.hasNote = true;
            note.text = '\u200B';
            note.createdAt = Date.now();
            deps.annotationNoteWindows.value = [
                { comment: highlight },
                { comment: note },
            ];

            const undone = await actions.undoLatestFreshAnnotationNoteCreation();

            expect(undone).toBe(true);
            expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(note);
            expect(viewer.deleteAnnotationComment).not.toHaveBeenCalledWith(highlight);
            expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith('fresh-note');
            expect(deps.removeAnnotationFromCache).toHaveBeenCalledWith('fresh-note');
        } finally {
            vi.useRealTimers();
        }
    });

    it('can undo an empty editor note before PDF.js reports a creation timestamp', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const note = createComment('untimestamped-note');
        note.source = 'editor';
        note.subtype = 'FreeText';
        note.hasNote = true;
        note.text = '\u200B';
        note.createdAt = null;
        note.modifiedAt = null;
        deps.annotationNoteWindows.value = [{ comment: note }];

        const undone = await actions.undoLatestFreshAnnotationNoteCreation();

        expect(undone).toBe(true);
        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(note);
    });

    it('starts quick note placement without creating a selection-based note', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();

        deps.showSidebar.value = true;
        deps.sidebarTab.value = 'bookmarks';

        await actions.handleQuickNoteAction();

        expect(viewer.commentSelection).not.toHaveBeenCalled();
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

    it.each([
        {
            settingsKey: 'highlightColor',
            subtype: 'Highlight',
        },
        {
            settingsKey: 'underlineColor',
            subtype: 'Underline',
        },
        {
            settingsKey: 'strikethroughColor',
            subtype: 'StrikeOut',
        },
        {
            settingsKey: 'squigglyColor',
            subtype: 'Squiggly',
        },
    ] as const)(
        'updates %s materialized context menu color without reloading and records history',
        async ({
            settingsKey,
            subtype,
        }) => {
            const {
                deps,
                viewer,
                actions,
            } = createHarness();
            const comment = createComment(`context-color-${subtype}`);
            comment.subtype = subtype;
            comment.color = '#22c55e';
            deps.annotationContextMenu.value.comment = comment;

            actions.handleContextTextMarkupColorUpdate('#ef4444');

            expect(viewer.updateTextMarkupAnnotationColor).toHaveBeenCalledWith(
                expect.objectContaining({
                    stableKey: comment.stableKey,
                    color: '#22c55e',
                    colorEdited: true,
                }),
                '#ef4444',
            );
            expect(deps.annotationContextMenu.value.comment?.color).toBe('#ef4444');
            expect(deps.annotationContextMenu.value.comment?.colorEdited).toBe(true);
            expect(deps.annotationSettings.value[settingsKey]).toBe('#ef4444');
            expect(deps.restoreAnnotationToCache).toHaveBeenCalledWith(expect.objectContaining({
                stableKey: comment.stableKey,
                color: '#ef4444',
                colorEdited: true,
            }));
            expect(viewer.restoreAnnotationToInternalCache).toHaveBeenCalledWith(expect.objectContaining({
                stableKey: comment.stableKey,
                color: '#ef4444',
                colorEdited: true,
            }));
            expect(deps.loadPdfFromData).not.toHaveBeenCalled();
            expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledOnce();
            const historyCommand = viewer.registerAnnotationHistoryCommand.mock.calls[0]?.[0];
            historyCommand?.undo();
            expect(viewer.updateTextMarkupAnnotationColor).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    stableKey: comment.stableKey,
                    color: '#ef4444',
                    colorEdited: false,
                }),
                '#22c55e',
            );
            expect(deps.restoreAnnotationToCache).toHaveBeenLastCalledWith(expect.objectContaining({
                stableKey: comment.stableKey,
                color: '#22c55e',
                colorEdited: false,
            }));
            historyCommand?.cmd();
            expect(viewer.updateTextMarkupAnnotationColor).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    stableKey: comment.stableKey,
                    color: '#22c55e',
                }),
                '#ef4444',
            );
            expect(deps.setPreservedAnnotationSourceDirty).toHaveBeenCalledWith(true);
            expect(deps.setPreservedAnnotationSourceDirty).toHaveBeenCalledWith(false);
        },
    );

    it('uses rendered materialized color as undo baseline when the cached comment has no color', () => {
        const {
            deps,
            viewer,
            viewerContainer,
            actions,
        } = createHarness();
        viewerContainer.value = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            querySelector: vi.fn(() => null),
        };
        resolveAnnotationCommentTextMarkupColor.mockReturnValue('#ef4444');
        const comment = createComment('context-color-rendered-baseline');
        comment.subtype = 'Highlight';
        comment.color = null;
        deps.annotationContextMenu.value.comment = comment;

        actions.handleContextTextMarkupColorUpdate('#22c55e');

        expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledOnce();
        const historyCommand = viewer.registerAnnotationHistoryCommand.mock.calls[0]?.[0];
        historyCommand?.undo();
        expect(viewer.updateTextMarkupAnnotationColor).toHaveBeenLastCalledWith(
            expect.objectContaining({
                stableKey: comment.stableKey,
                color: '#22c55e',
                colorEdited: false,
            }),
            '#ef4444',
        );
        expect(deps.setPreservedAnnotationSourceDirty).toHaveBeenLastCalledWith(false);
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
    });

    it('keeps rapid materialized text markup color updates latest-wins without reload', () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('context-color-rapid');
        comment.subtype = 'Underline';
        comment.color = '#dc2626';
        viewer.updateTextMarkupAnnotationColor.mockReturnValue(false);
        deps.annotationContextMenu.value.comment = comment;

        actions.handleContextTextMarkupColorUpdate('#22c55e');
        deps.annotationContextMenu.value.comment = {
            ...comment,
            color: '#22c55e',
            colorEdited: true,
        };
        actions.handleContextTextMarkupColorUpdate('#2563eb');

        expect(deps.annotationContextMenu.value.comment?.color).toBe('#2563eb');
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledTimes(2);
    });

    it('closes the context menu when free note placement fails', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.annotationContextMenu.value.pageNumber = 1;
        deps.annotationContextMenu.value.pageX = 0.25;
        deps.annotationContextMenu.value.pageY = 0.5;
        viewer.commentAtPoint.mockRejectedValueOnce(new Error('stale editor'));

        await actions.createContextMenuFreeNote();

        expect(viewer.commentAtPoint).toHaveBeenCalledWith(
            1,
            0.25,
            0.5,
            { preferTextAnchor: false },
        );
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
    });

    it('starts an image placement session from file without switching annotation tools', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const {
            documentFiles,
            documentPicker,
            documentWorkingCopy,
            legacyDocuments,
        } = installSplitImagePickerPlatform('/tmp/test.png');

        await actions.insertImageFromFileAt(2, 0.25, 0.5);

        expect(deps.handleAnnotationToolChange).not.toHaveBeenCalledWith('stamp');
        expect(deps.annotationTool.value).toBe('highlight');
        expect(viewer.startImagePlacement).toHaveBeenCalledOnce();
        const placedFile = viewer.startImagePlacement.mock.calls[0]?.[0] as File;
        expect(placedFile.name).toBe('test.png');
        expect(placedFile.type).toBe('image/png');
        expect(Array.from(new Uint8Array(await placedFile.arrayBuffer()))).toEqual([
            1,
            2,
            3,
        ]);
        expect(viewer.startImagePlacement).toHaveBeenCalledWith(
            expect.any(File),
            {
                pageNumber: 2,
                pageX: 0.25,
                pageY: 0.5,
            },
        );
        expect(documentPicker.openImageDialog).toHaveBeenCalledOnce();
        expect(documentFiles.readFile).toHaveBeenCalledWith('/tmp/test.png');
        expect(documentWorkingCopy.cleanupFile).not.toHaveBeenCalled();
        expect(legacyDocuments.openImageDialog).not.toHaveBeenCalled();
        expect(legacyDocuments.readFile).not.toHaveBeenCalled();
        expect(legacyDocuments.cleanupFile).not.toHaveBeenCalled();
    });

    it('cleans up browser image refs through the split working-copy capability', async () => {
        const {
            viewer,
            actions,
        } = createHarness();
        const imagePath = 'browser://documents/image-picker/test.webp';
        const {
            documentFiles,
            documentPicker,
            documentWorkingCopy,
            legacyDocuments,
        } = installSplitImagePickerPlatform(imagePath, { cleanupError: new Error('cleanup failed') });

        await expect(actions.insertImageFromFileAt(2, 0.25, 0.5)).resolves.toBeUndefined();

        expect(viewer.startImagePlacement).toHaveBeenCalledOnce();
        const placedFile = viewer.startImagePlacement.mock.calls[0]?.[0] as File;
        expect(placedFile.name).toBe('test.webp');
        expect(placedFile.type).toBe('image/webp');
        expect(documentPicker.openImageDialog).toHaveBeenCalledOnce();
        expect(documentFiles.readFile).toHaveBeenCalledWith(imagePath);
        expect(documentWorkingCopy.cleanupFile).toHaveBeenCalledWith(imagePath);
        expect(legacyDocuments.openImageDialog).not.toHaveBeenCalled();
        expect(legacyDocuments.readFile).not.toHaveBeenCalled();
        expect(legacyDocuments.cleanupFile).not.toHaveBeenCalled();
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
        expect(viewer.clearPendingImagePlacement).toHaveBeenCalledOnce();
        expect(viewer.saveDocument).not.toHaveBeenCalled();
    });

    it('clears pending image placement when finalization resolves after the working copy changes', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        deps.embedPlacedImageToPage.mockImplementationOnce(async () => {
            deps.workingCopyPath.value = '/tmp/other.pdf';
            return new Uint8Array([
                7,
                7,
            ]);
        });

        const finalized = await actions.handleFinalizePlacedImage({
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

        expect(finalized).toBe(false);
        expect(viewer.clearPendingImagePlacement).toHaveBeenCalledOnce();
        expect(viewer.restorePendingImagePlacement).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
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
        commentA.source = 'editor';
        commentB.source = 'editor';
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

    it('ignores duplicate delete requests for the same annotation while the first is pending', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('rapid-delete-note');
        comment.source = 'editor';
        deps.annotationNoteWindows.value = [{ comment }];
        const gate = deferred<boolean>();
        viewer.deleteAnnotationComment.mockImplementation(async () => gate.promise);

        const deleteA = actions.handleDeleteAnnotationComment(comment);
        const deleteB = actions.handleDeleteAnnotationComment(comment);

        await waitForCondition(() => viewer.deleteAnnotationComment.mock.calls.length === 1);
        gate.resolve(true);
        await Promise.all([
            deleteA,
            deleteB,
        ]);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledTimes(1);
        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith(comment.stableKey);
    });

    it('uses the embedded delete path directly for PDF-backed highlights', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('editor-backed-highlight');
        comment.source = 'editor';
        comment.annotationId = '12R';
        comment.subtype = 'Highlight';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).not.toHaveBeenCalled();
        expect(viewer.suppressAnnotationStableKey).toHaveBeenCalledWith(comment.stableKey);
        expect(viewer.suppressAnnotationId).toHaveBeenCalledWith('12R');
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(comment);
        expect(viewer.removeAnnotationFromInternalCache).toHaveBeenCalledWith(comment.stableKey);
        expect(deps.removeAnnotationFromCache).toHaveBeenCalledWith(comment.stableKey);
        expect(deps.invalidateThumbnailPages).toHaveBeenCalledWith([1]);
        expect(deps.queuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(comment);
        expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledOnce();
    });

    it('closes remaining note windows when an explicit delete drains the annotation cache', async () => {
        const {
            deps,
            actions,
        } = createHarness();
        const comment = createPdfFreeTextComment({
            text: 'orphan note text',
            markerRect: {
                left: 0.1,
                top: 0.1,
                width: 0.01,
                height: 0.01,
            },
        });
        const openNote = createEditorOpenNote(comment, {markerRect: {
            left: 0.8,
            top: 0.8,
            width: 0.01,
            height: 0.01,
        }});
        let comments = [comment];
        deps.getAnnotationCommentsSnapshot.mockImplementation(() => comments);
        deps.removeAnnotationFromCache.mockImplementation((stableKey: string) => {
            comments = comments.filter(candidate => candidate.stableKey !== stableKey);
        });
        deps.annotationNoteWindows.value = [{ comment: openNote }];
        deps.annotationActiveCommentStableKey.value = openNote.stableKey;

        await actions.handleDeleteAnnotationComment(comment);

        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith(openNote.stableKey);
        expect(deps.removeAnnotationFromCache).toHaveBeenCalledWith(openNote.stableKey);
        expect(deps.annotationActiveCommentStableKey.value).toBeNull();
    });

    it('closes a stale note window when a fast delete sees an already-empty ready cache', async () => {
        const {
            deps,
            actions,
        } = createHarness();
        const comment = createPdfFreeTextComment({ text: 'stale note text' });
        const openNote = createEditorOpenNote(comment);
        deps.getAnnotationCommentsSnapshot.mockReturnValue([]);
        deps.getAnnotationCommentsStatusSnapshot.mockReturnValue('ready');
        deps.annotationNoteWindows.value = [{ comment: openNote }];

        await actions.handleDeleteAnnotationComment(comment);

        expect(deps.removeAnnotationNoteWindow).toHaveBeenCalledWith(openNote.stableKey);
        expect(deps.removeAnnotationFromCache).toHaveBeenCalledWith(openNote.stableKey);
    });

    it('keeps unmatched note windows through an explicit delete during a loading sync gap', async () => {
        const {
            deps,
            actions,
        } = createHarness();
        const comment = createPdfFreeTextComment();
        const openNote = createEditorOpenNote(comment);
        deps.getAnnotationCommentsSnapshot.mockReturnValue([]);
        deps.getAnnotationCommentsStatusSnapshot.mockReturnValue('loading');
        deps.annotationNoteWindows.value = [{ comment: openNote }];

        await actions.handleDeleteAnnotationComment(comment);

        expect(deps.removeAnnotationNoteWindow).not.toHaveBeenCalledWith(openNote.stableKey);
        expect(deps.removeAnnotationFromCache).not.toHaveBeenCalledWith(openNote.stableKey);
    });

    it('resolves embedded refs from stable keys before suppressing and queueing deletes', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('ann:0:12R0');
        comment.source = 'editor';
        comment.annotationId = null;
        comment.subtype = 'Highlight';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).not.toHaveBeenCalled();
        expect(viewer.suppressAnnotationStableKey).toHaveBeenCalledWith(comment.stableKey);
        expect(viewer.suppressAnnotationId).toHaveBeenCalledWith('12R');
        expect(deps.queuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(expect.objectContaining({
            stableKey: comment.stableKey,
            annotationId: '12R',
        }));
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(expect.objectContaining({ annotationId: '12R' }));
    });

    it('lets PDF.js own newly-created editor highlight deletes', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('new-editor-highlight');
        comment.source = 'editor';
        comment.annotationId = 'pdfjs_internal_editor_12';
        comment.subtype = 'Highlight';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.suppressAnnotationStableKey).not.toHaveBeenCalled();
        expect(viewer.suppressAnnotationId).not.toHaveBeenCalled();
        expect(deps.queuePendingEmbeddedAnnotationDelete).not.toHaveBeenCalled();
    });

    it('queues native stable-key deletes for saved editor FreeText notes after viewer delete', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('uid:0:pdfjs_internal_editor_0');
        comment.source = 'editor';
        comment.annotationId = 'pdfjs_internal_editor_0';
        comment.uid = 'pdfjs_internal_editor_0';
        comment.subtype = 'Typewriter';
        comment.hasNote = true;
        comment.markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        };
        deps.isNativeFreeTextNoteSaved.mockReturnValue(true);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.suppressAnnotationStableKey).toHaveBeenCalledWith(comment.stableKey);
        expect(deps.queuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(comment);
        expect(viewer.removeAnnotationFromInternalCache).toHaveBeenCalledWith(comment.stableKey);
    });

    it('lets PDF.js own unsaved editor FreeText deletes', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('uid:0:pdfjs_internal_editor_0');
        comment.source = 'editor';
        comment.annotationId = 'pdfjs_internal_editor_0';
        comment.uid = 'pdfjs_internal_editor_0';
        comment.subtype = 'Typewriter';
        comment.hasNote = true;
        comment.markerRect = {
            left: 0.1,
            top: 0.2,
            width: 0.0016,
            height: 0.0016,
        };

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.suppressAnnotationStableKey).not.toHaveBeenCalled();
        expect(deps.queuePendingEmbeddedAnnotationDelete).not.toHaveBeenCalled();
    });

    it('lets the viewer own shape annotation deletes even when they have embedded refs', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('shape:0:evb-shape:embedded-rect');
        comment.source = 'shape';
        comment.annotationId = '12R';
        comment.subtype = 'Square';

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.suppressAnnotationStableKey).not.toHaveBeenCalled();
        expect(viewer.suppressAnnotationId).not.toHaveBeenCalled();
        expect(deps.queuePendingEmbeddedAnnotationDelete).not.toHaveBeenCalled();
    });

    it('does not invent an embedded delete when a runtime editor highlight cannot be deleted by PDF.js', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('new-editor-highlight-failed-delete');
        comment.source = 'editor';
        comment.annotationId = 'pdfjs_internal_editor_12';
        comment.subtype = 'Highlight';
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.deleteAnnotationComment).toHaveBeenCalledWith(comment);
        expect(viewer.suppressAnnotationStableKey).not.toHaveBeenCalled();
        expect(viewer.suppressAnnotationId).not.toHaveBeenCalled();
        expect(deps.queuePendingEmbeddedAnnotationDelete).not.toHaveBeenCalled();
        expect(deps.setAnnotationNoteWindowError).toHaveBeenCalledWith(
            comment.stableKey,
            'errors.annotation.delete',
        );
    });

    it('registers undo for deferred embedded deletes', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('undoable-delete');
        comment.annotationId = '12R';
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        const command = viewer.registerAnnotationHistoryCommand.mock.calls[0]?.[0];
        expect(command).toBeDefined();

        command.undo();

        expect(deps.unqueuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(comment.stableKey);
        expect(viewer.unsuppressAnnotationStableKey).toHaveBeenCalledWith(comment.stableKey);
        expect(viewer.unsuppressAnnotationId).toHaveBeenCalledWith('12R');
        expect(deps.restoreAnnotationToCache).toHaveBeenCalledWith(comment);
        expect(viewer.invalidatePages).toHaveBeenCalledWith([comment.pageNumber]);
        expect(deps.invalidateThumbnailPages).toHaveBeenCalledWith([comment.pageNumber]);
    });

    it('defers embedded stamp deletes and refreshes the hidden annotation page without reloading', async () => {
        const {
            deps,
            viewer,
            actions,
        } = createHarness();
        const comment = createComment('stamp-delete');
        comment.source = 'editor';
        comment.annotationId = '12R';
        comment.subtype = 'Stamp';
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.saveDocument).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(deps.waitForPdfReload).not.toHaveBeenCalled();
        expect(deps.getEmbeddedMutationBaseData).not.toHaveBeenCalled();
        expect(viewer.suppressAnnotationStableKey).toHaveBeenCalledWith(comment.stableKey);
        expect(viewer.suppressAnnotationId).toHaveBeenCalledWith('12R');
        expect(viewer.removeAnnotationFromDom).toHaveBeenCalledWith(comment);
        expect(deps.queuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(comment);
        expect(viewer.registerAnnotationHistoryCommand).toHaveBeenCalledOnce();
    });

    it('does not serialize planned embedded mutation bytes before embedded stamp delete save', async () => {
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
        comment.annotationId = '12R';
        comment.subtype = 'Stamp';
        viewer.deleteAnnotationComment.mockResolvedValue(false);

        await actions.handleDeleteAnnotationComment(comment);

        expect(viewer.saveDocument).not.toHaveBeenCalled();
        expect(deps.getEmbeddedMutationBaseData).not.toHaveBeenCalled();
        expect(deps.loadPdfFromData).not.toHaveBeenCalled();
        expect(deps.queuePendingEmbeddedAnnotationDelete).toHaveBeenCalledWith(comment);
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
