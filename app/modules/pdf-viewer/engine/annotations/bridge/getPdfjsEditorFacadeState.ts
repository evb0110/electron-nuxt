import type {IAnnotationMarkerRect} from '@app/types/annotations';
import type {
    IPdfjsEditor,
    IPdfjsHighlightBox,
} from '@app/types/pdfjs';

interface IPdfjsEditorFacadeState {
    canonicalAnnotationId?: string | null | undefined;
    selectionText?: string | null | undefined;
    markupBoxes?: IPdfjsHighlightBox[] | null | undefined;
    creationHistoryRegistered?: boolean | undefined;
    resolvedPageIndex?: number | undefined;
    placementAttemptId?: string | null | undefined;
    markupSubtypeColor?: string | null | undefined;
    pendingAnchorRect?: IAnnotationMarkerRect | null | undefined;
    commentMarkerAnchor?: boolean | undefined;
    freeTextPreSelectPatched?: boolean | undefined;
    freeTextResizeHookPatched?: boolean | undefined;
    freeTextFontToWidthRatio?: number | undefined;
    freeTextResizeSyncRaf?: number | undefined;
    freeTextIsResizeSync?: boolean | undefined;
    freeTextResizablePatched?: boolean | undefined;
}

const editorFacadeStates = new WeakMap<object, IPdfjsEditorFacadeState>();

export function getPdfjsEditorFacadeState(editor: object) {
    const current = editorFacadeStates.get(editor);
    if (current) {
        return current;
    }
    const legacy = editor as IPdfjsEditor;
    const created: IPdfjsEditorFacadeState = {
        selectionText: legacy.__evbSelectionText,
        markupBoxes: legacy.__evbMarkupBoxes,
        creationHistoryRegistered: legacy.__evbCreationHistoryRegistered,
        resolvedPageIndex: legacy.__evbResolvedPageIndex,
        placementAttemptId: legacy.__evbPlacementAttemptId,
        markupSubtypeColor: legacy.__evbMarkupSubtypeColor,
        pendingAnchorRect: legacy.__evbPendingAnchorRect,
        commentMarkerAnchor: legacy.__evbCommentMarkerAnchor,
    };
    editorFacadeStates.set(editor, created);
    return created;
}
