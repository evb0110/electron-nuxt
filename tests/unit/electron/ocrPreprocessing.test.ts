import { EventEmitter } from 'node:events';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    spawn: vi.fn(),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('electron', () => ({app: {isPackaged: false}}));
vi.mock('child_process', () => ({spawn: (...args: unknown[]) => mocks.spawn(...args)}));
vi.mock('fs', () => ({existsSync: (path: string) => mocks.existsSync(path)}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => mocks.logger}));

describe('validatePreprocessingSetup', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.existsSync.mockImplementation((path: string) => path.includes('unpaper') || path.includes('leptonica'));
        mocks.spawn.mockImplementation(() => {
            const proc = new EventEmitter() as EventEmitter & {kill: (...args: string[]) => boolean;};
            proc.kill = vi.fn(() => true);
            queueMicrotask(() => {
                proc.emit('close', 0);
            });
            return proc;
        });
    });

    it('caches the async probe result across repeated validations', async () => {
        const { validatePreprocessingSetup } = await import('@electron/ocr/preprocessing');

        const first = validatePreprocessingSetup();
        const second = validatePreprocessingSetup();

        await expect(first).resolves.toMatchObject({
            valid: true,
            available: [
                'unpaper',
                'leptonica',
            ],
            missing: [],
        });
        await expect(second).resolves.toMatchObject({
            valid: true,
            available: [
                'unpaper',
                'leptonica',
            ],
            missing: [],
        });

        expect(mocks.spawn).toHaveBeenCalledTimes(1);
        expect(mocks.spawn).toHaveBeenCalledWith(
            expect.stringContaining('unpaper'),
            ['--version'],
            expect.objectContaining({
                detached: process.platform !== 'win32',
                shell: false,
                windowsHide: true,
                stdio: 'ignore',
            }),
        );
    });
});
