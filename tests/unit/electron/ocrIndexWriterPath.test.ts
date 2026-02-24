import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    lstat: vi.fn<(path: string) => Promise<{ isSymbolicLink: () => boolean }>>(),
    realpath: vi.fn<(path: string) => Promise<string>>(),
}));

function createStat(isSymlink: boolean) {
    return {isSymbolicLink: () => isSymlink};
}

vi.mock('fs/promises', () => ({
    lstat: (path: string) => mocks.lstat(path),
    realpath: (path: string) => mocks.realpath(path),
    mkdir: vi.fn(),
    rename: vi.fn(),
    writeFile: vi.fn(),
}));

const { resolveSafeOcrIndexBasePath } = await import('@electron/ocr/worker/index-writer');

describe('resolveSafeOcrIndexBasePath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.lstat.mockResolvedValue(createStat(false));
        mocks.realpath.mockImplementation(async (path: string) => path);
    });

    it('accepts existing non-symlink targets inside temp dir', async () => {
        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).resolves.toBe('/tmp/work.pdf');
    });

    it('rejects targets outside temp dir', async () => {
        await expect(resolveSafeOcrIndexBasePath('/Users/alice/work.pdf', '/tmp')).rejects.toThrow(
            'outside the allowed temp directory',
        );
    });

    it('rejects symlink targets', async () => {
        mocks.lstat.mockResolvedValue(createStat(true));

        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).rejects.toThrow(
            'cannot be a symbolic link',
        );
    });

    it('accepts canonicalized temp paths', async () => {
        mocks.realpath.mockImplementation(async (path: string) => {
            if (path === '/tmp') {
                return '/private/tmp';
            }
            if (path === '/tmp/work.pdf') {
                return '/private/tmp/work.pdf';
            }
            if (path === '/private/tmp') {
                return '/private/tmp';
            }
            if (path === '/private/tmp/work.pdf') {
                return '/private/tmp/work.pdf';
            }
            return path;
        });

        await expect(resolveSafeOcrIndexBasePath('/tmp/work.pdf', '/tmp')).resolves.toBe('/private/tmp/work.pdf');
    });
});
