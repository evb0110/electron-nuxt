export function shouldClearPreservedAnnotationSourceDirty(input: {
    isDirty: boolean;
    hasSavedPdfJsFingerprint: boolean;
    hasLivePdfJsChanges: boolean;
}) {
    return input.isDirty
        && input.hasSavedPdfJsFingerprint
        && !input.hasLivePdfJsChanges;
}
