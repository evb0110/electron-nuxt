import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    OCR_PLATFORM_FEATURE,
    OCR_PREPROCESSING_PLATFORM_FEATURE,
} from '@contracts/ocrPlatformFeature';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';
import type { IpcRenderer } from 'electron';

const channels = OCR_PLATFORM_FEATURE.invokeChannels;
const eventChannels = OCR_PLATFORM_FEATURE.eventChannels;

describe('OCR platform feature', () => {
    it('preserves channels, timeouts, optional members, and registry replay policy', () => {
        expect(channels).toEqual({
            recognize: 'ocr:recognize',
            recognizeBatch: 'ocr:recognizeBatch',
            cancel: 'ocr:cancel',
            getJobState: 'ocr:job:get-state',
            subscribeJob: 'ocr:job:subscribe',
            reconnectJob: 'ocr:job:reconnect',
            getLanguages: 'ocr:getLanguages',
            resolveDocumentTextCatalog: 'ocr:resolveDocumentTextCatalog',
            resolveDocumentOcrAvailability: 'ocr:resolveDocumentOcrAvailability',
            resolveDocumentOcrPage: 'ocr:resolveDocumentOcrPage',
            validateTools: 'ocr:validateTools',
            acknowledgeResultFile: 'ocr:ackResultFile',
            createSearchablePdf: 'ocr:createSearchablePdf',
            subscribeProgress: 'ocr:progress:subscribe',
        });
        expect(OCR_PREPROCESSING_PLATFORM_FEATURE.invokeChannels).toEqual({
            validate: 'preprocessing:validate',
            preprocessPage: 'preprocessing:preprocessPage',
        });
        expect(eventChannels).toEqual({
            onProgress: 'ocr:progress',
            onComplete: 'ocr:complete',
        });
        expect(OCR_PLATFORM_FEATURE.methods.resolveDocumentOcrAvailability)
            .toMatchObject({
                optionalWhenImplemented: true,
                required: {
                    browser: false,
                    electron: false,
                },
            });
        expect(OCR_PLATFORM_FEATURE.methods.resolveDocumentOcrPage)
            .toMatchObject({optionalWhenImplemented: true});
        expect(OCR_PLATFORM_FEATURE.methods.createSearchablePdf.ipc.timeoutMs)
            .toBe(30 * 60 * 1_000);
        expect(
            OCR_PREPROCESSING_PLATFORM_FEATURE.methods.preprocessPage.ipc.timeoutMs,
        ).toBe(30 * 60 * 1_000);
        const replay = OCR_PLATFORM_FEATURE.events.onProgress.subscription.replay;
        expect(replay).toMatchObject({
            intervalMs: 50,
            mode: 'latest-per-key',
            owner: 'ipc-progress-pump',
            terminalRetentionMs: 30_000,
        });
        expect(replay.key({
            requestId: 'ocr-1',
            currentPage: 1,
            processedCount: 0,
            totalPages: 1,
        })).toBe('ocr-1');
        expect(replay.terminal({
            requestId: 'ocr-1',
            currentPage: 1,
            processedCount: 1,
            totalPages: 1,
            status: 'success',
        })).toBe(true);
    });

    it('decodes OCR languages and rejects malformed nested language entries', async () => {
        let result: unknown = [
            {
                code: 'eng',
                script: 'latin',
            },
            {
                code: 'ara',
                script: 'rtl',
            },
        ];
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(async () => result),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer as IpcRenderer,
            OCR_PLATFORM_FEATURE,
        );

        await expect(client.getLanguages()).resolves.toEqual(result);

        for (result of [
            {
                code: 'eng',
                script: 'latin',
            },
            [{
                code: 'ENG',
                script: 'latin',
            }],
            [{
                code: 'eng',
                script: 'future-script',
            }],
            [
                {
                    code: 'eng',
                    script: 'latin',
                },
                {
                    code: 'eng',
                    script: 'latin',
                },
            ],
        ]) {
            await expect(client.getLanguages()).rejects.toThrow(
                'invalid OCR languages IPC result',
            );
        }
    });

    it('drops malformed OCR progress and converts malformed completions to failure callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return ipcRenderer as IpcRenderer;
            }),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(
            ipcRenderer as IpcRenderer,
            OCR_PLATFORM_FEATURE,
        );
        const progressCallback = vi.fn();
        const completeCallback = vi.fn();

        client.onProgress(progressCallback);
        client.onComplete(completeCallback);
        listeners.get(eventChannels.onProgress)?.({}, {
            requestId: 'ocr-1',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'processing',
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            requestId: 'ocr-2',
            currentPage: '1',
            processedCount: 1,
            totalPages: 2,
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            requestId: 'ocr-3',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'not-a-contract-phase',
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-1',
            success: true,
            pdfPath: '/tmp/out.pdf',
            sourceDocumentRevisionToken: 'source-revision-token',
            resultSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            requiresCleanupAck: true,
            errors: [],
            diagnostics: [{
                code: 'OCR_SOURCE_DPI_LIMITED',
                severity: 'info',
                message: 'Source DPI was limited',
                pageNumber: 1,
            }],
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-2',
            success: true,
            errors: [42],
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-3',
            success: false,
            errors: ['OCR queue is full'],
            errorEnvelope: {
                code: 'OCR_QUEUE_BACKPRESSURE',
                message: 'OCR queue is full',
                retryable: true,
                timestamp: 123,
            },
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-4',
            success: false,
            errors: ['Malformed envelope'],
            errorEnvelope: {
                code: 'OCR_INTERNAL_ERROR',
                message: 'Malformed envelope',
                retryable: 'no',
                timestamp: 123,
            },
        });
        listeners.get(eventChannels.onComplete)?.({}, {
            requestId: 'ocr-5',
            success: true,
            pdfPath: '/tmp/out-without-token.pdf',
            requiresCleanupAck: true,
            errors: [],
        });

        expect(progressCallback).toHaveBeenCalledTimes(1);
        expect(progressCallback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'ocr-1',
            currentPage: 1,
        }));
        expect(completeCallback).toHaveBeenCalledTimes(5);
        expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'ocr-1',
            pdfPath: '/tmp/out.pdf',
            sourceDocumentRevisionToken: 'source-revision-token',
            resultSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            diagnostics: [expect.objectContaining({
                code: 'OCR_SOURCE_DPI_LIMITED',
                pageNumber: 1,
            })],
        }));
        expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'ocr-3',
            success: false,
            errorEnvelope: {
                code: 'OCR_QUEUE_BACKPRESSURE',
                message: 'OCR queue is full',
                retryable: true,
                timestamp: 123,
            },
        }));
        expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'ocr-2',
            success: false,
            errors: ['Malformed OCR completion payload'],
            errorEnvelope: expect.objectContaining({
                code: 'OCR_INVALID_PAYLOAD',
                message: 'Malformed OCR completion payload',
                retryable: false,
            }),
        }));
        expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'ocr-4',
            success: false,
            errors: ['Malformed OCR completion error envelope'],
            errorEnvelope: expect.objectContaining({
                code: 'OCR_INVALID_PAYLOAD',
                message: 'Malformed OCR completion error envelope',
                retryable: false,
            }),
        }));
        expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'ocr-5',
            success: false,
            errors: ['Malformed OCR completion payload'],
            errorEnvelope: expect.objectContaining({
                code: 'OCR_INVALID_PAYLOAD',
                message: 'Malformed OCR completion payload',
                retryable: false,
            }),
        }));
    });
});
