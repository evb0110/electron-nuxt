import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const trackMock = vi.hoisted(() => vi.fn());
const toastAddMock = vi.hoisted(() => vi.fn());
const createDocxFromTextAsyncMock = vi.hoisted(() => vi.fn(async () => new Uint8Array([
    1,
    2,
    3,
])));
const loadOcrTextMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const extractPdfTextMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => 'pdf text'));
const documentFilesMock = vi.hoisted(() => ({
    saveDocxAs: vi.fn(async () => '/tmp/export.docx'),
    writeDocxFile: vi.fn(async () => {}),
}));
const documentWorkingCopyMock = vi.hoisted(() => ({cleanupFile: vi.fn(async () => {})}));
const legacyDocumentsMock = vi.hoisted(() => ({
    saveDocxAs: vi.fn(() => {
        throw new Error('Legacy documents.saveDocxAs should not be used for DOCX export');
    }),
    writeDocxFile: vi.fn(() => {
        throw new Error('Legacy documents.writeDocxFile should not be used for DOCX export');
    }),
    cleanupFile: vi.fn(() => {
        throw new Error('Legacy documents.cleanupFile should not be used for DOCX export');
    }),
}));

vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentsCapability: () => legacyDocumentsMock,
    getDocumentFilesCapability: () => documentFilesMock,
    getDocumentWorkingCopyCapability: () => documentWorkingCopyMock,
}));
vi.mock('@app/composables/useAnalytics', () => ({useAnalytics: () => ({track: trackMock})}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));
vi.mock('@app/utils/ocr/loadOcrText', () => ({ loadOcrText: loadOcrTextMock }));
vi.mock('@app/utils/ocr/extractPdfText', () => ({ extractPdfText: extractPdfTextMock }));
vi.mock('@app/utils/docx', () => ({createDocxFromTextAsync: createDocxFromTextAsyncMock}));
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

beforeEach(() => {
    vi.clearAllMocks();
});

describe('useDocxExport', () => {
    it('uses the async docx builder without cleaning filesystem output paths', async () => {
        const callOrder: string[] = [];
        documentFilesMock.saveDocxAs.mockImplementationOnce(async () => {
            callOrder.push('save');
            return '/tmp/export.docx';
        });
        loadOcrTextMock.mockImplementationOnce(async () => {
            callOrder.push('loadOcrText');
            return null;
        });
        extractPdfTextMock.mockImplementationOnce(async () => {
            callOrder.push('extractPdfText');
            return 'pdf text';
        });
        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: '/tmp/work.pdf',
            pdfDocument: {} as PDFDocumentProxy,
            selectedLanguages: ['heb'],
        });

        expect(result).toBe(true);
        expect(callOrder).toEqual([
            'save',
            'loadOcrText',
            'extractPdfText',
        ]);
        expect(loadOcrTextMock).toHaveBeenCalledTimes(1);
        expect(extractPdfTextMock).toHaveBeenCalledTimes(1);
        expect(createDocxFromTextAsyncMock).toHaveBeenCalledWith('pdf text', true);
        expect(documentFilesMock.saveDocxAs).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(documentFilesMock.writeDocxFile).toHaveBeenCalledWith(
            '/tmp/export.docx',
            new Uint8Array([
                1,
                2,
                3,
            ]),
        );
        expect(documentWorkingCopyMock.cleanupFile).not.toHaveBeenCalled();
        expect(legacyDocumentsMock.saveDocxAs).not.toHaveBeenCalled();
        expect(legacyDocumentsMock.writeDocxFile).not.toHaveBeenCalled();
        expect(legacyDocumentsMock.cleanupFile).not.toHaveBeenCalled();
        expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
            color: 'success',
            title: expect.any(String),
            description: expect.any(String),
        }));
        expect(trackMock).toHaveBeenCalledWith('export_completed', expect.objectContaining({
            format: 'docx',
            hasRtl: true,
            selectedLanguageCount: 1,
            status: 'success',
        }));
    });

    it('does not cleanup filesystem output paths when no DOCX text is available', async () => {
        documentFilesMock.saveDocxAs.mockResolvedValueOnce('/tmp/empty.docx');
        loadOcrTextMock.mockResolvedValueOnce(null);
        extractPdfTextMock.mockResolvedValueOnce(null);

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: '/tmp/work.pdf',
            pdfDocument: {} as PDFDocumentProxy,
        });

        expect(result).toBe(false);
        expect(exportState.docxExportError.value).toBe('errors.ocr.noText');
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentWorkingCopyMock.cleanupFile).not.toHaveBeenCalled();
        expect(legacyDocumentsMock.saveDocxAs).not.toHaveBeenCalled();
        expect(legacyDocumentsMock.writeDocxFile).not.toHaveBeenCalled();
        expect(legacyDocumentsMock.cleanupFile).not.toHaveBeenCalled();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('cleans up browser output refs when no DOCX text is available', async () => {
        documentFilesMock.saveDocxAs.mockResolvedValueOnce('browser://documents/output/empty.docx');
        loadOcrTextMock.mockResolvedValueOnce(null);
        extractPdfTextMock.mockResolvedValueOnce(null);

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: 'browser://documents/working/work.pdf',
            pdfDocument: {} as PDFDocumentProxy,
        });

        expect(result).toBe(false);
        expect(documentFilesMock.writeDocxFile).not.toHaveBeenCalled();
        expect(documentWorkingCopyMock.cleanupFile).toHaveBeenCalledWith('browser://documents/output/empty.docx');
        expect(legacyDocumentsMock.saveDocxAs).not.toHaveBeenCalled();
        expect(legacyDocumentsMock.writeDocxFile).not.toHaveBeenCalled();
        expect(legacyDocumentsMock.cleanupFile).not.toHaveBeenCalled();
    });
});
