import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';

interface ITestInvokeMap {
    'native:slow': {
        args: [value: string];
        result: string;
    };
    'regular:slow': {
        args: [];
        result: string;
    };
}

describe('createTypedIpcInvoker timeout policy', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects configured channels with channel-scoped timeout context', async () => {
        vi.useFakeTimers();
        const ipcRenderer: Pick<IpcRenderer, 'invoke'> = {invoke: vi.fn(() => new Promise(() => {}))};
        const invoke = createTypedIpcInvoker<ITestInvokeMap>(ipcRenderer, {invokeTimeoutMsByChannel: {'native:slow': 250}});

        const pending = invoke('native:slow', 'payload');
        const assertion = expect(pending).rejects.toMatchObject({
            name: 'PlatformIpcInvokeError',
            channel: 'native:slow',
            message: 'IPC invoke timed out after 250ms for native:slow',
            cause: {
                name: 'IpcInvokeTimeoutError',
                channel: 'native:slow',
                timeoutMs: 250,
            },
        });
        await vi.advanceTimersByTimeAsync(250);

        await assertion;
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('native:slow', 'payload');
    });

    it('leaves unconfigured channels without a renderer-side timeout', async () => {
        vi.useFakeTimers();
        const ipcRenderer: Pick<IpcRenderer, 'invoke'> = {invoke: vi.fn(() => new Promise(() => {}))};
        const invoke = createTypedIpcInvoker<ITestInvokeMap>(ipcRenderer);
        const rejected = vi.fn();

        void invoke('regular:slow').catch(rejected);
        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.resolve();

        expect(rejected).not.toHaveBeenCalled();
        expect(ipcRenderer.invoke).toHaveBeenCalledWith('regular:slow');
    });
});
