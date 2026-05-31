import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { delay } from 'es-toolkit/promise';

const addWorkerMock = vi.hoisted(() => vi.fn());
const terminateSchedulerMock = vi.hoisted(() => vi.fn(async () => {}));
const addJobMock = vi.hoisted(() => vi.fn());
const createSchedulerMock = vi.hoisted(() => vi.fn(() => ({
    addWorker: addWorkerMock,
    addJob: addJobMock,
    terminate: terminateSchedulerMock,
})));
const terminateWorkerMock = vi.hoisted(() => vi.fn(async () => {}));
const createWorkerMock = vi.hoisted(() => vi.fn(async () => ({ terminate: terminateWorkerMock })));

vi.mock('tesseract.js', () => ({
    createScheduler: createSchedulerMock,
    createWorker: createWorkerMock,
}));

vi.mock('@app/platform/browser-api/browserOcrLanguageStore', () => ({
    cacheBrowserOcrLanguageData: vi.fn(async () => {}),
    hasCachedBrowserOcrLanguage: vi.fn(async () => true),
    hydrateBrowserOcrLanguageCache: vi.fn(async () => true),
    listInstalledBrowserOcrLanguages: vi.fn(async () => new Set(['eng'])),
    markBrowserOcrLanguageInstalled: vi.fn(async () => {}),
}));

vi.mock('@app/utils/browserOcrConfig', () => ({ getBrowserOcrLanguageBaseUrl: () => '/ocr-langs' }));

vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} }));

