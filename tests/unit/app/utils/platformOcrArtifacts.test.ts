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

    it('rejects OCR artifact paths that escape the sidecar directory', async () => {
        const { readOptionalOcrArtifactJson } = await import('@app/utils/platformOcrArtifacts');

        await expect(readOptionalOcrArtifactJson('/tmp/doc.pdf', '../secret.json')).resolves.toBeNull();
        await expect(readOptionalOcrArtifactJson('/tmp/doc.pdf', 'pages/../secret.json')).resolves.toBeNull();
        await expect(readOptionalOcrArtifactJson('/tmp/doc.pdf', '/tmp/secret.json')).resolves.toBeNull();
        await expect(readOptionalOcrArtifactJson('/tmp/doc.pdf', 'C:\\secret.json')).resolves.toBeNull();

        expect(documentsMock.fileExists).not.toHaveBeenCalled();
        expect(documentsMock.readTextFile).not.toHaveBeenCalled();
    });

    it('normalizes safe nested OCR artifact paths', async () => {
        documentsMock.fileExists.mockResolvedValue(true);
        documentsMock.readTextFile.mockResolvedValue('{"text":"ok"}');

        const { readOptionalOcrArtifactJson } = await import('@app/utils/platformOcrArtifacts');
        await expect(readOptionalOcrArtifactJson('/tmp/doc.pdf', 'pages\\0001.json'))
            .resolves.toEqual({ text: 'ok' });

        expect(documentsMock.fileExists).toHaveBeenCalledWith('/tmp/doc.pdf.ocr/pages/0001.json');
    });

    it('rejects adjacent artifact suffixes that are not plain suffixes', async () => {
        const { readOptionalAdjacentJsonArtifact } = await import('@app/utils/platformOcrArtifacts');

        await expect(readOptionalAdjacentJsonArtifact('/tmp/doc.pdf', '../secret.json')).resolves.toBeNull();
        await expect(readOptionalAdjacentJsonArtifact('/tmp/doc.pdf', '/secret.json')).resolves.toBeNull();
        await expect(readOptionalAdjacentJsonArtifact('/tmp/doc.pdf', '.ocr/manifest.json')).resolves.toBeNull();

        expect(documentsMock.fileExists).not.toHaveBeenCalled();
        expect(documentsMock.readTextFile).not.toHaveBeenCalled();
    });

    it('reads safe adjacent artifact suffixes', async () => {
        documentsMock.fileExists.mockResolvedValue(true);
        documentsMock.readTextFile.mockResolvedValue('{"version":1}');

        const { readOptionalAdjacentJsonArtifact } = await import('@app/utils/platformOcrArtifacts');
        await expect(readOptionalAdjacentJsonArtifact('/tmp/doc.pdf', '.ocr-manifest.json'))
            .resolves.toEqual({ version: 1 });

        expect(documentsMock.fileExists).toHaveBeenCalledWith('/tmp/doc.pdf.ocr-manifest.json');
    });
});
