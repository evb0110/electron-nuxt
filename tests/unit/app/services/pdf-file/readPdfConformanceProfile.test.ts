import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { readPdfConformanceProfile } from '@app/services/pdf-file/readPdfConformanceProfile';

const mocks = vi.hoisted(() => ({
    browserLogger: { warn: vi.fn() },
    documentPdf: { analyzePdfConformance: vi.fn() },
}));

vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: mocks.browserLogger }));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentPdfCapability: () => mocks.documentPdf}));

describe('readPdfConformanceProfile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.documentPdf.analyzePdfConformance.mockResolvedValue({
            profile: 'PDF/A-2u',
            isPdfA: true,
            isTagged: true,
            hasSignatures: false,
        });
    });

    it('reads conformance through the split pdf capability', async () => {
        const result = await readPdfConformanceProfile('/tmp/working.pdf');

        expect(result).toEqual({
            profile: 'PDF/A-2u',
            isPdfA: true,
            isTagged: true,
            hasSignatures: false,
        });
        expect(mocks.documentPdf.analyzePdfConformance).toHaveBeenCalledWith('/tmp/working.pdf');
    });

    it('logs and returns null when conformance analysis fails', async () => {
        const error = new Error('analysis failed');
        mocks.documentPdf.analyzePdfConformance.mockRejectedValueOnce(error);

        const result = await readPdfConformanceProfile('/tmp/working.pdf');

        expect(result).toBeNull();
        expect(mocks.browserLogger.warn).toHaveBeenCalledWith(
            'pdf-file',
            'Failed to analyze PDF conformance profile',
            {
                path: '/tmp/working.pdf',
                error,
            },
        );
    });
});
