import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { readPdfConformanceProfile } from '@app/services/pdf-file/readPdfConformanceProfile';

const mocks = vi.hoisted(() => {
    const analyzePdfConformance = vi.fn(() => {
        throw new Error('legacy analyzePdfConformance should not be used');
    });

    return {
        browserLogger: { warn: vi.fn() },
        documentPdf: { analyzePdfConformance: vi.fn() },
        legacyDocuments: { analyzePdfConformance },
    };
});

vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: mocks.browserLogger }));
vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentPdfCapability: () => mocks.documentPdf,
    getDocumentsCapability: () => mocks.legacyDocuments,
}));

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
        expect(mocks.legacyDocuments.analyzePdfConformance).not.toHaveBeenCalled();
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
