import type {
    Ref,
    ShallowRef,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { BrowserLogger } from '@app/utils/browser-logger';

export interface IFileOperationsDeps {
    isSaving: Ref<boolean>;
    isSavingAs: Ref<boolean>;
    workingCopyPath: Ref<string | null>;
    annotationDirty: Ref<boolean>;
    pageLabelsDirty: Ref<boolean>;
    bookmarksDirty: Ref<boolean>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    saveDocument: () => Promise<Uint8Array | null>;
    saveFile: (data: Uint8Array) => Promise<boolean>;
    saveWorkingCopy: () => Promise<boolean>;
    saveWorkingCopyAs: (data?: Uint8Array) => Promise<string | null>;
    markAnnotationSaved: () => void;
    markPageLabelsSaved: () => void;
    markBookmarksSaved: () => void;
    hasAnnotationChanges: () => boolean;
    rewriteMarkupSubtypes: (data: Uint8Array) => Promise<Uint8Array>;
    serializeShapeAnnotations: (data: Uint8Array) => Promise<Uint8Array>;
    rewriteFreeTextNoteRects: (data: Uint8Array) => Promise<Uint8Array>;
    rewritePageLabels: (data: Uint8Array) => Promise<Uint8Array>;
    rewriteBookmarks: (data: Uint8Array) => Promise<Uint8Array>;
    persistAllAnnotationNotes: (force: boolean) => Promise<boolean>;
    annotationNoteWindowsCount: Ref<number>;
    loadRecentFiles: () => void;
}

export const useFileOperations = (deps: IFileOperationsDeps) => {
    const {
        isSaving,
        isSavingAs,
        workingCopyPath,
        annotationDirty,
        pageLabelsDirty,
        bookmarksDirty,
        pdfDocument,
        saveDocument,
        saveFile,
        saveWorkingCopy,
        saveWorkingCopyAs,
        markAnnotationSaved,
        markPageLabelsSaved,
        markBookmarksSaved,
        hasAnnotationChanges,
        rewriteMarkupSubtypes,
        serializeShapeAnnotations,
        rewriteFreeTextNoteRects,
        rewritePageLabels,
        rewriteBookmarks,
        persistAllAnnotationNotes,
        annotationNoteWindowsCount,
        loadRecentFiles,
    } = deps;

    async function saveDocumentWithRetry(maxAttempts = 4, retryDelayMs = 50) {
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const data = await saveDocument();
            if (data) {
                return data;
            }
            if (attempt < maxAttempts - 1) {
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }
        return null;
    }

    async function handleSave() {
        if (isSaving.value || isSavingAs.value) {
            return;
        }
        if (annotationNoteWindowsCount.value > 0) {
            const savedNotes = await persistAllAnnotationNotes(true);
            if (!savedNotes) {
                BrowserLogger.warn('workspace', 'Save aborted because annotation note persistence failed');
                return;
            }
        }
        isSaving.value = true;
        try {
            if (workingCopyPath.value) {
                const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || pageLabelsDirty.value || bookmarksDirty.value;
                if (shouldSerialize) {
                    const rawData = await saveDocumentWithRetry();
                    if (rawData) {
                        let data = await rewriteMarkupSubtypes(rawData);
                        data = await serializeShapeAnnotations(data);
                        data = await rewriteFreeTextNoteRects(data);
                        data = await rewritePageLabels(data);
                        data = await rewriteBookmarks(data);
                        const saved = await saveFile(data);
                        if (saved) {
                            pdfDocument.value?.annotationStorage?.resetModified();
                            markAnnotationSaved();
                            markPageLabelsSaved();
                            markBookmarksSaved();
                        }
                    }
                    return;
                }
                const saved = await saveWorkingCopy();
                if (saved) {
                    markAnnotationSaved();
                    markPageLabelsSaved();
                    markBookmarksSaved();
                }
                return;
            }

            const rawData = await saveDocumentWithRetry();
            if (rawData) {
                let data = await rewriteMarkupSubtypes(rawData);
                data = await rewriteFreeTextNoteRects(data);
                data = await rewritePageLabels(data);
                data = await rewriteBookmarks(data);
                const saved = await saveFile(data);
                if (saved) {
                    pdfDocument.value?.annotationStorage?.resetModified();
                    markAnnotationSaved();
                    markPageLabelsSaved();
                    markBookmarksSaved();
                }
            }
        } finally {
            isSaving.value = false;
        }
    }

    async function handleSaveAs() {
        if (isSaving.value || isSavingAs.value) {
            return;
        }
        if (annotationNoteWindowsCount.value > 0) {
            const savedNotes = await persistAllAnnotationNotes(true);
            if (!savedNotes) {
                BrowserLogger.warn('workspace', 'Save As aborted because annotation note persistence failed');
                return;
            }
        }
        isSavingAs.value = true;
        try {
            let outPath: string | null = null;
            const shouldSerialize = annotationDirty.value || hasAnnotationChanges() || pageLabelsDirty.value || bookmarksDirty.value;
            if (shouldSerialize) {
                const rawData = await saveDocumentWithRetry();
                if (rawData) {
                    let data = await rewriteMarkupSubtypes(rawData);
                    data = await serializeShapeAnnotations(data);
                    data = await rewriteFreeTextNoteRects(data);
                    data = await rewritePageLabels(data);
                    data = await rewriteBookmarks(data);
                    outPath = await saveWorkingCopyAs(data);
                    if (outPath) {
                        pdfDocument.value?.annotationStorage?.resetModified();
                        markAnnotationSaved();
                        markPageLabelsSaved();
                        markBookmarksSaved();
                    }
                }
            } else {
                outPath = await saveWorkingCopyAs();
                if (outPath) {
                    markAnnotationSaved();
                    markPageLabelsSaved();
                    markBookmarksSaved();
                }
            }
            if (outPath) {
                loadRecentFiles();
            }
        } finally {
            isSavingAs.value = false;
        }
    }

    return {
        handleSave,
        handleSaveAs,
    };
};
