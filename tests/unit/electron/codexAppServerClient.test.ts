import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const mocks = vi.hoisted(() => ({
    spawn: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

interface IFakeStdin extends EventEmitter {write: ReturnType<typeof vi.fn>;}

class FakeCodexAppServerProcess extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stdin = new EventEmitter() as IFakeStdin;

    readonly kill = vi.fn(() => {
        this.emit('close', 0);
        return true;
    });

    constructor(write: (line: string, callback?: (error?: Error | null) => void) => boolean) {
        super();
        this.stdin.write = vi.fn(write);
    }
}

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('electron', () => ({app: {getVersion: () => '0.0.0-test'}}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

async function createClient(process: FakeCodexAppServerProcess) {
    mocks.spawn.mockReturnValue(process);
    const { CodexAppServerClient } = await import('@electron/features/agent/codexAppServerClient');
    const onNotification = vi.fn();
    const onExit = vi.fn();
    const client = new CodexAppServerClient(
        '/usr/bin/codex',
        {},
        '/tmp',
        onNotification,
        onExit,
    );
    return {
        client,
        onExit,
    };
}

describe('CodexAppServerClient stdin handling', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('fails pending requests when the app-server stdin stream errors', async () => {
        const process = new FakeCodexAppServerProcess((_line, callback) => {
            callback?.();
            return true;
        });
        const {
            client,
            onExit,
        } = await createClient(process);

        const request = client.request('thread/start', {});
        process.stdin.emit('error', new Error('EPIPE'));

        await expect(request).rejects.toThrow('Codex app-server stdin failed: EPIPE');
        expect(onExit).toHaveBeenCalledWith('Codex app-server stdin failed: EPIPE');
    });

    it.each([
        ['notify' as const],
        ['respond' as const],
    ])('handles %s write callback failures without throwing', async (method) => {
        const process = new FakeCodexAppServerProcess((_line, callback) => {
            callback?.(new Error('EPIPE'));
            return false;
        });
        const {
            client,
            onExit,
        } = await createClient(process);

        if (method === 'notify') {
            expect(() => client.notify('initialized')).not.toThrow();
        } else {
            expect(() => client.respond(1, null)).not.toThrow();
        }

        expect(onExit).toHaveBeenCalledWith(expect.stringContaining('EPIPE'));
    });
});
