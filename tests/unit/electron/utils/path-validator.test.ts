import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    tempDir: '/tmp/electron-test',
    existsSync: vi.fn<(path: string) => boolean>(),
    lstatSync: vi.fn<(path: string) => { isSymbolicLink: () => boolean; }>(),
    realpathSync: vi.fn<(path: string) => string>(),
}));

function createStat(isSymlink: boolean) {
    return {isSymbolicLink: () => isSymlink};
}

vi.mock('electron', () => ({app: {getPath: (name: string) => {
    if (name !== 'temp') {
        throw new Error(`Unknown path name: ${name}`);
    }
    return mocks.tempDir;
}}}));

vi.mock('fs', () => ({
    existsSync: (path: string) => mocks.existsSync(path),
    lstatSync: (path: string) => mocks.lstatSync(path),
    realpathSync: (path: string) => mocks.realpathSync(path),
}));

const {
    isAllowedReadPath,
    isAllowedWritePath,
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} = await import('@electron/utils/path-validator');

beforeEach(() => {
    mocks.tempDir = '/tmp/electron-test';
    mocks.existsSync.mockReset();
    mocks.lstatSync.mockReset();
    mocks.realpathSync.mockReset();

    mocks.existsSync.mockReturnValue(true);
    mocks.lstatSync.mockReturnValue(createStat(false));
    mocks.realpathSync.mockImplementation((path: string) => path);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('isAllowedWritePath', () => {
    it('allows a file inside the temp directory', () => {
        expect(isAllowedWritePath('/tmp/electron-test/output.pdf')).toBe(true);
    });

    it('rejects symlink targets', () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        expect(isAllowedWritePath('/tmp/electron-test/symlink-output.pdf')).toBe(false);
    });
});

describe('isAllowedReadPath', () => {
    it('allows a regular file inside the temp directory', () => {
        expect(isAllowedReadPath('/tmp/electron-test/document.pdf')).toBe(true);
    });

    it('accepts canonical temp directory paths', () => {
        mocks.tempDir = '/tmp/electron-test';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === '/tmp/electron-test') {
                return '/private/tmp/electron-test';
            }
            return path;
        });

        expect(isAllowedReadPath('/private/tmp/electron-test/document.pdf')).toBe(true);
    });

    it('accepts Windows native paths inside the temp directory', () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp';
            }
            return path;
        });

        expect(isAllowedReadPath('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf'))
            .toBe(true);
    });

    it('rejects symlink targets', () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        expect(isAllowedReadPath('/tmp/electron-test/symlink-document.pdf')).toBe(false);
    });

    it('rejects missing files', () => {
        mocks.existsSync.mockReturnValue(false);

        expect(isAllowedReadPath('/tmp/electron-test/missing.pdf')).toBe(false);
    });
});

describe('resolveAllowedReadPath', () => {
    it('rejects symlink targets', async () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        await expect(resolveAllowedReadPath('/tmp/electron-test/symlink.pdf')).resolves.toBeNull();
        expect(mocks.realpathSync).toHaveBeenCalledWith('/tmp/electron-test');
        expect(mocks.realpathSync).not.toHaveBeenCalledWith('/tmp/electron-test/symlink.pdf');
    });

    it('allows temp paths when canonical temp dir differs', async () => {
        mocks.tempDir = '/var/folders/abc/T';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === '/var/folders/abc/T') {
                return '/private/var/folders/abc/T';
            }
            if (path === '/var/folders/abc/T/file.pdf') {
                return '/private/var/folders/abc/T/file.pdf';
            }
            return path;
        });

        await expect(resolveAllowedReadPath('/var/folders/abc/T/file.pdf')).resolves.toBe('/private/var/folders/abc/T/file.pdf');
    });

    it('allows Windows paths when realpath returns native namespaced paths', async () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp';
            }
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf';
            }
            return path;
        });

        await expect(resolveAllowedReadPath('C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf'))
            .resolves.toBe('\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\work.pdf');
    });
});

describe('resolveAllowedWritePath', () => {
    it('rejects symlink targets', async () => {
        mocks.lstatSync.mockReturnValue(createStat(true));

        await expect(resolveAllowedWritePath('/tmp/electron-test/symlink-write.pdf')).resolves.toBeNull();
        expect(mocks.realpathSync).toHaveBeenCalledWith('/tmp/electron-test');
        expect(mocks.realpathSync).not.toHaveBeenCalledWith('/tmp/electron-test/symlink-write.pdf');
    });

    it('allows missing Windows targets whose real parent is the temp directory', async () => {
        mocks.tempDir = 'C:\\Users\\Alice\\AppData\\Local\\Temp';
        mocks.lstatSync.mockImplementation((path: string) => {
            if (path.endsWith('\\new-output.pdf')) {
                throw new Error('missing');
            }
            return createStat(false);
        });
        mocks.realpathSync.mockImplementation((path: string) => {
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp';
            }
            if (path === 'C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1') {
                return '\\\\?\\C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1';
            }
            return path;
        });

        await expect(resolveAllowedWritePath('C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\new-output.pdf'))
            .resolves.toBe('C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\new-output.pdf');
    });
});
