import {
    AnnotationEditorParamsType,
    AnnotationEditorUIManager,
    PixelsPerInch,
} from '@app/services/pdfjs/runtimeLib';
import {
    EventBus,
    GenericL10n,
} from '@app/services/pdfjs/viewerRuntimeLib';
import type { AnnotationEditorUIManager as TAnnotationEditorUIManager } from 'pdfjs-dist';
import type { EventBus as TEventBus } from 'pdfjs-dist/types/web/event_utils';
import type { GenericL10n as TGenericL10n } from 'pdfjs-dist/types/web/genericl10n';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfjsEditor,
    IPdfjsEditorConstructorLike,
} from '@app/types/pdfjs';
import type { PDFDocumentProxy } from '@app/types/pdf';
import {
    getCommentText,
    detectEditorSubtype,
} from '@app/composables/pdf/pdfAnnotationEditorUtils';
import {
    toCssColor,
    errorToLogText,
} from '@app/composables/pdf/annotationCssUtils';
import { shouldIgnoreEditorEvent } from '@app/composables/pdf/annotations/annotationEditorEventGuards';
import {
    addUndoableEditorToLayer,
    asPdfjsEditor,
    clearSelectedEditorState,
    getEditorConstructor,
    getEditorsOnPage,
    setEditorDefaultParamUpdater,
    unselectAllEditors,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';

type TEditorParamType = Parameters<TAnnotationEditorUIManager['updateParams']>[0];
type TEditorParamValue = Parameters<TAnnotationEditorUIManager['updateParams']>[1];
type TUiManagerCommandParams = Parameters<TAnnotationEditorUIManager['addCommands']>[0] & {
    __evbSkipAppHistory?: unknown;
    type?: unknown;
    overwriteIfSameType?: unknown;
};

function toEditorParamValue(value: unknown): TEditorParamValue {
    return value;
}

const DEFAULT_PDFJS_HIGHLIGHT_COLORS =
    'yellow=#FFFF98,green=#98FF98,blue=#98C0FF,pink=#FF98FF,red=#FF9090';

interface IEditorBridgeDeps {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    annotationUiManager: ShallowRef<TAnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<TGenericL10n | null>;
    getIdentity: () => {
        getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
        hydrateSummaryFromMemory: (s: IAnnotationCommentSummary) => IAnnotationCommentSummary;
    };
    getCommentSync: () => {
        toEditorSummary: (editor: IPdfjsEditor, pageIndex: number, text: string) => IAnnotationCommentSummary;
        setActiveCommentStableKey: (key: string | null) => void;
        scheduleAnnotationCommentsSync: (immediate?: boolean) => void;
        incrementSyncToken: () => void;
        clearSyncState: () => void;
        trackedCreatedEditors: WeakSet<object>;
    };
    getToolManager: () => {
        pendingAnnotationTool: Ref<TAnnotationTool>;
        pendingAnnotationSettings: Ref<IAnnotationSettings | null>;
        applyAnnotationSettings: (settings: IAnnotationSettings | null) => void;
        setAnnotationTool: (tool: TAnnotationTool) => Promise<void>;
        maybeAutoResetAnnotationTool: () => void;
        captureHighlightEditorClassFromTypes: (types: readonly unknown[]) => void;
        enforceHighlightDefaultsForNewEditor: (editor: IPdfjsEditor | null | undefined) => void;
    };
    getMarkupSubtype: () => {
        TOOL_TO_MARKUP_SUBTYPE: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
        shouldForceTextMarkup: (tool: TAnnotationTool) => boolean;
        applyHighlightParamsForTool: (mgr: TAnnotationEditorUIManager, s: IAnnotationSettings, t: TAnnotationTool) => void;
        resolveEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number) => TMarkupSubtype | null;
        resolveEditorSubtypeFromPresentation: (e: IPdfjsEditor) => TMarkupSubtype | null;
        setEditorMarkupSubtypeOverride: (
            e: IPdfjsEditor,
            pi: number,
            s: TMarkupSubtype,
            opts?: { preferEditorColor?: boolean },
        ) => void;
        clearMarkupSubtypeEditorClass: (e: IPdfjsEditor) => void;
        applyEditorMarkupSubtypePresentation: (e: IPdfjsEditor, s: TMarkupSubtype | null) => void;
        syncMarkupSubtypePresentationForEditors: () => void;
        clearOverrides: () => void;
    };
    getFreeTextResize: () => {
        ensureFreeTextEditorCanResize: (editor: IPdfjsEditor) => void;
        patchResizableFreeTextEditors: (mgr: TAnnotationEditorUIManager) => void;
    };
    emitAnnotationModified: () => void;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    recordPdfjsHistoryCommand?: (params: {
        type?: number;
        overwriteIfSameType?: boolean;
    }) => void;
    recordPdfjsHistoryClean?: (type: number) => void;
    recordPdfjsHistoryUndo?: () => void;
    recordPdfjsHistoryRedo?: () => void;
    discardPdfjsHistory?: () => void;
    isPdfjsHistoryRouted?: () => boolean;
    routeAnnotationHistoryUndo?: () => boolean;
    routeAnnotationHistoryRedo?: () => boolean;
}

