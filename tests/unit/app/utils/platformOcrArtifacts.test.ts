import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const documentsMock = vi.hoisted(() => ({
    fileExists: vi.fn(),
    readTextFile: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', () => ({getDocumentsCapability: () => documentsMock}));

describe('platform OCR artifacts', () => {
    beforeEach(() => {
        vi.resetModules();
        documentsMock.fileExists.mockReset();
        documentsMock.readTextFile.mockReset();
    });

    it('reads OCR artifacts from adjacent sidecar files', async () => {
        documentsMock.fileExists.mockResolvedValue(true);
        documentsMock.readTextFile.mockResolvedValue('{"version":2}');

        const { readOptionalOcrArtifactJson } = await import('@app/utils/platformOcrArtifacts');
        await expect(readOptionalOcrArtifactJson('/tmp/doc.pdf', 'manifest.json'))
            .resolves.toEqual({ version: 2 });

        expect(documentsMock.fileExists).toHaveBeenCalledWith('/tmp/doc.pdf.ocr/manifest.json');
        expect(documentsMock.readTextFile).toHaveBeenCalledWith('/tmp/doc.pdf.ocr/manifest.json');
    });

    it('returns null when the adjacent OCR artifact is absent', async () => {
        documentsMock.fileExists.mockResolvedValue(false);

        const { readOptionalOcrArtifactJson } = await import('@app/utils/platformOcrArtifacts');
        await expect(readOptionalOcrArtifactJson('/tmp/doc.pdf', 'manifest.json'))
            .resolves.toBeNull();

        expect(documentsMock.readTextFile).not.toHaveBeenCalled();
    });
});
