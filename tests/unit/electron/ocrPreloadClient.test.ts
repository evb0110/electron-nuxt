import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { OCR_CHANNELS } from '@electron/features/ocr/contract';
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
});
