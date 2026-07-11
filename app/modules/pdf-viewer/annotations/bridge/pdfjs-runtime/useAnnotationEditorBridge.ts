// Sole PDF.js editor lifecycle executor; application code consumes its port.
import {
    AnnotationEditorParamsType,
    PixelsPerInch,
} from '@app/services/pdfjs/runtimeLib';
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
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {
    IPdfjsEditor,
    IPdfjsEditorConstructorLike,
} from '@app/types/pdfjs';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { detectEditorSubtype } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/detectEditorSubtype';
import { getCommentText } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/getCommentText';
import { errorToLogText } from '@app/modules/pdf-viewer/engine/annotation-css-utils/errorToLogText';
import { toCssColor } from '@app/modules/pdf-viewer/engine/annotation-css-utils/toCssColor';
import { shouldIgnoreEditorEvent } from '@app/modules/pdf-viewer/engine/annotations/annotation-editor-event-guards/shouldIgnoreEditorEvent';
import {
    addUndoableEditorToLayer,
    asPdfjsEditor,
    clearSelectedEditorState,
    createPdfAnnotationEditorCompatibilityAdapter,
    createPdfjsEventBus,
    createPdfjsGenericL10n,
    createPdfjsUiManager,
    getEditorConstructor,
    getEditorsOnPage,
    getPdfjsEditorCompatibilityRuntime,
    getPdfjsEditorFacadeState,
    hasSelectedPdfjsEditor,
    interceptPdfjsDelete,
    interceptPdfjsRegisterEditorTypes,
    isPdfjsAppHistorySuppressed,
    PdfjsAnnotationFacade,
    setEditorDefaultParamUpdater,
    startPdfjsAnnotationManagerEditing,
    stopPdfjsAnnotationManagerEditing,
    unselectAllEditors,
} from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import {
    EventBus,
    GenericL10n,
} from '@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { parsePdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';
import {
    createEmptyPdfjsAnnotationEditorState,
    decodePdfjsAnnotationStatePatch,
} from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import type { IPdfjsAnnotationEditorState } from '@app/modules/pdf-viewer/runtime/annotations/pdfjsAnnotationState';
import { deriveAnnotationId } from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';

