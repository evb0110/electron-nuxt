import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { savePdfDocumentWithCommittedEditors } from '@app/composables/pdf/pdfSaveDocument';

function cast<T>(value: unknown): T {
    return value as T;
}

describe('savePdfDocumentWithCommittedEditors', () => {
    it('commits the active annotation editor before saving the document', async () => {
        const commitOrRemove = vi.fn();
        const saveDocument = vi.fn(async () => new Uint8Array([
            1,
            2,
            3,
        ]));

        const result = await savePdfDocumentWithCommittedEditors({
            pdfDocument: cast<PDFDocumentProxy>({ saveDocument }),
            annotationUiManager: cast<AnnotationEditorUIManager>({ commitOrRemove }),
        });

        expect(commitOrRemove).toHaveBeenCalledOnce();
        expect(saveDocument).toHaveBeenCalledOnce();
        expect(commitOrRemove.mock.invocationCallOrder[0]).toBeLessThan(
            saveDocument.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(Array.from(result ?? [])).toEqual([
            1,
            2,
            3,
        ]);
    });

    it('returns null when no PDF document is loaded', async () => {
        const commitOrRemove = vi.fn();

        const result = await savePdfDocumentWithCommittedEditors({
            pdfDocument: null,
            annotationUiManager: cast<AnnotationEditorUIManager>({ commitOrRemove }),
        });

        expect(result).toBeNull();
        expect(commitOrRemove).not.toHaveBeenCalled();
    });
});
