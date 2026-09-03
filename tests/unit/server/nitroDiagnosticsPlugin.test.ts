import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {H3Event} from 'h3';
import type {IServerFailureReporter} from '@server/utils/serverFailureReporter';

interface IRegisteredHook {
    readonly handler: (error: Error, context: {readonly event?: H3Event}) => void;
    readonly name: string;
}

function createReporterMock() {
    return {
        capture: vi.fn<IServerFailureReporter['capture']>(),
        captureRecord: vi.fn<IServerFailureReporter['captureRecord']>(),
        captureUncaught: vi.fn<IServerFailureReporter['captureUncaught']>(),
        getHealthSnapshot: vi.fn<IServerFailureReporter['getHealthSnapshot']>(),
        isTransportReady: vi.fn<IServerFailureReporter['isTransportReady']>(),
    } satisfies IServerFailureReporter;
}

describe('viewer Nitro diagnostics plugin', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin);
    });

    it('registers one error owner per Nitro app', async () => {
        const {registerNitroDiagnostics} = await import('@server/plugins/diagnostics');
        const hooks: IRegisteredHook[] = [];
        const app = {hooks: {hook: vi.fn((name: string, handler: IRegisteredHook['handler']) => {
            hooks.push({
                name,
                handler,
            });
        })}};
        const reporter = createReporterMock();

        registerNitroDiagnostics(app, reporter);
        registerNitroDiagnostics(app, reporter);

        expect(app.hooks.hook).toHaveBeenCalledOnce();
        expect(hooks).toHaveLength(1);
        expect(hooks[0]?.name).toBe('error');
    });

    it('passes only the owned error and optional event to the reporter', async () => {
        const {registerNitroDiagnostics} = await import('@server/plugins/diagnostics');
        const hook = vi.fn();
        const app = {hooks: {hook}};
        const reporter = createReporterMock();
        const error = new Error('raw request-adjacent detail');
        const event = {} as H3Event;

        registerNitroDiagnostics(app, reporter);
        const registeredHandler = hook.mock.calls[0]?.[1] as IRegisteredHook['handler'];
        registeredHandler(error, {event});

        expect(reporter.captureUncaught).toHaveBeenCalledWith(error, event);
    });

    it('exports a callable default Nitro plugin', async () => {
        const plugin = (await import('@server/plugins/diagnostics')).default;
        expect(plugin).toBeTypeOf('function');
    });
});
