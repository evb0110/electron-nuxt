import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const trackMock = vi.hoisted(() => vi.fn());
const createDocxFromTextAsyncMock = vi.hoisted(() => vi.fn(async () => new Uint8Array([
    1,
    2,
    3,
])));
const loadOcrTextMock = vi.hoisted(() => vi.fn(async () => null));
const extractPdfTextMock = vi.hoisted(() => vi.fn(async () => 'pdf text'));
const electronApiMock = vi.hoisted(() => ({documents: {
    saveDocxAs: vi.fn(async () => '/tmp/export.docx'),
    writeDocxFile: vi.fn(async () => {}),
    cleanupFile: vi.fn(async () => {}),
}}));

vi.mock('@app/utils/platform', () => ({getElectronAPI: () => electronApiMock}));
vi.mock('@app/composables/useAnalytics', () => ({useAnalytics: () => ({track: trackMock})}));
vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));
vi.mock('@app/composables/ocrProcessing', () => ({
    loadOcrText: loadOcrTextMock,
    extractPdfText: extractPdfTextMock,
}));
vi.mock('@app/utils/docx', () => ({createDocxFromTextAsync: createDocxFromTextAsyncMock}));

describe('useDocxExport', () => {
    it('uses the async docx builder and cleans up the output handle', async () => {
        const { useDocxExport } = await import('@app/composables/useDocxExport');
        const exportState = useDocxExport();

        const result = await exportState.exportDocx({
            workingCopyPath: '/tmp/work.pdf',
            pdfDocument: {} as PDFDocumentProxy,
            selectedLanguages: ['heb'],
        });

        expect(result).toBe(true);
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
        expect(electronApiMock.documents.cleanupFile).toHaveBeenCalledWith('/tmp/export.docx');
        expect(trackMock).toHaveBeenCalledWith('export_completed', expect.objectContaining({
            format: 'docx',
            hasRtl: true,
            selectedLanguageCount: 1,
            status: 'success',
        }));
    });
});
