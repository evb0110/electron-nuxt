import {
    AnnotationEditorParamsType,
    AnnotationEditorUIManager,
    PixelsPerInch,
} from 'pdfjs-dist';
import {
    EventBus,
    GenericL10n,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import {
    ref,
    shallowRef,
    type Ref,
    type ShallowRef,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IAnnotationCommentSummary,
    IAnnotationEditorState,
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
    IPdfjsEditor,
} from '@app/composables/pdf/annotations/types';
import type { PDFDocumentProxy } from '@app/types/pdf';
import {
    getCommentText,
    toCssColor,
    detectEditorSubtype,
    errorToLogText,
} from '@app/composables/pdf/pdfAnnotationUtils';
import { unselectAllEditors } from '@app/services/pdfjs/annotationEditorAdapter';
import { BrowserLogger } from '@app/utils/browser-logger';
import { runGuardedTask } from '@app/utils/async-guard';

type TEditorParamType = Parameters<AnnotationEditorUIManager['updateParams']>[0];
type TEditorParamValue = Parameters<AnnotationEditorUIManager['updateParams']>[1];

interface IPdfjsEditorConstructor {updateDefaultParams?: (type: TEditorParamType, value: TEditorParamValue) => void;}

const DEFAULT_PDFJS_HIGHLIGHT_COLORS =
    'yellow=#FFFF98,green=#98FF98,blue=#98C0FF,pink=#FF98FF,red=#FF9090';

interface IEditorBridgeDeps {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationL10n: ShallowRef<GenericL10n | null>;
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
    };
    getMarkupSubtype: () => {
        TOOL_TO_MARKUP_SUBTYPE: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
        shouldForceTextMarkup: (tool: TAnnotationTool) => boolean;
        applyHighlightParamsForTool: (mgr: AnnotationEditorUIManager, s: IAnnotationSettings, t: TAnnotationTool) => void;
        resolveEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number) => TMarkupSubtype | null;
        resolveEditorSubtypeFromPresentation: (e: IPdfjsEditor) => TMarkupSubtype | null;
        setEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number, s: TMarkupSubtype) => void;
        applyEditorMarkupSubtypePresentation: (e: IPdfjsEditor, s: TMarkupSubtype | null) => void;
        syncMarkupSubtypePresentationForEditors: () => void;
        clearOverrides: () => void;
    };
    getFreeTextResize: () => {
        ensureFreeTextEditorCanResize: (editor: IPdfjsEditor) => void;
        patchResizableFreeTextEditors: (mgr: AnnotationEditorUIManager) => void;
    };
    emitAnnotationModified: () => void;
    emitAnnotationState: (state: IAnnotationEditorState) => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
}

