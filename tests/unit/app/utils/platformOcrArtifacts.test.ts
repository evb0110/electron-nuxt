import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const readBrowserOcrArtifactJsonMock = vi.hoisted(() => vi.fn());
const documentsMock = vi.hoisted(() => ({
    fileExists: vi.fn(),
    readTextFile: vi.fn(),
}));

vi.mock('@app/platform/browser-api/browserOcrArtifactStore', () => ({readBrowserOcrArtifactJson: (workingCopyPath: string, relativePath: string) =>
    readBrowserOcrArtifactJsonMock(workingCopyPath, relativePath)}));
vi.mock('@app/platform/browserDocumentStore', () => ({isBrowserDocumentRef: (path: string) => path.startsWith('browser://documents/')}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentsCapability: () => documentsMock}));

describe('platform OCR artifacts', () => {
    beforeEach(() => {
        vi.resetModules();
        readBrowserOcrArtifactJsonMock.mockReset();
        documentsMock.fileExists.mockReset();
        documentsMock.readTextFile.mockReset();
    });

    it('reads browser OCR artifacts before adjacent document artifacts for browser refs', async () => {
        readBrowserOcrArtifactJsonMock.mockResolvedValue({ version: 2 });

        const { readOptionalOcrArtifactJson } = await import('@app/utils/platformOcrArtifacts');
        await expect(readOptionalOcrArtifactJson('browser://documents/test/doc.pdf', 'manifest.json'))
            .resolves.toEqual({ version: 2 });

        expect(readBrowserOcrArtifactJsonMock).toHaveBeenCalledWith(
            'browser://documents/test/doc.pdf',
            'manifest.json',
        );
        expect(documentsMock.fileExists).not.toHaveBeenCalled();
        expect(documentsMock.readTextFile).not.toHaveBeenCalled();
    });

    it('falls back to adjacent artifact lookup when no browser OCR artifact exists', async () => {
        readBrowserOcrArtifactJsonMock.mockResolvedValue(null);
        documentsMock.fileExists.mockResolvedValue(true);
        documentsMock.readTextFile.mockResolvedValue('{"version":2}');

        const { readOptionalOcrArtifactJson } = await import('@app/utils/platformOcrArtifacts');
        await expect(readOptionalOcrArtifactJson('browser://documents/test/doc.pdf', 'manifest.json'))
            .resolves.toEqual({ version: 2 });

        expect(documentsMock.fileExists).toHaveBeenCalledWith('browser://documents/test/doc.pdf.ocr/manifest.json');
        expect(documentsMock.readTextFile).toHaveBeenCalledWith('browser://documents/test/doc.pdf.ocr/manifest.json');
    });
});
