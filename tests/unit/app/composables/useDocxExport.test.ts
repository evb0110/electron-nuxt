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
const electronApiMock = vi.hoisted(() => ({documents: {
    saveDocxAs: vi.fn(async () => '/tmp/export.docx'),
    writeDocxFile: vi.fn(async () => {}),
    cleanupFile: vi.fn(async () => {}),
}}));

vi.mock('@app/utils/platformDocuments', () => ({ getDocumentsCapability: () => electronApiMock.documents }));
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
        electronApiMock.documents.saveDocxAs.mockImplementationOnce(async () => {
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
        expect(electronApiMock.documents.saveDocxAs).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(electronApiMock.documents.writeDocxFile).toHaveBeenCalledWith(
            '/tmp/export.docx',
            new Uint8Array([
                1,
                2,
                3,
            ]),
        );
        expect(electronApiMock.documents.cleanupFile).not.toHaveBeenCalled();
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
        electronApiMock.documents.saveDocxAs.mockResolvedValueOnce('/tmp/empty.docx');
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
        expect(electronApiMock.documents.writeDocxFile).not.toHaveBeenCalled();
        expect(electronApiMock.documents.cleanupFile).not.toHaveBeenCalled();
        expect(toastAddMock).not.toHaveBeenCalled();
    });

    it('cleans up browser output refs when no DOCX text is available', async () => {
        electronApiMock.documents.saveDocxAs.mockResolvedValueOnce('browser://documents/output/empty.docx');
        loadOcrTextMock.mockResolvedValueOnce(null);
        extractPdfTextMock.mockResolvedValueOnce(null);

        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: 'browser://documents/working/work.pdf',
            pdfDocument: {} as PDFDocumentProxy,
        });

        expect(result).toBe(false);
        expect(electronApiMock.documents.writeDocxFile).not.toHaveBeenCalled();
        expect(electronApiMock.documents.cleanupFile).toHaveBeenCalledWith('browser://documents/output/empty.docx');
    });
});
