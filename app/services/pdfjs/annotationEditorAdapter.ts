import type { AnnotationEditorUIManager } from 'pdfjs-dist';

interface IPdfjsEditor {
    id?: string;
    uid?: string;
    annotationElementId?: string | null;
    parentPageIndex?: number;
    div?: HTMLElement;
    toggleComment?: (isSelected: boolean, visibility?: boolean) => void;
    remove?: () => void;
    delete?: () => void;
}

type TUiManagerSelectedEditor = Parameters<
    AnnotationEditorUIManager['setSelected']
>[0];

interface IUiManagerWithGetLayer {getLayer: (pageIndex: number) => unknown;}

interface IUiManagerWithSelectComment {selectComment: (pageIndex: number, uid: string) => void;}

interface IUiManagerWithGetEditor {getEditor: (id: string) => unknown;}

interface IUiManagerWithUnselectAll {unselectAll: () => void;}

interface IEditorLayerWithGetEditorByUid {getEditorByUID: (uid: string) => unknown;}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function toPdfjsEditor(value: unknown): IPdfjsEditor | null {
    if (!isRecord(value)) {
        return null;
    }
    return value as IPdfjsEditor;
}

function hasGetLayer(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithGetLayer {
    const candidate = uiManager as { getLayer?: unknown };
    return typeof candidate.getLayer === 'function';
}

function hasSelectComment(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithSelectComment {
    const candidate = uiManager as { selectComment?: unknown };
    return typeof candidate.selectComment === 'function';
}

function hasGetEditor(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithGetEditor {
    const candidate = uiManager as { getEditor?: unknown };
    return typeof candidate.getEditor === 'function';
}

function hasUnselectAll(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithUnselectAll {
    const candidate = uiManager as { unselectAll?: unknown };
    return typeof candidate.unselectAll === 'function';
}

function hasGetEditorByUid(
    layer: unknown,
): layer is IEditorLayerWithGetEditorByUid {
    if (!isRecord(layer)) {
        return false;
    }

    const candidate = layer as { getEditorByUID?: unknown };
    return typeof candidate.getEditorByUID === 'function';
}

export function setSelectedEditor(
    uiManager: AnnotationEditorUIManager,
    editor: unknown,
) {
    const setSelected = uiManager.setSelected as (value: TUiManagerSelectedEditor) => void;
    setSelected(editor as TUiManagerSelectedEditor);
}

export function getEditorByUidFromLayer(
    uiManager: AnnotationEditorUIManager,
    pageIndex: number,
    uid: string,
) {
    if (!hasGetLayer(uiManager)) {
        return null;
    }

    const layer = uiManager.getLayer(pageIndex);
    if (!hasGetEditorByUid(layer)) {
        return null;
    }

    return toPdfjsEditor(layer.getEditorByUID(uid));
}

export function selectCommentByUid(
    uiManager: AnnotationEditorUIManager,
    pageIndex: number,
    uid: string,
) {
    if (!hasSelectComment(uiManager)) {
        return false;
    }

    uiManager.selectComment(pageIndex, uid);
    return true;
}

export function getEditorById(
    uiManager: AnnotationEditorUIManager,
    id: string,
) {
    if (!hasGetEditor(uiManager)) {
        return null;
    }

    return toPdfjsEditor(uiManager.getEditor(id));
}

export function unselectAllEditors(
    uiManager: AnnotationEditorUIManager | null,
) {
    if (!uiManager || !hasUnselectAll(uiManager)) {
        return false;
    }

    uiManager.unselectAll();
    return true;
}
