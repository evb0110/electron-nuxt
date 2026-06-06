import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
} from 'vue';

const loadOcrTextMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const extractPdfTextMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const createDocxFromTextMock = vi.hoisted(() => vi.fn(() => new Uint8Array([
    7,
    8,
    9,
])));
const toastAddMock = vi.hoisted(() => vi.fn());
const saveBrowserOcrPreferencesMock = vi.hoisted(() => vi.fn());

const mockOcr = {
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    createSearchablePdf: vi.fn(),
    installLanguages: vi.fn(),
    cancel: vi.fn(),
    getLanguages: vi.fn(),
    acknowledgeResultFile: vi.fn(),
};
const mockDocuments = {
    saveDocxAs: vi.fn(),
    writeDocxFile: vi.fn(),
    cleanupFile: vi.fn(),
    readFile: vi.fn(),
    cleanupOcrTemp: vi.fn(),
};
const mockElectronAPI = {
    ocr: mockOcr,
    documents: mockDocuments,
};

vi.mock('@app/utils/getOcrCapability', () => ({ getOcrCapability: () => mockElectronAPI.ocr }));
vi.mock('@app/utils/platformDocuments', () => ({ getDocumentsCapability: () => mockElectronAPI.documents }));
vi.mock('@app/utils/platform', () => ({ isBrowserPlatformActive: () => true }));
vi.mock('@app/utils/ocr/loadOcrText', () => ({ loadOcrText: loadOcrTextMock }));
vi.mock('@app/utils/ocr/extractPdfText', () => ({ extractPdfText: extractPdfTextMock }));
vi.mock('@app/utils/docx', () => ({ createDocxFromText: createDocxFromTextMock }));
vi.mock('@app/platform/browser-api/browserOcrPreferences', () => ({
    getDefaultBrowserOcrSettings: () => ({
        pageRange: 'current',
        customRange: '',
        selectedLanguages: ['eng'],
    }),
    readBrowserOcrPreferences: () => ({
        pageRange: 'custom',
        customRange: '2-4',
        selectedLanguages: [
            'deu',
            'fra',
        ],
    }),
    saveBrowserOcrPreferences: saveBrowserOcrPreferencesMock,
}));

vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

const { useOcr } = await import('@app/composables/useOcr');

describe('useOcr browser preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockOcr.onProgress.mockReturnValue(vi.fn());
        mockOcr.onComplete.mockReturnValue(vi.fn());
        mockOcr.createSearchablePdf.mockResolvedValue({
            started: true,
            jobId: 'job-1',
        });
        mockOcr.installLanguages.mockResolvedValue({
            installed: [],
            errors: [],
        });
        mockOcr.cancel.mockResolvedValue({ canceled: true });
    });

    it('hydrates initial OCR settings from browser preferences and persists updates', async () => {
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            expect(ocr.settings.value).toEqual({
                pageRange: 'custom',
                customRange: '2-4',
                selectedLanguages: [
                    'deu',
                    'fra',
                ],
            });

            ocr.toggleLanguage('eng', true);
            await nextTick();

            expect(saveBrowserOcrPreferencesMock).toHaveBeenCalled();
            expect(saveBrowserOcrPreferencesMock).toHaveBeenLastCalledWith({
                pageRange: 'custom',
                customRange: '2-4',
                selectedLanguages: [
                    'deu',
                    'fra',
                    'eng',
                ],
            });
        } finally {
            scope.stop();
        }
    });
});