export const useAnnotationEditorBridge = (deps: IEditorBridgeDeps) => {
    const {
        viewerContainer,
        pdfDocument,
        numPages,
        currentPage,
        effectiveScale,
        annotationTool,
        annotationUiManager,
        annotationL10n,
        getIdentity,
        getCommentSync,
        getToolManager,
        getMarkupSubtype,
        getFreeTextResize,
        emitAnnotationModified,
        emitAnnotationState,
        emitAnnotationOpenNote,
        recordPdfjsHistoryCommand,
        recordPdfjsHistoryClean,
        recordPdfjsHistoryUndo,
        recordPdfjsHistoryRedo,
        discardPdfjsHistory,
        isPdfjsHistoryRouted,
        routeAnnotationHistoryUndo,
        routeAnnotationHistoryRedo,
    } = deps;

    const annotationEventBus = shallowRef<TEventBus | null>(null);
    const annotationState = ref<IAnnotationEditorState>({
        isEditing: false,
        isEmpty: true,
        hasSomethingToUndo: false,
        hasSomethingToRedo: false,
        hasSelectedEditor: false,
    });

    let annotationStateListener:
        | ((event: { details?: Partial<IAnnotationEditorState> }) => void)
        | null = null;
    let annotationStorageModifiedHandler: (() => void) | null = null;

    function scheduleCreatedEditorPostProcessing(task: () => void) {
        if (typeof window === 'undefined') {
            task();
            return;
        }

        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                try {
                    task();
                } catch (error) {
                    BrowserLogger.warn(
                        'annotations',
                        `Failed to finalize created annotation editor: ${errorToLogText(error)}`,
                    );
                }
            });
        });
    }

    function createSimpleCommentManager(_container: HTMLElement) {
        const dialogElement = document.createElement('div');
        dialogElement.className = 'pdf-annotation-comment-dialog-placeholder';
        dialogElement.setAttribute('aria-hidden', 'true');
        dialogElement.style.display = 'none';

        function resolveEditorPageIndex(editor: IPdfjsEditor) {
            const explicitResolvedPageIndex = Number.isFinite(editor.__evbResolvedPageIndex)
                ? (editor.__evbResolvedPageIndex as number)
                : null;
            if (
                explicitResolvedPageIndex !== null
                && explicitResolvedPageIndex >= 0
                && explicitResolvedPageIndex < Math.max(1, numPages.value)
            ) {
                return explicitResolvedPageIndex;
            }

            const pageFromDom = (() => {
                const pageContainer = editor.div?.closest<HTMLElement>('.page_container');
                const pageNumber = pageContainer?.dataset.page
                    ? Number(pageContainer.dataset.page)
                    : Number.NaN;
                if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
                    return null;
                }
                return pageNumber - 1;
            })();
            if (pageFromDom !== null) {
                return pageFromDom;
            }

            const parentPageIndex = Number.isFinite(editor.parentPageIndex)
                ? (editor.parentPageIndex as number)
                : null;
            if (parentPageIndex !== null) {
                return parentPageIndex;
            }

            return currentPage.value - 1;
        }

        return {
            dialogElement,
            setSidebarUiManager: (_uiManager: TAnnotationEditorUIManager) => {},
            destroyPopup: () => {},
            showSidebar: () => {},
            hideSidebar: () => {},
            showDialog: (_uiManager: unknown, editor: IPdfjsEditor) => {
                try {
                    unselectAllEditors(annotationUiManager.value);
                } catch { /* ignore */ }

                const identity = getIdentity();
                const commentSync = getCommentSync();
                const pageIndex = resolveEditorPageIndex(editor);
                const summary = identity.hydrateSummaryFromMemory(
                    commentSync.toEditorSummary(
                        editor,
                        pageIndex,
                        getCommentText(editor),
                    ),
                );
                const parentPageIndex = Number.isFinite(editor.parentPageIndex)
                    ? (editor.parentPageIndex as number)
                    : null;
                const placementAttemptId = typeof editor.__evbPlacementAttemptId === 'string'
                    ? editor.__evbPlacementAttemptId
                    : null;
                if (parentPageIndex !== null && parentPageIndex !== pageIndex) {
                    BrowserLogger.warn('note-placement', 'Editor bridge adjusted page index before opening note', {
                        attemptId: placementAttemptId,
                        editorUid: editor.uid ?? null,
                        annotationId: editor.annotationElementId ?? null,
                        parentPageIndex,
                        resolvedPageIndex: pageIndex,
                        resolvedPageNumber: pageIndex + 1,
                        currentPage: currentPage.value,
                    });
                }
                commentSync.setActiveCommentStableKey(summary.stableKey);
                emitAnnotationOpenNote(summary);
            },
            updateComment: () => {
                getCommentSync().scheduleAnnotationCommentsSync();
            },
            updatePopupColor: () => {},
            removeComments: () => {
                getCommentSync().scheduleAnnotationCommentsSync();
            },
            toggleCommentPopup: () => {},
            makeCommentColor: (
                color: string | number[] | {
                    r: number;
                    g: number;
                    b: number 
                } | null,
                opacity = 1,
            ) => toCssColor(color, opacity),
            destroy: () => {
                dialogElement.remove();
            },
        };
    }

    const registeredEditorTypes = new Set<IPdfjsEditorConstructorLike>();

    function captureRegisteredEditorTypes(types: readonly unknown[]) {
        for (const type of types) {
            if (
                (typeof type === 'function' || typeof type === 'object')
                && type !== null
                && typeof (type as IPdfjsEditorConstructorLike).updateDefaultParams === 'function'
            ) {
                registeredEditorTypes.add(type);
            }
        }
    }

    function updateDefaultParamsForAllEditorTypes(
        uiManager: TAnnotationEditorUIManager,
        type: TEditorParamType,
        value: TEditorParamValue,
    ) {
        const constructors = new Set<IPdfjsEditorConstructorLike>(registeredEditorTypes);
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of getEditorsOnPage(uiManager, pageIndex)) {
                const ctor = getEditorConstructor(editor);
                if (ctor) {
                    constructors.add(ctor);
                }
            }
        }
        let didUpdate = false;
        constructors.forEach((ctor) => {
            try {
                ctor.updateDefaultParams?.(type, value);
                didUpdate = true;
            } catch (error) {
                BrowserLogger.debug('annotations', `Failed to sync editor default params: ${errorToLogText(error)}`);
            }
        });
        return didUpdate;
    }

    function shouldInferMarkupSubtypeFromActiveTool(
        editor: IPdfjsEditor,
        editorSubtype: string | null,
        toolSubtype: TMarkupSubtype | null,
    ) {
        return Boolean(
            toolSubtype
            && editorSubtype === 'Highlight'
            && !parsePdfJsAnnotationRef(editor.annotationElementId),
        );
    }

    function destroyAnnotationEditor() {
        const commentSync = getCommentSync();
        commentSync.incrementSyncToken();

        try {
            const pdfDoc = pdfDocument.value;
            if (
                pdfDoc?.annotationStorage
                && annotationStorageModifiedHandler
                && pdfDoc.annotationStorage.onSetModified === annotationStorageModifiedHandler
            ) {
                // Clear our callback so previous document/editor instances do not
                // retain bridge closures after teardown.
                pdfDoc.annotationStorage.onSetModified = undefined;
            }
        } catch {
            // Best-effort teardown.
        }
        annotationStorageModifiedHandler = null;

        if (annotationEventBus.value && annotationStateListener) {
            annotationEventBus.value.off('annotationeditorstateschanged', annotationStateListener);
        }
        annotationStateListener = null;

        annotationUiManager.value?.removeEditListeners();
        annotationUiManager.value?.destroy();
        annotationUiManager.value = null;
        annotationEventBus.value = null;
        annotationL10n.value = null;

        commentSync.clearSyncState();
    }

    function initAnnotationEditor() {
        const container = viewerContainer.value;
        const pdfDoc = pdfDocument.value;
        if (!container || !pdfDoc) {
            return;
        }

        destroyAnnotationEditor();
        discardPdfjsHistory?.();

        const eventBus = new EventBus();
        annotationEventBus.value = eventBus;
        annotationL10n.value = new GenericL10n(undefined);
        annotationState.value = {
            isEditing: false,
            isEmpty: true,
            hasSomethingToUndo: false,
            hasSomethingToRedo: false,
            hasSelectedEditor: false,
        };

        const commentManager = createSimpleCommentManager(container);

        const uiManager = new AnnotationEditorUIManager(
            container, container, null, null, commentManager, null,
            eventBus, pdfDoc, null,
            DEFAULT_PDFJS_HIGHLIGHT_COLORS, false, false, false, null, null, false,
        );
        annotationUiManager.value = uiManager;

        const markupSubtype = getMarkupSubtype();
        const freeTextResize = getFreeTextResize();
        const commentSync = getCommentSync();
        const toolManager = getToolManager();

        const uiManagerWithRegister = uiManager as TAnnotationEditorUIManager
            & { registerEditorTypes?: (types: readonly unknown[]) => void };
        if (typeof uiManagerWithRegister.registerEditorTypes === 'function') {
            const originalRegisterEditorTypes = uiManagerWithRegister.registerEditorTypes.bind(uiManager);
            uiManagerWithRegister.registerEditorTypes = (types: readonly unknown[]) => {
                captureRegisteredEditorTypes(types);
                toolManager.captureHighlightEditorClassFromTypes(types);
                return originalRegisterEditorTypes(types);
            };
        }
        setEditorDefaultParamUpdater(
            uiManager,
            (type, value) => updateDefaultParamsForAllEditorTypes(
                uiManager,
                type,
                toEditorParamValue(value),
            ),
        );

        const originalUpdateParams = uiManager.updateParams.bind(uiManager);
        uiManager.updateParams = (type, value) => {
            const hasSelection = 'hasSelection' in uiManager
                ? Boolean((uiManager as { hasSelection?: boolean }).hasSelection)
                : false;
            const incomingValue: unknown = value;
            let resolvedValue: TEditorParamValue;
            if (
                type === AnnotationEditorParamsType.HIGHLIGHT_FREE
                && markupSubtype.shouldForceTextMarkup(annotationTool.value)
            ) {
                // pdfjs-dist leaves updateParams values untyped, so this boundary cannot be stronger locally.
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                resolvedValue = toEditorParamValue(false);
            } else {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                resolvedValue = toEditorParamValue(incomingValue);
            }
            const result = originalUpdateParams(type, resolvedValue);
            if (hasSelection
                && type !== AnnotationEditorParamsType.CREATE
                && type !== AnnotationEditorParamsType.HIGHLIGHT_SHOW_ALL) {
                updateDefaultParamsForAllEditorTypes(uiManager, type, resolvedValue);
            }
            return result;
        };

        const originalKeydown = uiManager.keydown.bind(uiManager);
        uiManager.keydown = (event: KeyboardEvent) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            originalKeydown(event);
        };

        const originalKeyup = uiManager.keyup.bind(uiManager);
        uiManager.keyup = (event: KeyboardEvent) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            originalKeyup(event);
        };

        const originalCopy = uiManager.copy.bind(uiManager);
        uiManager.copy = (event: ClipboardEvent) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            originalCopy(event);
        };

        const originalCut = uiManager.cut.bind(uiManager);
        uiManager.cut = (event: ClipboardEvent) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            originalCut(event);
        };

        const originalPaste = uiManager.paste.bind(uiManager);
        uiManager.paste = async (event: ClipboardEvent) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            await originalPaste(event);
        };

        const originalAddToAnnotationStorage = uiManager.addToAnnotationStorage.bind(uiManager);
        uiManager.addToAnnotationStorage = (editor) => {
            const normalizedEditorBeforeStorage = asPdfjsEditor(editor);
            const shouldClearSelectionAfterCreate = (
                detectEditorSubtype(normalizedEditorBeforeStorage) === 'Ink'
                && normalizedEditorBeforeStorage?.annotationElementId == null
            );
            // PDF.js assigns annotationElementId during storage insertion, so
            // capture "new editor" before delegating to its original method.
            const isNewStorageEditor = normalizedEditorBeforeStorage?.annotationElementId == null;
            const result = originalAddToAnnotationStorage(editor);
            const editorObject = editor as object | null;
            const normalizedEditor = asPdfjsEditor(editor);
            toolManager.enforceHighlightDefaultsForNewEditor(normalizedEditor);
            const editorSubtype = normalizedEditor
                ? detectEditorSubtype(normalizedEditor)
                : null;
            if (editorObject && !commentSync.trackedCreatedEditors.has(editorObject)) {
                commentSync.trackedCreatedEditors.add(editorObject);
                if (editorSubtype !== 'Stamp') {
                    toolManager.maybeAutoResetAnnotationTool();
                }
            }
            scheduleCreatedEditorPostProcessing(() => {
                if (normalizedEditor) {
                    freeTextResize.ensureFreeTextEditorCanResize(normalizedEditor);
                    const pageIndex = Number.isFinite(normalizedEditor.parentPageIndex)
                        ? (normalizedEditor.parentPageIndex as number)
                        : Math.max(0, currentPage.value - 1);
                    const resolvedEditorSubtype = editorSubtype ?? detectEditorSubtype(normalizedEditor);
                    let knownSubtype = markupSubtype.resolveEditorMarkupSubtypeOverride(normalizedEditor, pageIndex);
                    if (!knownSubtype) {
                        knownSubtype = markupSubtype.resolveEditorSubtypeFromPresentation(normalizedEditor);
                    }
                    const toolSubtype = markupSubtype.TOOL_TO_MARKUP_SUBTYPE[annotationTool.value] ?? null;
                    if (!knownSubtype && toolSubtype && shouldInferMarkupSubtypeFromActiveTool(normalizedEditor, resolvedEditorSubtype, toolSubtype)) {
                        // The active tool is authoritative for underline/strike/squiggly creation;
                        // do not preserve PDF.js' generic highlight-yellow default here.
                        markupSubtype.setEditorMarkupSubtypeOverride(
                            normalizedEditor,
                            pageIndex,
                            toolSubtype,
                            { preferEditorColor: false },
                        );
                        knownSubtype = toolSubtype;
                    }
                    if (knownSubtype) {
                        markupSubtype.applyEditorMarkupSubtypePresentation(normalizedEditor, knownSubtype);
                    }
                    if (
                        resolvedEditorSubtype === 'Highlight'
                        && isNewStorageEditor
                        && !normalizedEditor.__evbCreationHistoryRegistered
                    ) {
                        // Toolbar-created text markup can reach storage without a PDF.js undo
                        // command, so install one and mirror it into the app stack once.
                        const undoRegistered = addUndoableEditorToLayer(uiManager, normalizedEditor, {
                            skipAppHistory: true,
                            // Our subtype SVGs are drawLayer-owned, not editor DOM children.
                            beforeUndo: editorForUndo => markupSubtype.clearMarkupSubtypeEditorClass(editorForUndo),
                            afterRedo: (editorForRedo) => {
                                const subtypeForRedo = markupSubtype.resolveEditorMarkupSubtypeOverride(editorForRedo, pageIndex)
                                    ?? knownSubtype
                                    ?? markupSubtype.resolveEditorSubtypeFromPresentation(editorForRedo);
                                if (subtypeForRedo) {
                                    markupSubtype.applyEditorMarkupSubtypePresentation(editorForRedo, subtypeForRedo);
                                }
                            },
                        });
                        if (undoRegistered) {
                            normalizedEditor.__evbCreationHistoryRegistered = true;
                            if (!isPdfjsHistoryRouted?.()) {
                                // If PDF.js already announced this creation, keep the toolbar at
                                // one undo step for the single user action.
                                recordPdfjsHistoryCommand?.({ overwriteIfSameType: true });
                            }
                            annotationState.value = {
                                ...annotationState.value,
                                isEmpty: false,
                            };
                            emitAnnotationState(annotationState.value);
                        }
                    }
                }
                if (shouldClearSelectionAfterCreate) {
                    // Newly committed ink strokes remain selected in PDF.js, so later
                    // default style changes would rewrite the last stroke instead of
                    // only affecting future drawings. When the app has already
                    // auto-reset back to selection mode, keep the new stroke
                    // selected so its focus frame remains visible.
                    if (annotationTool.value === 'draw') {
                        clearSelectedEditorState(uiManager);
                    }
                }
                emitAnnotationModified();
                commentSync.scheduleAnnotationCommentsSync();
            });
            return result;
        };

        const originalAddCommands = uiManager.addCommands.bind(uiManager);
        uiManager.addCommands = (params) => {
            emitAnnotationModified();
            const result = originalAddCommands(params);
            const commandParams = params as TUiManagerCommandParams;
            const historyParams: {
                type?: number;
                overwriteIfSameType?: boolean;
            } = { overwriteIfSameType: commandParams.overwriteIfSameType === true };
            if (typeof commandParams.type === 'number') {
                historyParams.type = commandParams.type;
            }
            if (!commandParams.__evbSkipAppHistory && !isPdfjsHistoryRouted?.()) {
                // Commands installed manually above are mirrored after coalescing.
                recordPdfjsHistoryCommand?.(historyParams);
            }
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        };

        const uiManagerWithCleanUndoStack = uiManager as TAnnotationEditorUIManager & { cleanUndoStack?: (type: number) => unknown };
        if (typeof uiManagerWithCleanUndoStack.cleanUndoStack === 'function') {
            const originalCleanUndoStack = uiManagerWithCleanUndoStack.cleanUndoStack.bind(uiManager);
            uiManagerWithCleanUndoStack.cleanUndoStack = (type) => {
                const result = originalCleanUndoStack(type);
                if (typeof type === 'number') {
                    recordPdfjsHistoryClean?.(type);
                }
                return result;
            };
        }

        const uiManagerWithDelete = uiManager as TAnnotationEditorUIManager & { delete?: () => unknown };
        if (typeof uiManagerWithDelete.delete === 'function') {
            const originalDelete = uiManagerWithDelete.delete.bind(uiManager);
            uiManagerWithDelete.delete = () => {
                const result = originalDelete();
                emitAnnotationModified();
                commentSync.scheduleAnnotationCommentsSync();
                return result;
            };
        }

        const originalSetSelected = uiManager.setSelected.bind(uiManager);
        uiManager.setSelected = (editor) => {
            const result = originalSetSelected(editor);
            const normalizedEditor = asPdfjsEditor(editor);
            if (normalizedEditor) {
                freeTextResize.ensureFreeTextEditorCanResize(normalizedEditor);
            }
            return result;
        };

        const originalUndo = uiManager.undo.bind(uiManager);
        uiManager.undo = () => {
            if (!isPdfjsHistoryRouted?.() && routeAnnotationHistoryUndo?.()) {
                return;
            }
            const result = originalUndo();
            if (!isPdfjsHistoryRouted?.()) {
                recordPdfjsHistoryUndo?.();
            }
            emitAnnotationModified();
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        };

        const originalRedo = uiManager.redo.bind(uiManager);
        uiManager.redo = () => {
            if (!isPdfjsHistoryRouted?.() && routeAnnotationHistoryRedo?.()) {
                return;
            }
            const result = originalRedo();
            if (!isPdfjsHistoryRouted?.()) {
                recordPdfjsHistoryRedo?.();
            }
            emitAnnotationModified();
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        };

        annotationStateListener = (event) => {
            if (!event?.details) {
                return;
            }
            annotationState.value = {
                ...annotationState.value,
                ...event.details,
            };
            emitAnnotationState(annotationState.value);
        };
        eventBus.on('annotationeditorstateschanged', annotationStateListener);

        try {
            annotationStorageModifiedHandler = () => {
                emitAnnotationModified();
                commentSync.scheduleAnnotationCommentsSync();
                freeTextResize.patchResizableFreeTextEditors(uiManager);
            };
            pdfDoc.annotationStorage.onSetModified = annotationStorageModifiedHandler;
        } catch (error) {
            annotationStorageModifiedHandler = null;
            BrowserLogger.warn('annotations', 'Failed to attach annotation modified handler', error);
        }

        uiManager.addEditListeners();
        uiManager.onScaleChanging({ scale: effectiveScale.value / PixelsPerInch.PDF_TO_CSS_UNITS });
        uiManager.onPageChanging({ pageNumber: currentPage.value });

        toolManager.applyAnnotationSettings(toolManager.pendingAnnotationSettings.value);
        runGuardedTask(
            () => toolManager.setAnnotationTool(toolManager.pendingAnnotationTool.value),
            {
                scope: 'annotations',
                message: 'Failed to restore pending annotation tool', 
            },
        );
        emitAnnotationState(annotationState.value);
        commentSync.scheduleAnnotationCommentsSync(true);
    }

    tryOnScopeDispose(() => {
        destroyAnnotationEditor();
    });

    return {
        annotationEventBus,
        annotationUiManager,
        annotationL10n,
        annotationState,
        initAnnotationEditor,
        destroyAnnotationEditor,
    };
};
