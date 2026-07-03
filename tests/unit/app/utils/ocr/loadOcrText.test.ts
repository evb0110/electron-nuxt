import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const readOptionalOcrArtifactJsonMock = vi.hoisted(() => vi.fn());
const readOptionalAdjacentJsonArtifactMock = vi.hoisted(() => vi.fn());
const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@app/utils/platformOcrArtifacts', () => ({
    readOptionalOcrArtifactJson: readOptionalOcrArtifactJsonMock,
    readOptionalAdjacentJsonArtifact: readOptionalAdjacentJsonArtifactMock,
}));

vi.mock('@app/utils/yieldToBrowser', () => ({yieldToBrowser: yieldToBrowserMock}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));

const { loadOcrText } = await import('@app/utils/ocr/loadOcrText');

const TEST_DOCUMENT_REVISION = 'revision-token';

describe('loadOcrText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readOptionalOcrArtifactJsonMock.mockResolvedValue(null);
        readOptionalAdjacentJsonArtifactMock.mockResolvedValue(null);
    });

    it('yields while reading large revision-matched search indexes', async () => {
        const pages = Array.from({length: 17}, (_value, index) => ({text: `Page ${index + 1}`}));
        readOptionalAdjacentJsonArtifactMock.mockResolvedValue({
            schemaVersion: 7,
            documentRevision: {token: TEST_DOCUMENT_REVISION},
            pages,
        });

        await expect(loadOcrText('/tmp/work.pdf', TEST_DOCUMENT_REVISION)).resolves.toContain('Page 17');

        expect(yieldToBrowserMock).toHaveBeenCalledTimes(2);
    });
});
