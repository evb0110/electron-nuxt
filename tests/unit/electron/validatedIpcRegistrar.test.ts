import type { IpcMainInvokeEvent } from 'electron';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IIpcMainRegistrar } from '@contracts/ipcMain';

const mocks = vi.hoisted(() => ({
    isTrustedIpcInvokeSender: vi.fn(() => true),
    isTrustedWebContentsSender: vi.fn(() => true),
}));

vi.mock('@electron/platform-ipc/trustedIpcSender', () => mocks);

type TRegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function createNativeRegistrar() {
    const handlers = new Map<string, TRegisteredHandler>();
    const handle = vi.fn((channel: string, handler: TRegisteredHandler) => {
        handlers.set(channel, handler);
    });
    const registrar: IIpcMainRegistrar<never, IpcMainInvokeEvent> = {handle: handle as IIpcMainRegistrar<never, IpcMainInvokeEvent>['handle']};

    return {
        handle,
        handlers,
        registrar,
    };
}

describe('validated IPC registrar argument policy', () => {
    it('rejects invoke handlers without a decoder or explicit allowlist entry', async () => {
        const { createValidatedIpcMainRegistrar } = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {allowedChannels: new Set(['test:requires-decoder'])});

        expect(() => {
            registrar.handle('test:requires-decoder', (_event, value: string) => value);
        }).toThrow('IPC invoke channel registered without an argument decoder or explicit no-arg/validated allowlist: test:requires-decoder');
        expect(native.handle).not.toHaveBeenCalled();
    });

    it('allows decoded invoke handlers and wraps decoder failures with channel context', async () => {
        const { createValidatedIpcMainRegistrar } = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {allowedChannels: new Set(['test:decoded'])});

        registrar.handle('test:decoded', (_event, value: string) => value, {decode: args => {
            if (typeof args[0] !== 'string') {
                throw new Error('value must be a string');
            }
            return [args[0]] as [value: string];
        }});

        const handler = native.handlers.get('test:decoded');
        expect(handler).toBeTypeOf('function');
        await expect(handler?.({} as IpcMainInvokeEvent, 'ok')).resolves.toBe('ok');
        await expect(handler?.({} as IpcMainInvokeEvent, 42))
            .rejects
            .toThrow('Invalid IPC arguments for test:decoded: value must be a string');
    });

    it('allows explicitly no-argument invoke handlers and rejects runtime arguments', async () => {
        const { createValidatedIpcMainRegistrar } = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {
            allowedChannels: new Set(['test:no-args']),
            argumentValidation: {noArgumentChannels: new Set(['test:no-args'])},
        });
        const handler = vi.fn(() => 'ok');

        registrar.handle('test:no-args', handler);

        const registeredHandler = native.handlers.get('test:no-args');
        expect(registeredHandler).toBeTypeOf('function');
        await expect(registeredHandler?.({} as IpcMainInvokeEvent)).resolves.toBe('ok');
        await expect(registeredHandler?.({} as IpcMainInvokeEvent, 'unexpected'))
            .rejects
            .toThrow('Invalid IPC arguments for test:no-args: expected no arguments');
        expect(handler).toHaveBeenCalledOnce();
    });

    it('allows explicitly validated invoke handlers to keep handler-owned validation', async () => {
        const { createValidatedIpcMainRegistrar } = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();
        const registrar = createValidatedIpcMainRegistrar(native.registrar, {
            allowedChannels: new Set(['test:validated-in-handler']),
            argumentValidation: {channelsValidatedWithoutRegistrarDecoder: new Set(['test:validated-in-handler'])},
        });

        registrar.handle('test:validated-in-handler', (_event, value: string) => value);

        const handler = native.handlers.get('test:validated-in-handler');
        expect(handler).toBeTypeOf('function');
        await expect(handler?.({} as IpcMainInvokeEvent, 'kept-raw')).resolves.toBe('kept-raw');
    });

    it('rejects policy entries outside the registrar channel allowlist', async () => {
        const { createValidatedIpcMainRegistrar } = await import('@electron/platform-ipc/validatedIpcRegistrar');
        const native = createNativeRegistrar();

        expect(() => createValidatedIpcMainRegistrar(native.registrar, {
            allowedChannels: new Set(['test:known']),
            argumentValidation: {noArgumentChannels: new Set(['test:typo'])},
        })).toThrow('IPC argument validation policy contains unknown invoke channel: test:typo');
    });
});
