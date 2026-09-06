import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({runNativeCommand: vi.fn()}));

vi.mock('@electron/features/djvu/main/buildDjvuRuntimeEnv', () => ({buildDjvuRuntimeEnv: () => ({})}));
vi.mock('@electron/features/djvu/main/nativeToolPaths', () => ({getDjvuNativeToolPaths: () => ({djvused: '/tools/djvused'})}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({debug: vi.fn()})}));
vi.mock('@electron/features/djvu/main/getCachedDjvuHasText', () => ({getCachedDjvuHasText: vi.fn()}));

const {getDjvuPageCount} = await import('@electron/features/djvu/main/metadata');

describe('DjVu metadata', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('accepts page counts beyond the former desktop product cap', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '100001\n',
            stderr: '',
            exitCode: 0,
        });

        await expect(getDjvuPageCount('/tmp/xlarge.djvu')).resolves.toBe(100_001);
    });

    it('rejects page counts outside the JavaScript safe-integer range', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            stdout: '9007199254740992\n',
            stderr: '',
            exitCode: 0,
        });

        await expect(getDjvuPageCount('/tmp/unsafe.djvu'))
            .rejects.toThrow('Invalid page count from djvused');
    });
});