type TEditorParamType = Parameters<TAnnotationEditorUIManager['updateParams']>[0];
type TEditorParamValue = unknown;
type TUiManagerCommandParams = Parameters<TAnnotationEditorUIManager['addCommands']>[0] & {
    cmd?: unknown;
    undo?: unknown;
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
        toolToMarkupSubtype: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
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
    emitAnnotationState: (state: IPdfjsAnnotationEditorState) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    recordPdfjsExecutorCommand?: (command: {
        cmd: () => void;
        undo: () => void;
    }) => void;
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
        recordPdfjsExecutorCommand,
        isPdfjsHistoryRouted,
        routeAnnotationHistoryUndo,
        routeAnnotationHistoryRedo,
    } = deps;

    const annotationEventBus = shallowRef<TEventBus | null>(null);
    const annotationState = ref<IPdfjsAnnotationEditorState>(createEmptyPdfjsAnnotationEditorState());

    let annotationStateListener: ((event: unknown) => void) | null = null;
    let documentGeneration = 0;
    let managerGeneration = 0;
    let pageGeneration = 0;
    const pdfjsFacade = new PdfjsAnnotationFacade({
        get document() { return documentGeneration; },
        get manager() { return managerGeneration; },
        page: () => pageGeneration,
    });
    const unsubscribeFacadeModified = pdfjsFacade.subscribeModified(() => {
        emitAnnotationModified();
        getCommentSync().scheduleAnnotationCommentsSync();
        const manager = annotationUiManager.value;
        if (manager) getFreeTextResize().patchResizableFreeTextEditors(manager);
    });
    const annotationEditorCompatibilityAdapter = createPdfAnnotationEditorCompatibilityAdapter({
        failInDev: import.meta.dev,
        runtime: getPdfjsEditorCompatibilityRuntime(),
    });

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
            const editorState = getPdfjsEditorFacadeState(editor);
            const explicitResolvedPageIndex = Number.isFinite(editorState.resolvedPageIndex)
                ? (editorState.resolvedPageIndex as number)
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
                const editorState = getPdfjsEditorFacadeState(editor);
                const placementAttemptId = typeof editorState.placementAttemptId === 'string'
                    ? editorState.placementAttemptId
                    : null;
                if (parentPageIndex !== null && parentPageIndex !== pageIndex) {
                    BrowserLogger.diagnostic('note-placement', 'Editor bridge adjusted page index before opening note', {
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

    function resolveEditorByAnnotationId(annotationId: string) {
        const manager = annotationUiManager.value;
        if (!manager) {
            return null;
        }
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const candidate of getEditorsOnPage(manager, pageIndex)) {
                const candidateId = deriveAnnotationId(
                    'pdfjs-runtime',
                    getIdentity().getEditorIdentity(candidate, pageIndex),
                );
                if (candidateId === annotationId) {
                    return candidate;
                }
            }
        }
        return null;
    }

    function destroyAnnotationEditor() {
        documentGeneration += 1;
        managerGeneration += 1;
        pageGeneration += 1;
        pdfjsFacade.clear();
        const commentSync = getCommentSync();
        commentSync.incrementSyncToken();

        if (annotationEventBus.value && annotationStateListener) {
            annotationEventBus.value.off('annotationeditorstateschanged', annotationStateListener);
        }
        annotationStateListener = null;

        if (annotationUiManager.value) {
            stopPdfjsAnnotationManagerEditing(annotationUiManager.value);
        }
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
        documentGeneration += 1;
        managerGeneration += 1;
        pageGeneration += 1;

        const eventBus = createPdfjsEventBus(EventBus);
        annotationEventBus.value = eventBus;
        annotationL10n.value = createPdfjsGenericL10n(GenericL10n);
        annotationState.value = createEmptyPdfjsAnnotationEditorState();

        const commentManager = createSimpleCommentManager(container);

        const uiManager = annotationEditorCompatibilityAdapter.wrapUiManager(createPdfjsUiManager({
            container,
            viewer: container,
            commentManager,
            eventBus,
            document: pdfDoc,
            highlightColors: DEFAULT_PDFJS_HIGHLIGHT_COLORS,
        }));
        annotationUiManager.value = uiManager;

        const markupSubtype = getMarkupSubtype();
        const freeTextResize = getFreeTextResize();
        const commentSync = getCommentSync();
        const toolManager = getToolManager();

        interceptPdfjsRegisterEditorTypes(
            uiManager,
            (types) => {
                captureRegisteredEditorTypes(types);
                toolManager.captureHighlightEditorClassFromTypes(types);
            },
        );
        setEditorDefaultParamUpdater(
            uiManager,
            (type, value) => updateDefaultParamsForAllEditorTypes(
                uiManager,
                type,
                toEditorParamValue(value),
            ),
        );

        pdfjsFacade.interceptManagerMethod<[
            TEditorParamType,
            TEditorParamValue,
        ], unknown>(uiManager, 'updateParams', (originalUpdateParams, [
            type,
            value,
        ]) => {
            const hasSelection = hasSelectedPdfjsEditor(uiManager);
            const incomingValue: unknown = value;
            let resolvedValue: TEditorParamValue;
            if (
                type === AnnotationEditorParamsType.HIGHLIGHT_FREE
                && markupSubtype.shouldForceTextMarkup(annotationTool.value)
            ) {
                resolvedValue = toEditorParamValue(false);
            } else {
                resolvedValue = toEditorParamValue(incomingValue);
            }
            const result = originalUpdateParams(type, resolvedValue);
            if (hasSelection
                && type !== AnnotationEditorParamsType.CREATE
                && type !== AnnotationEditorParamsType.HIGHLIGHT_SHOW_ALL) {
                updateDefaultParamsForAllEditorTypes(uiManager, type, resolvedValue);
            }
            return result;
        });

        pdfjsFacade.interceptManagerMethod<[KeyboardEvent], unknown>(uiManager, 'keydown', (originalKeydown, [event]) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            return originalKeydown(event);
        });

        pdfjsFacade.interceptManagerMethod<[KeyboardEvent], unknown>(uiManager, 'keyup', (originalKeyup, [event]) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            return originalKeyup(event);
        });

        pdfjsFacade.interceptManagerMethod<[ClipboardEvent], unknown>(uiManager, 'copy', (originalCopy, [event]) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            return originalCopy(event);
        });

        pdfjsFacade.interceptManagerMethod<[ClipboardEvent], unknown>(uiManager, 'cut', (originalCut, [event]) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            return originalCut(event);
        });

        pdfjsFacade.interceptManagerMethod<[ClipboardEvent], unknown>(uiManager, 'paste', (originalPaste, [event]) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            return originalPaste(event);
        });

        pdfjsFacade.interceptManagerMethod<[unknown], unknown>(uiManager, 'addToAnnotationStorage', (originalAddToAnnotationStorage, [editor]) => {
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
            const createdEditor = asPdfjsEditor(editor);
            toolManager.enforceHighlightDefaultsForNewEditor(createdEditor);
            const editorSubtype = createdEditor
                ? detectEditorSubtype(createdEditor)
                : null;
            if (editorObject && !commentSync.trackedCreatedEditors.has(editorObject)) {
                commentSync.trackedCreatedEditors.add(editorObject);
                if (editorSubtype !== 'Stamp') {
                    toolManager.maybeAutoResetAnnotationTool();
                }
            }
            const leasePageIndex = Number.isFinite(createdEditor?.parentPageIndex)
                ? (createdEditor?.parentPageIndex as number)
                : Math.max(0, currentPage.value - 1);
            const lease = createdEditor
                ? pdfjsFacade.bindEditor(
                    createdEditor,
                    deriveAnnotationId('pdfjs-runtime', getIdentity().getEditorIdentity(createdEditor, leasePageIndex)),
                    getIdentity().getEditorIdentity(createdEditor, leasePageIndex),
                    leasePageIndex,
                )
                : null;
            scheduleCreatedEditorPostProcessing(() => {
                const resolvedLease = lease
                    ? pdfjsFacade.withEditor(
                        lease,
                        leasePageIndex,
                        (editorKey) => {
                            const manager = annotationUiManager.value;
                            return manager
                                ? getEditorsOnPage(manager, leasePageIndex).find(candidate => (
                                    getIdentity().getEditorIdentity(candidate, leasePageIndex) === editorKey
                                )) ?? null
                                : null;
                        },
                        candidate => asPdfjsEditor(candidate),
                    )
                    : {status: 'stale' as const};
                const normalizedEditor = resolvedLease.status === 'ok' ? resolvedLease.value : null;
                if (normalizedEditor) {
                    freeTextResize.ensureFreeTextEditorCanResize(normalizedEditor);
                    const pageIndex = Number.isFinite(normalizedEditor.parentPageIndex)
                        ? (normalizedEditor.parentPageIndex as number)
                        : Math.max(0, currentPage.value - 1);
                    const resolvedEditorSubtype = editorSubtype ?? detectEditorSubtype(normalizedEditor);
                    let knownSubtype = markupSubtype.resolveEditorMarkupSubtypeOverride(normalizedEditor, pageIndex);
                    knownSubtype ??= markupSubtype.resolveEditorSubtypeFromPresentation(normalizedEditor);
                    const toolSubtype = markupSubtype.toolToMarkupSubtype[annotationTool.value] ?? null;
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
                        && !getPdfjsEditorFacadeState(normalizedEditor).creationHistoryRegistered
                    ) {
                        // Toolbar-created text markup can reach storage without a PDF.js undo
                        // command, so install one app-authoritative executor entry once.
                        const annotationId = deriveAnnotationId(
                            'pdfjs-runtime',
                            getIdentity().getEditorIdentity(normalizedEditor, pageIndex),
                        );
                        const undoRegistered = addUndoableEditorToLayer(uiManager, normalizedEditor, {
                            skipAppHistory: true,
                            resolveEditor: () => resolveEditorByAnnotationId(annotationId),
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
                            getPdfjsEditorFacadeState(normalizedEditor).creationHistoryRegistered = true;
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
        });

        pdfjsFacade.interceptManagerMethod<[TUiManagerCommandParams], unknown>(uiManager, 'addCommands', (originalAddCommands, [params]) => {
            emitAnnotationModified();
            const result = originalAddCommands(params);
            if (
                !isPdfjsAppHistorySuppressed(params)
                && !isPdfjsHistoryRouted?.()
                && typeof params.cmd === 'function'
                && typeof params.undo === 'function'
            ) {
                recordPdfjsExecutorCommand?.({
                    cmd: params.cmd as () => void,
                    undo: params.undo as () => void,
                });
            }
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        });

        interceptPdfjsDelete(
            uiManager,
            () => {
                emitAnnotationModified();
                commentSync.scheduleAnnotationCommentsSync();
            },
        );

        pdfjsFacade.interceptManagerMethod<[unknown], unknown>(uiManager, 'setSelected', (originalSetSelected, [editor]) => {
            const result = originalSetSelected(editor);
            const normalizedEditor = asPdfjsEditor(editor);
            if (normalizedEditor) {
                freeTextResize.ensureFreeTextEditorCanResize(normalizedEditor);
            }
            return result;
        });

        pdfjsFacade.interceptManagerMethod<[], unknown>(uiManager, 'undo', (originalUndo) => {
            if (!isPdfjsHistoryRouted?.()) {
                routeAnnotationHistoryUndo?.();
                return undefined;
            }
            const result = originalUndo();
            emitAnnotationModified();
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        });

        pdfjsFacade.interceptManagerMethod<[], unknown>(uiManager, 'redo', (originalRedo) => {
            if (!isPdfjsHistoryRouted?.()) {
                routeAnnotationHistoryRedo?.();
                return undefined;
            }
            const result = originalRedo();
            emitAnnotationModified();
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        });

        annotationStateListener = (event) => {
            const details = event && typeof event === 'object' && !Array.isArray(event)
                ? (event as Record<string, unknown>).details
                : undefined;
            const patch = decodePdfjsAnnotationStatePatch(details);
            if (!patch) {
                return;
            }
            annotationState.value = {
                ...annotationState.value,
                ...patch,
            };
            emitAnnotationState(annotationState.value);
        };
        eventBus.on('annotationeditorstateschanged', annotationStateListener);

        try {
            if (!pdfjsFacade.subscribeDocumentModified(pdfDoc, () => pdfjsFacade.notifyModified())) {
                throw new Error('PDF.js annotation storage is unavailable');
            }
        } catch (error) {
            BrowserLogger.warn('annotations', 'Failed to attach annotation modified handler', error);
        }

        startPdfjsAnnotationManagerEditing(uiManager);
        uiManager.onScaleChanging({ scale: effectiveScale.value / PixelsPerInch.PDF_TO_CSS_UNITS });
        uiManager.onPageChanging({ pageNumber: currentPage.value });

        toolManager.applyAnnotationSettings(toolManager.pendingAnnotationSettings.value);
        runGuardedTask(
            () => toolManager.setAnnotationTool(toolManager.pendingAnnotationTool.value),
            {
                category: 'user-visible-operation',
                scope: 'annotations',
                message: 'Failed to restore pending annotation tool',
            },
        );
        emitAnnotationState(annotationState.value);
        commentSync.scheduleAnnotationCommentsSync(true);
    }

    tryOnScopeDispose(() => {
        destroyAnnotationEditor();
        unsubscribeFacadeModified();
    });

    return {
        annotationEventBus,
        annotationUiManager,
        annotationL10n,
        annotationState,
        pdfjsFacade,
        initAnnotationEditor,
        destroyAnnotationEditor,
    };
};
