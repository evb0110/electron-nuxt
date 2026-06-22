import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import { IMAGE_EXPORT_EVENT_CHANNELS } from '@electron/features/image-export';
import type * as ImageExportPreloadClientModule from '@electron/features/image-export/createImageExportPreloadClient';
import { cast } from '@tests/helpers/cast';

describe('createImageExportPreloadClient', () => {
    it('drops malformed image-export progress events before callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return cast<IpcRenderer>(ipcRenderer);
            }),
            removeListener: vi.fn(),
        };
        const { createImageExportPreloadClient }: typeof ImageExportPreloadClientModule = await import('@electron/features/image-export/createImageExportPreloadClient');
        const client = createImageExportPreloadClient(cast<IpcRenderer>(ipcRenderer));
        const callback = vi.fn();

        client.onProgress(callback);
        listeners.get(IMAGE_EXPORT_EVENT_CHANNELS.progress)?.({}, {
            requestId: 'export-1',
            format: 'images',
            phase: 'rendering',
            processed: 1,
            total: 4,
            percent: 25,
        });
        listeners.get(IMAGE_EXPORT_EVENT_CHANNELS.progress)?.({}, {
            requestId: 'export-2',
            format: 'images',
            phase: 'rendering',
            processed: '1',
            total: 4,
            percent: 25,
        });
        listeners.get(IMAGE_EXPORT_EVENT_CHANNELS.progress)?.({}, {
            requestId: 'export-3',
            format: 'bad',
            phase: 'rendering',
            processed: 1,
            total: 4,
            percent: 25,
        });

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({
            requestId: 'export-1',
            format: 'images',
            phase: 'rendering',
            processed: 1,
            total: 4,
            percent: 25,
        });
    });
});
