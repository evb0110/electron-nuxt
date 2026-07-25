import type { AnnotationId } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import { syncCommentMarkerAnchorEditor } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/commentMarkerAnchorEditor';
export { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/engine/annotations/bridge/getPdfjsEditorFacadeState';

/** Opaque outside the annotation bridge; feature code imports this port type. */
export type TPdfjsAnnotationManager = AnnotationEditorUIManager;

// Annotation features import PDF.js capabilities only through this boundary.
// The low-level adapters remain implementation details of the facade.
export {
    addUndoableEditorToLayer,
    asPdfjsEditor,
    clearSelectedEditorState,
    createAnnotationEditorAtPoint,
    createAnnotationEditorWithSyntheticPointer,
    dispatchAnnotationEditorPointerTap,
    getActiveEditor,
    getAnnotationEditorLayer,
    getAnnotationEditorLayerDiv,
    getEditorById,
    getEditorByUidFromLayer,
    getEditorConstructor,
    getEditorParentDimensions,
    getEditorSerializedData,
    getEditorsOnPage,
    isEditorCommentDeleted,
    isEditorDraggable,
    isEditorInEditMode,
    isPdfjsEditorWithEditComment,
    makeEditorResizable,
    markEditorChangedExistingAnnotation,
    markEditorResizable,
    patchEditorResizeHandlers,
    patchEditorUpdateParams,
    refreshEditorLayout,
    selectCommentByUid,
    setEditorDefaultParamUpdater,
    setEditorDraggable,
    setSelectedEditor,
    syncEditorToAnnotationStorage,
    unselectAllEditors,
    updateEditorDefaultParams,
    updateEditorParams,
} from '@app/services/pdfjs/annotationEditorAdapter';
export {
    deleteEditorWithUiManager,
    deleteSelectedEditorWithUiManager,
    getAnnotationEditorMode,
    getStoredAnnotationEditor,
    waitForAnnotationEditorsRendered,
    writeEditorCommentToAnnotationStorage,
} from '@app/services/pdfjs/annotationEditorMutation';
export {
    createPdfjsEventBus,
    createPdfjsGenericL10n,
    createPdfjsUiManager,
    getPdfjsEditorCompatibilityRuntime,
    hasSelectedPdfjsEditor,
    interceptPdfjsDelete,
    interceptPdfjsRegisterEditorTypes,
} from '@app/services/pdfjs/pdfViewerFacade';
export {createPdfHighlightEditorClassPatch} from '@app/services/pdfjs/createPdfHighlightEditorClassPatch';
export {createPdfAnnotationEditorCompatibilityAdapter} from '@app/services/pdfjs/annotationEditorCompatibility';

export function updatePdfjsAnnotationManagerParams(manager: object, type: number, value: unknown) {
    const updateParams: unknown = Reflect.get(manager, 'updateParams');
    if (typeof updateParams !== 'function') {
        return false;
    }
    Reflect.apply(updateParams, manager, [
        type,
        value,
    ]);
    return true;
}

function invokeManagerLifecycleMethod(manager: object, method: 'addEditListeners' | 'removeEditListeners') {
    const candidate: unknown = Reflect.get(manager, method);
    if (typeof candidate !== 'function') {
        return false;
    }
    Reflect.apply(candidate, manager, []);
    return true;
}

export function startPdfjsAnnotationManagerEditing(manager: object) {
    return invokeManagerLifecycleMethod(manager, 'addEditListeners');
}

export function stopPdfjsAnnotationManagerEditing(manager: object) {
    return invokeManagerLifecycleMethod(manager, 'removeEditListeners');
}

export function syncPdfjsCommentMarkerAnchor(editor: object, rect: IAnnotationMarkerRect) {
    return syncCommentMarkerAnchorEditor(editor, rect);
}

export function isPdfjsAppHistorySuppressed(command: object) {
    return Boolean(Reflect.get(command, '__evbSkipAppHistory'));
}

export interface IEditorLease {
    readonly editorKey: string;
    readonly documentGeneration: number;
    readonly pageGeneration: number;
    readonly managerGeneration: number;
}

export type TLeaseResult<T> = {
    status: 'ok';
    value: T
} | { status: 'stale' };

interface IEditorBinding {
    annotationId: AnnotationId;
    lease: IEditorLease;
}

interface IFacadeGenerations {
    document: number;
    manager: number;
    page: (pageIndex: number) => number;
}

const MANAGER_CAPABILITIES = [
    'addCommands',
    'addToAnnotationStorage',
    'copy',
    'cut',
    'delete',
    'keydown',
    'keyup',
    'paste',
    'redo',
    'setSelected',
    'undo',
    'updateParams',
] as const;

export type TPdfjsAnnotationManagerCapability = typeof MANAGER_CAPABILITIES[number];

export interface IPdfjsAnnotationCapabilities {
    readonly version: string;
    readonly manager: Readonly<Record<TPdfjsAnnotationManagerCapability, boolean>>;
}

export class PdfjsAnnotationFacade {
    #byEditor = new WeakMap<object, IEditorBinding>();
    readonly #byKey = new Map<string, IEditorBinding>();
    readonly #modifiedListeners = new Set<() => void>();
    readonly #managerPatchRestorers = new Set<() => void>();

    constructor(readonly generations: IFacadeGenerations) {}

    capabilities(manager: object, version = 'unknown'): IPdfjsAnnotationCapabilities {
        return Object.freeze({
            version,
            manager: Object.freeze(Object.fromEntries(MANAGER_CAPABILITIES.map(capability => [
                capability,
                typeof Reflect.get(manager, capability) === 'function',
            ])) as Record<TPdfjsAnnotationManagerCapability, boolean>),
        });
    }

    bindEditor(editor: object, annotationId: AnnotationId, editorKey: string, pageIndex: number): IEditorLease {
        const lease = {
            editorKey,
            documentGeneration: this.generations.document,
            pageGeneration: this.generations.page(pageIndex),
            managerGeneration: this.generations.manager,
        } satisfies IEditorLease;
        const binding = {
            annotationId,
            lease,
        };
        this.#byEditor.set(editor, binding);
        this.#byKey.set(editorKey, binding);
        return lease;
    }

    annotationIdFor(editor: object) {
        return this.#byEditor.get(editor)?.annotationId ?? null;
    }

    withEditor<T>(
        lease: IEditorLease,
        pageIndex: number,
        resolveCurrentEditor: (editorKey: string) => object | null,
        action: (editor: object) => T,
    ): TLeaseResult<T> {
        const binding = this.#byKey.get(lease.editorKey);
        if (
            !binding
            || binding.lease !== lease
            || lease.documentGeneration !== this.generations.document
            || lease.managerGeneration !== this.generations.manager
            || lease.pageGeneration !== this.generations.page(pageIndex)
        ) {
            return {status: 'stale'};
        }
        const editor = resolveCurrentEditor(lease.editorKey);
        if (!editor) {
            return {status: 'stale'};
        }
        return {
            status: 'ok',
            value: action(editor),
        };
    }

    releaseEditor(editor: object) {
        const binding = this.#byEditor.get(editor);
        if (!binding) {
            return;
        }
        this.#byEditor.delete(editor);
        if (this.#byKey.get(binding.lease.editorKey) === binding) this.#byKey.delete(binding.lease.editorKey);
    }

    clear() {
        this.#managerPatchRestorers.forEach(restore => restore());
        this.#managerPatchRestorers.clear();
        this.#byEditor = new WeakMap<object, IEditorBinding>();
        this.#byKey.clear();
    }

    interceptManagerMethod<TArgs extends unknown[], TResult>(
        manager: object,
        method: string,
        invoke: (original: (...args: TArgs) => TResult, args: TArgs) => TResult,
    ) {
        const candidate: unknown = Reflect.get(manager, method);
        if (typeof candidate !== 'function') {
            return false;
        }
        const original = ((...args: TArgs) => Reflect.apply(candidate, manager, args) as TResult);
        const patched = (...args: TArgs) => invoke(original, args);
        Reflect.set(manager, method, patched);
        const restore = () => {
            if (Reflect.get(manager, method) === patched) Reflect.set(manager, method, original);
        };
        this.#managerPatchRestorers.add(restore);
        return true;
    }

    subscribeDocumentModified(document: object, listener: () => void) {
        const storage: unknown = Reflect.get(document, 'annotationStorage');
        if (!storage || typeof storage !== 'object') {
            return false;
        }
        const previous: unknown = Reflect.get(storage, 'onSetModified');
        const callback = () => {
            if (typeof previous === 'function') Reflect.apply(previous, storage, []);
            listener();
        };
        Reflect.set(storage, 'onSetModified', callback);
        const restore = () => {
            if (Reflect.get(storage, 'onSetModified') === callback) {
                Reflect.set(storage, 'onSetModified', previous ?? null);
            }
        };
        this.#managerPatchRestorers.add(restore);
        return true;
    }

    subscribeModified(listener: () => void) {
        this.#modifiedListeners.add(listener);
        return () => this.#modifiedListeners.delete(listener);
    }

    notifyModified() {
        this.#modifiedListeners.forEach(listener => listener());
    }

    probe(manager: object, capability: string) {
        return typeof Reflect.get(manager, capability) === 'function';
    }
}