export function useAnnotationEditorBridge(deps: IEditorBridgeDeps) {
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
    } = deps;

    const annotationEventBus = shallowRef<EventBus | null>(null);
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

    function shouldIgnoreEditorEvent(event: Event) {
        const target = event.target;
        if (!(target instanceof HTMLElement)) {
            const selection = document.getSelection();
            if (selection && !selection.isCollapsed) {
                const anchorParent = selection.anchorNode?.parentElement ?? null;
                const focusParent = selection.focusNode?.parentElement ?? null;
                if (
                    anchorParent?.closest('.text-layer, .textLayer')
                    || focusParent?.closest('.text-layer, .textLayer')
                ) {
                    return true;
                }
            }
            return false;
        }
        if (target.closest('.text-layer, .textLayer')) {
            return true;
        }
        if (target.isContentEditable) {
            return true;
        }
        const tagName = target.tagName;
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
            return true;
        }
        if (target.closest('.pdf-annotation-comment-popup, #commentPopup, #commentManagerDialog')) {
            return true;
        }
        if (target.closest('[contenteditable="true"], [contenteditable=""]')) {
            return true;
        }
        return false;
    }

    function createSimpleCommentManager(_container: HTMLElement) {
        const dialogElement = document.createElement('div');
        dialogElement.className = 'pdf-annotation-comment-dialog-placeholder';
        dialogElement.setAttribute('aria-hidden', 'true');
        dialogElement.style.display = 'none';

        return {
            dialogElement,
            setSidebarUiManager: (_uiManager: AnnotationEditorUIManager) => {},
            destroyPopup: () => {},
            showSidebar: () => {},
            hideSidebar: () => {},
            showDialog: (_uiManager: unknown, editor: IPdfjsEditor) => {
                try {
                    unselectAllEditors(annotationUiManager.value);
                } catch { /* ignore */ }

                const identity = getIdentity();
                const commentSync = getCommentSync();
                const summary = identity.hydrateSummaryFromMemory(
                    commentSync.toEditorSummary(
                        editor,
                        editor.parentPageIndex ?? currentPage.value - 1,
                        getCommentText(editor),
                    ),
                );
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

    function syncSelectedEditorParamToDefaults(
        uiManager: AnnotationEditorUIManager,
        type: TEditorParamType,
        value: TEditorParamValue,
    ) {
        const constructors = new Set<IPdfjsEditorConstructor>();
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const editor of uiManager.getEditors(pageIndex)) {
                const ctor = (editor as IPdfjsEditor & { constructor?: IPdfjsEditorConstructor }).constructor;
                if (ctor && typeof ctor.updateDefaultParams === 'function') {
                    constructors.add(ctor);
                }
            }
        }
        constructors.forEach((ctor) => {
            try {
                ctor.updateDefaultParams?.(type, value);
            } catch (error) {
                BrowserLogger.debug('annotations', `Failed to sync editor default params: ${errorToLogText(error)}`);
            }
        });
    }

    function destroyAnnotationEditor() {
        const commentSync = getCommentSync();
        commentSync.incrementSyncToken();

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

        const originalUpdateParams = uiManager.updateParams.bind(uiManager);
        uiManager.updateParams = (type, value) => {
            const hasSelection = 'hasSelection' in uiManager
                ? Boolean((uiManager as { hasSelection?: boolean }).hasSelection)
                : false;
            const resolvedValue = type === AnnotationEditorParamsType.HIGHLIGHT_FREE
                && markupSubtype.shouldForceTextMarkup(annotationTool.value)
                ? false
                : value;
            const result = originalUpdateParams(type, resolvedValue);
            if (hasSelection
                && type !== AnnotationEditorParamsType.CREATE
                && type !== AnnotationEditorParamsType.HIGHLIGHT_SHOW_ALL) {
                syncSelectedEditorParamToDefaults(uiManager, type, resolvedValue);
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
        uiManager.copy = async (event: ClipboardEvent) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            await originalCopy(event);
        };

        const originalCut = uiManager.cut.bind(uiManager);
        uiManager.cut = async (event: ClipboardEvent) => {
            if (shouldIgnoreEditorEvent(event)) {
                return;
            }
            await originalCut(event);
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
            const result = originalAddToAnnotationStorage(editor);
            const editorObject = editor as object | null;
            if (editorObject && !commentSync.trackedCreatedEditors.has(editorObject)) {
                commentSync.trackedCreatedEditors.add(editorObject);
                toolManager.maybeAutoResetAnnotationTool();
            }
            const normalizedEditor = editor as IPdfjsEditor | null;
            if (normalizedEditor) {
                freeTextResize.ensureFreeTextEditorCanResize(normalizedEditor);
                const pageIndex = Number.isFinite(normalizedEditor.parentPageIndex)
                    ? (normalizedEditor.parentPageIndex as number)
                    : Math.max(0, currentPage.value - 1);
                let knownSubtype = markupSubtype.resolveEditorMarkupSubtypeOverride(normalizedEditor, pageIndex);
                if (!knownSubtype) {
                    knownSubtype = markupSubtype.resolveEditorSubtypeFromPresentation(normalizedEditor);
                }
                if (!knownSubtype && detectEditorSubtype(normalizedEditor) === 'Highlight') {
                    const toolSubtype = markupSubtype.TOOL_TO_MARKUP_SUBTYPE[annotationTool.value] ?? null;
                    if (toolSubtype) {
                        markupSubtype.setEditorMarkupSubtypeOverride(normalizedEditor, pageIndex, toolSubtype);
                        knownSubtype = toolSubtype;
                    }
                }
                if (knownSubtype) {
                    markupSubtype.applyEditorMarkupSubtypePresentation(normalizedEditor, knownSubtype);
                }
            }
            emitAnnotationModified();
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        };

        const originalAddCommands = uiManager.addCommands.bind(uiManager);
        uiManager.addCommands = (params) => {
            emitAnnotationModified();
            const result = originalAddCommands(params);
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        };

        const originalSetSelected = uiManager.setSelected.bind(uiManager);
        uiManager.setSelected = (editor) => {
            const result = originalSetSelected(editor);
            if (editor) {
                freeTextResize.ensureFreeTextEditorCanResize(editor as IPdfjsEditor);
            }
            return result;
        };

        const originalUndo = uiManager.undo.bind(uiManager);
        uiManager.undo = () => {
            const result = originalUndo();
            emitAnnotationModified();
            commentSync.scheduleAnnotationCommentsSync();
            return result;
        };

        const originalRedo = uiManager.redo.bind(uiManager);
        uiManager.redo = () => {
            const result = originalRedo();
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
            pdfDoc.annotationStorage.onSetModified = () => {
                emitAnnotationModified();
                commentSync.scheduleAnnotationCommentsSync();
                freeTextResize.patchResizableFreeTextEditors(uiManager);
            };
        } catch (error) {
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
}
