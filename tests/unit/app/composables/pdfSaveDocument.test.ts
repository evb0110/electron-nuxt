import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { savePdfDocumentWithCommittedEditors } from '@app/composables/pdf/pdfSaveDocument';
import { cast } from '../../../helpers/cast';

describe('savePdfDocumentWithCommittedEditors', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

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

    it('waits for PDF.js editor commit frames before saving when requestAnimationFrame is available', async () => {
        const commitOrRemove = vi.fn();
        const saveDocument = vi.fn(async () => new Uint8Array([4]));
        const frameCallbacks: FrameRequestCallback[] = [];

        vi.stubGlobal('window', { requestAnimationFrame: (callback: FrameRequestCallback) => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
        } });

        let settled = false;
        const savePromise = savePdfDocumentWithCommittedEditors({
            pdfDocument: cast<PDFDocumentProxy>({ saveDocument }),
            annotationUiManager: cast<AnnotationEditorUIManager>({ commitOrRemove }),
        }).then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(commitOrRemove).toHaveBeenCalledOnce();
        expect(saveDocument).not.toHaveBeenCalled();
        expect(frameCallbacks).toHaveLength(1);

        frameCallbacks.shift()?.(0);
        await Promise.resolve();
        expect(saveDocument).not.toHaveBeenCalled();
        expect(frameCallbacks).toHaveLength(1);

        frameCallbacks.shift()?.(16);
        await savePromise;

        expect(settled).toBe(true);
        expect(saveDocument).toHaveBeenCalledOnce();
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

    it('aborts when the active PDF document changes while editor commits settle', async () => {
        const firstDocument = cast<PDFDocumentProxy>({ saveDocument: vi.fn(async () => new Uint8Array([1])) });
        const secondDocument = cast<PDFDocumentProxy>({ saveDocument: vi.fn(async () => new Uint8Array([2])) });
        let activeDocument: PDFDocumentProxy | null = firstDocument;
        const commitOrRemove = vi.fn(() => {
            activeDocument = secondDocument;
        });

        const result = await savePdfDocumentWithCommittedEditors({
            pdfDocument: firstDocument,
            annotationUiManager: cast<AnnotationEditorUIManager>({ commitOrRemove }),
            getCurrentPdfDocument: () => activeDocument,
        });

        expect(result).toBeNull();
        expect(commitOrRemove).toHaveBeenCalledOnce();
        expect(firstDocument.saveDocument).not.toHaveBeenCalled();
        expect(secondDocument.saveDocument).not.toHaveBeenCalled();
    });

    it('drops bytes when the PDF document changes before saveDocument resolves', async () => {
        const saveState: {resolveSave?: (data: Uint8Array) => void} = {};
        const saveDocument = vi.fn(() => new Promise<Uint8Array>((resolve) => {
            saveState.resolveSave = resolve;
        }));
        const firstDocument = cast<PDFDocumentProxy>({ saveDocument });
        const secondDocument = cast<PDFDocumentProxy>({ saveDocument: vi.fn(async () => new Uint8Array([9])) });
        let activeDocument: PDFDocumentProxy | null = firstDocument;

        const savePromise = savePdfDocumentWithCommittedEditors({
            pdfDocument: firstDocument,
            annotationUiManager: null,
            getCurrentPdfDocument: () => activeDocument,
        });

        await vi.waitFor(() => {
            expect(saveDocument).toHaveBeenCalledOnce();
        });

        activeDocument = secondDocument;
        saveState.resolveSave?.(new Uint8Array([7]));

        await expect(savePromise).resolves.toBeNull();
    });

    it('aborts when the PDF document is destroyed before saving', async () => {
        const saveDocument = vi.fn(async () => new Uint8Array([5]));
        const pdfDocument = cast<PDFDocumentProxy>({
            destroyed: true,
            saveDocument,
        });

        const result = await savePdfDocumentWithCommittedEditors({
            pdfDocument,
            annotationUiManager: null,
        });

        expect(result).toBeNull();
        expect(saveDocument).not.toHaveBeenCalled();
    });
});
