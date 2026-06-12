export interface IDocumentDirtyState {
    annotationDirty: boolean;
    annotationChanges: boolean;
    bookmarks: boolean;
    livePdfJsAnnotations: boolean;
    pageLabels: boolean;
    pendingDeletes: boolean;
    pendingTexts: boolean;
    preservedAnnotationSource: boolean;
    savedPdfjsAnnotationBaseline: boolean;
    shapes: boolean;
}

export type TDocumentDirtySource = keyof IDocumentDirtyState;

const SHOULD_SERIALIZE_DIRTY_SOURCES = {
    annotationChanges: state => state.annotationChanges,
    annotationDirty: state => state.annotationDirty,
    bookmarks: state => state.bookmarks,
    livePdfJsAnnotations: state => state.livePdfJsAnnotations,
    pageLabels: state => state.pageLabels,
    pendingDeletes: state => state.pendingDeletes,
    pendingTexts: state => state.pendingTexts,
    preservedAnnotationSource: state => state.preservedAnnotationSource,
    savedPdfjsAnnotationBaseline: state => state.savedPdfjsAnnotationBaseline,
    shapes: state => state.shapes,
} satisfies Record<TDocumentDirtySource, (state: IDocumentDirtyState) => boolean>;

export function computeShouldSerializeFlag(dirtyState: IDocumentDirtyState) {
    return Object.values(SHOULD_SERIALIZE_DIRTY_SOURCES).some(hasDirtySource => hasDirtySource(dirtyState));
}

export function shouldPreserveLiveAnnotationSession(options: {
    mode: 'save' | 'save_as';
    shouldSerialize: boolean;
    dirtyState: IDocumentDirtyState;
}) {
    // Embedded deletes need the saved PDF bytes to become the live source;
    // otherwise old PDF.js annotations can outlive their persisted removal.
    return options.mode === 'save'
        && options.shouldSerialize
        && !options.dirtyState.pendingDeletes
        && !options.dirtyState.pageLabels
        && !options.dirtyState.bookmarks
        && (
            options.dirtyState.shapes
            || options.dirtyState.pendingTexts
            || options.dirtyState.livePdfJsAnnotations
            || options.dirtyState.preservedAnnotationSource
            || options.dirtyState.annotationChanges
        );
}
