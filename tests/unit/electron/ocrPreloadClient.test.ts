import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    OCR_CHANNELS,
    OCR_EVENT_CHANNELS,
} from '@electron/features/ocr/contract';
import type { IpcRenderer } from 'electron';
import type * as OcrPreloadClientModule from '@electron/features/ocr/createOcrPreloadClient';

describe('createOcrPreloadClient', () => {
    it('does not report language installation success when only validation is available', async () => {
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === OCR_CHANNELS.validateTools) {
                    return {
                        valid: true,
                        tools: {},
                        errors: [],
                    };
                }
                throw new Error(`Unexpected channel: ${channel}`);
            }),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const { createOcrPreloadClient }: typeof OcrPreloadClientModule = await import('@electron/features/ocr/createOcrPreloadClient');

        await expect(createOcrPreloadClient(ipcRenderer as IpcRenderer).installLanguages(['eng'], 'request-1'))
            .resolves.toMatchObject({
                started: false,
                jobId: 'request-1',
                installed: [],
                error: 'OCR language installation is not available from the renderer; validateTools only reports installed languages.',
            });
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(OCR_CHANNELS.validateTools);
    });

    it('drops malformed OCR progress and complete events before callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return ipcRenderer as IpcRenderer;
            }),
            removeListener: vi.fn(),
        };
        const { createOcrPreloadClient }: typeof OcrPreloadClientModule = await import('@electron/features/ocr/createOcrPreloadClient');
        const client = createOcrPreloadClient(ipcRenderer as IpcRenderer);
        const progressCallback = vi.fn();
        const completeCallback = vi.fn();

        client.onProgress(progressCallback);
        client.onComplete(completeCallback);
        listeners.get(OCR_EVENT_CHANNELS.progress)?.({}, {
            requestId: 'ocr-1',
            currentPage: 1,
            processedCount: 1,
            totalPages: 2,
            phase: 'processing',
        });
        listeners.get(OCR_EVENT_CHANNELS.progress)?.({}, {
            requestId: 'ocr-2',
            currentPage: '1',
            processedCount: 1,
            totalPages: 2,
        });
        listeners.get(OCR_EVENT_CHANNELS.complete)?.({}, {
            requestId: 'ocr-1',
            success: true,
            pdfPath: '/tmp/out.pdf',
            requiresCleanupAck: true,
            errors: [],
        });
        listeners.get(OCR_EVENT_CHANNELS.complete)?.({}, {
            requestId: 'ocr-2',
            success: true,
            errors: [42],
        });
        listeners.get(OCR_EVENT_CHANNELS.complete)?.({}, {
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
        listeners.get(OCR_EVENT_CHANNELS.complete)?.({}, {
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

        expect(progressCallback).toHaveBeenCalledTimes(1);
        expect(progressCallback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'ocr-1',
            currentPage: 1,
        }));
        expect(completeCallback).toHaveBeenCalledTimes(2);
        expect(completeCallback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'ocr-1',
            pdfPath: '/tmp/out.pdf',
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
    });
});