describe('browser OCR capability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', function FakeWorker() {});
        vi.stubGlobal('navigator', {
            hardwareConcurrency: 8,
            deviceMemory: 8,
        });
        addJobMock.mockResolvedValue({ data: {
            text: 'recognized text',
            blocks: [],
        } });
    });

    it('prefers a single worker on low-memory devices', async () => {
        const { resolveBrowserOcrWorkerCount } = await import('@app/platform/browser-api/ocrCapability');

        expect(resolveBrowserOcrWorkerCount({
            pageCount: 6,
            hardwareConcurrency: 8,
            deviceMemoryGb: 4,
            totalPixels: 6 * 1_000_000,
        })).toBe(1);
    });

    it('uses three workers on stronger devices with enough small pages', async () => {
        const { resolveBrowserOcrWorkerCount } = await import('@app/platform/browser-api/ocrCapability');

        expect(resolveBrowserOcrWorkerCount({
            pageCount: 10,
            hardwareConcurrency: 10,
            deviceMemoryGb: 16,
            totalPixels: 10 * 2_000_000,
        })).toBe(3);
    });

    it('limits in-flight OCR jobs to the adaptive worker count', async () => {
        vi.stubGlobal('navigator', {
            hardwareConcurrency: 6,
            deviceMemory: 8,
        });

        let activeJobs = 0;
        let maxActiveJobs = 0;
        addJobMock.mockImplementation(async () => {
            activeJobs += 1;
            maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
            await delay(5);
            activeJobs -= 1;
            return { data: {
                text: 'recognized text',
                blocks: [],
            } };
        });

        const { browserOcrCapability } = await import('@app/platform/browser-api/ocrCapability');
        const result = await browserOcrCapability.recognizeBatch([
            {
                pageNumber: 1,
                imageData: new Uint8Array([1]),
                languages: ['eng'],
                imageWidth: 1200,
                imageHeight: 1600,
            },
            {
                pageNumber: 2,
                imageData: new Uint8Array([2]),
                languages: ['eng'],
                imageWidth: 1200,
                imageHeight: 1600,
            },
            {
                pageNumber: 3,
                imageData: new Uint8Array([3]),
                languages: ['eng'],
                imageWidth: 1200,
                imageHeight: 1600,
            },
            {
                pageNumber: 4,
                imageData: new Uint8Array([4]),
                languages: ['eng'],
                imageWidth: 1200,
                imageHeight: 1600,
            },
            {
                pageNumber: 5,
                imageData: new Uint8Array([5]),
                languages: ['eng'],
                imageWidth: 1200,
                imageHeight: 1600,
            },
        ], 'request-1');

        expect(createWorkerMock).toHaveBeenCalledTimes(2);
        expect(maxActiveJobs).toBe(2);
        expect(result.errors).toEqual([]);
        expect(Object.keys(result.results)).toHaveLength(5);
    });

    it('falls back to one worker for very large rendered pages', async () => {
        const { browserOcrCapability } = await import('@app/platform/browser-api/ocrCapability');
        await browserOcrCapability.recognizeBatch([
            {
                pageNumber: 1,
                imageData: new Uint8Array([1]),
                languages: ['eng'],
                imageWidth: 4000,
                imageHeight: 3000,
            },
            {
                pageNumber: 2,
                imageData: new Uint8Array([2]),
                languages: ['eng'],
                imageWidth: 4000,
                imageHeight: 3000,
            },
            {
                pageNumber: 3,
                imageData: new Uint8Array([3]),
                languages: ['eng'],
                imageWidth: 4000,
                imageHeight: 3000,
            },
        ], 'request-2');

        expect(createWorkerMock).toHaveBeenCalledTimes(1);
    });

    it('terminates already-created workers if browser OCR worker creation fails', async () => {
        vi.stubGlobal('navigator', {
            hardwareConcurrency: 6,
            deviceMemory: 8,
        });
        const terminateCreatedWorker = vi.fn(async () => {});
        createWorkerMock
            .mockResolvedValueOnce({ terminate: terminateCreatedWorker })
            .mockRejectedValueOnce(new Error('worker boot failed'));

        const { browserOcrCapability } = await import('@app/platform/browser-api/ocrCapability');

        await expect(browserOcrCapability.recognizeBatch([
            {
                pageNumber: 1,
                imageData: new Uint8Array([1]),
                languages: ['eng'],
                imageWidth: 1200,
                imageHeight: 1600,
            },
            {
                pageNumber: 2,
                imageData: new Uint8Array([2]),
                languages: ['eng'],
                imageWidth: 1200,
                imageHeight: 1600,
            },
        ], 'request-worker-failure')).rejects.toThrow('worker boot failed');

        expect(terminateCreatedWorker).toHaveBeenCalledTimes(1);
        expect(terminateSchedulerMock).toHaveBeenCalledTimes(1);
        expect(addWorkerMock).not.toHaveBeenCalled();
    });

    it('reports active processing pages while browser OCR runs in parallel', async () => {
        vi.stubGlobal('navigator', {
            hardwareConcurrency: 6,
            deviceMemory: 8,
        });

        const processingSnapshots: Array<{
            activePages: number[] | null | undefined;
            processedCount: number;
            phaseProgress: number | null | undefined;
        }> = [];

        let activeJobs = 0;
        addJobMock.mockImplementation(async (_action, _image, _options, _output, jobId) => {
            activeJobs += 1;
            await delay(activeJobs === 1 ? 8 : 4);
            activeJobs -= 1;
            return { data: {
                text: `recognized ${jobId}`,
                blocks: [],
            } };
        });

        const { browserOcrCapability } = await import('@app/platform/browser-api/ocrCapability');
        const unsubscribe = browserOcrCapability.onProgress((progress) => {
            if (progress.phase === 'processing') {
                processingSnapshots.push({
                    activePages: progress.activePages,
                    processedCount: progress.processedCount,
                    phaseProgress: progress.phaseProgress,
                });
            }
        });

        try {
            await browserOcrCapability.recognizeBatch([
                {
                    pageNumber: 1,
                    imageData: new Uint8Array([1]),
                    languages: ['eng'],
                    imageWidth: 1200,
                    imageHeight: 1600,
                },
                {
                    pageNumber: 2,
                    imageData: new Uint8Array([2]),
                    languages: ['eng'],
                    imageWidth: 1200,
                    imageHeight: 1600,
                },
                {
                    pageNumber: 3,
                    imageData: new Uint8Array([3]),
                    languages: ['eng'],
                    imageWidth: 1200,
                    imageHeight: 1600,
                },
            ], 'request-3');
        } finally {
            unsubscribe();
        }

        expect(processingSnapshots.some(snapshot => snapshot.activePages?.length === 2)).toBe(true);
        expect(processingSnapshots.at(-1)).toEqual(expect.objectContaining({
            activePages: [],
            processedCount: 3,
            phaseProgress: 100,
        }));
    });

    it('preinstalls requested languages without starting OCR recognition', async () => {
        const {
            browserOcrCapability,
            getBrowserOcrLanguages,
        } = await import('@app/platform/browser-api/ocrCapability');

        const progressEvents: Array<{
            languageCode?: string | null;
            phase?: string;
        }> = [];
        const unsubscribe = browserOcrCapability.onProgress((progress) => {
            progressEvents.push({
                ...(progress.languageCode === undefined ? {} : { languageCode: progress.languageCode }),
                ...(progress.phase === undefined ? {} : { phase: progress.phase }),
            });
        });

        try {
            const result = await browserOcrCapability.installLanguages([
                'eng',
                'fra',
                'fra',
            ], 'install-1');

            expect(result.errors).toEqual([]);
            expect(result.installed).toEqual([
                'eng',
                'fra',
            ]);
            expect(progressEvents.some(event => event.phase === 'preparing')).toBe(true);
        } finally {
            unsubscribe();
        }

        const languages = await getBrowserOcrLanguages();
        expect(languages.find(language => language.code === 'fra')?.installed).toBe(true);
        expect(addJobMock).not.toHaveBeenCalled();
    });
});
