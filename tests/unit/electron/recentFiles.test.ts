import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as FsPromises from 'node:fs/promises';

const mocks = vi.hoisted(() => {
    const app = { getPath: vi.fn() };
    const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    };
    let actualStat: ((...args: unknown[]) => Promise<unknown>) | null = null;
    const stat = vi.fn((...args: unknown[]) => {
        if (!actualStat) {
            throw new Error('fs/promises stat mock was not initialized');
        }
        return actualStat(...args);
    });
    return {
        app,
        logger,
        resetStat: () => {
            stat.mockImplementation((...args: unknown[]) => {
                if (!actualStat) {
                    throw new Error('fs/promises stat mock was not initialized');
                }
                return actualStat(...args);
            });
        },
        setActualStat: (implementation: (...args: unknown[]) => Promise<unknown>) => {
            actualStat = implementation;
        },
        stat,
    };
});

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => mocks.logger }));
vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    mocks.setActualStat((...args: unknown[]) => actual.stat(...(args as Parameters<typeof actual.stat>)));
    mocks.resetStat();
    return {
        ...actual,
        stat: mocks.stat,
    };
});

async function loadRecentFilesModule() {
    vi.resetModules();
    return import('@electron/recentFiles');
}

describe('recentFiles persistence', () => {
    let appDataDir = '';
    let userDataDir = '';

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE;
        delete process.env.EVB_RECENT_FILE_STAT_TIMEOUT_MS;
        mocks.resetStat();
        appDataDir = mkdtempSync(join(tmpdir(), 'evb-recentFiles-app-data-'));
        userDataDir = mkdtempSync(join(tmpdir(), 'evb-recentFiles-'));
        mocks.app.getPath.mockImplementation((name: string) => {
            if (name === 'appData') {
                return appDataDir;
            }

            if (name === 'userData') {
                return userDataDir;
            }

            return userDataDir;
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        rmSync(appDataDir, {
            recursive: true,
            force: true,
        });
        rmSync(userDataDir, {
            recursive: true,
            force: true,
        });
    });

    function writeFixture(name: string, contents = name) {
        const filePath = join(userDataDir, name);
        writeFileSync(filePath, contents);
        return filePath;
    }

    it('persists recent files across cache reinitialization and keeps the newest duplicate first', async () => {
        const fileA = writeFixture('alpha.pdf');
        const fileB = writeFixture('beta.pdf');

        let recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(fileA);
        await recentFiles.addRecentFile(fileB);
        await recentFiles.addRecentFile(fileA);

        expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([
            fileA,
            fileB,
        ]);
        expect(recentFiles.getRecentFilesSync()).toEqual([
            fileA,
            fileB,
        ]);

        recentFiles = await loadRecentFilesModule();
        expect(recentFiles.getRecentFilesSync()).toEqual([]);

        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([
            fileA,
            fileB,
        ]);
        expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([
            fileA,
            fileB,
        ]);
    });

    it('serializes concurrent additions without losing either persisted entry', async () => {
        const fileA = writeFixture('concurrent-alpha.pdf');
        const fileB = writeFixture('concurrent-beta.pdf');
        let recentFiles = await loadRecentFilesModule();

        await Promise.all([
            recentFiles.addRecentFile(fileA),
            recentFiles.addRecentFile(fileB),
        ]);

        expect(new Set(recentFiles.getRecentFilesSync())).toEqual(new Set([
            fileA,
            fileB,
        ]));
        recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();
        expect(new Set(recentFiles.getRecentFilesSync())).toEqual(new Set([
            fileA,
            fileB,
        ]));
    });

    it('preserves an existing target and removes staged data when atomic promotion fails', async () => {
        const filePath = writeFixture('atomic-failure.pdf');
        const storagePath = join(userDataDir, 'recentFiles.json');
        mkdirSync(storagePath);
        const recentFiles = await loadRecentFilesModule();

        await expect(recentFiles.addRecentFile(filePath)).rejects.toThrow();

        expect(readdirSync(storagePath)).toEqual([]);
        expect(readdirSync(userDataDir).sort()).toEqual([
            'atomic-failure.pdf',
            'recentFiles.json',
        ]);
    });

    it('quarantines malformed persisted JSON and writes a clean empty store', async () => {
        const storagePath = join(userDataDir, 'recentFiles.json');
        writeFileSync(storagePath, '{malformed');

        const recentFiles = await loadRecentFilesModule();

        await expect(recentFiles.getRecentFiles()).resolves.toEqual([]);
        expect(JSON.parse(readFileSync(storagePath, 'utf-8'))).toEqual({
            version: 1,
            files: [],
        });
        expect(readdirSync(userDataDir).some(name => /^recentFiles\.json\.\d+\.corrupt$/u.test(name))).toBe(true);
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Quarantined corrupt recent-files state'));
    });

    it('dedupes persisted recent files by path when rebuilding the cache from disk', async () => {
        const fileA = writeFixture('alpha.pdf');
        const fileB = writeFixture('beta.pdf');
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [
                {
                    originalPath: fileA,
                    fileName: 'alpha-new.pdf',
                    timestamp: 3,
                    fileSize: 5,
                },
                {
                    originalPath: fileB,
                    fileName: 'beta.pdf',
                    timestamp: 2,
                    fileSize: 4,
                },
                {
                    originalPath: fileA,
                    fileName: 'alpha-old.pdf',
                    timestamp: 1,
                    fileSize: 5,
                },
            ],
        }));

        const recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([
            fileA,
            fileB,
        ]);
        expect((await recentFiles.getRecentFiles()).map(file => file.fileName)).toEqual([
            'alpha-new.pdf',
            'beta.pdf',
        ]);
    });

    it('drops missing files when rebuilding the cache from disk', async () => {
        const filePath = writeFixture('stale.pdf');

        let recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(filePath);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);

        unlinkSync(filePath);

        recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([]);
        expect(await recentFiles.getRecentFiles()).toEqual([]);
    });

    it('clears persisted storage and the synchronous cache together', async () => {
        const filePath = writeFixture('clear-me.pdf');

        let recentFiles = await loadRecentFilesModule();
        await recentFiles.addRecentFile(filePath);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);

        await recentFiles.clearRecentFiles();

        expect(recentFiles.getRecentFilesSync()).toEqual([]);

        recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([]);
        expect(await recentFiles.getRecentFiles()).toEqual([]);
    });

    it('bootstraps the default interactive automation profile from canonical dev recents only once', async () => {
        process.env.EVB_AUTOMATION_BOOTSTRAP_DEV_PROFILE = '1';
        const filePath = writeFixture('bootstrap.pdf');
        const canonicalDir = join(appDataDir, 'EVB Viewer Dev');
        mkdirSync(canonicalDir, { recursive: true });
        writeFileSync(join(canonicalDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [{
                originalPath: filePath,
                fileName: 'bootstrap.pdf',
                timestamp: 123,
                fileSize: 9,
            }],
        }, null, 2));

        let recentFiles = await loadRecentFilesModule();
        expect((await recentFiles.getRecentFiles()).map(file => file.originalPath)).toEqual([filePath]);

        const persisted = JSON.parse(readFileSync(join(userDataDir, 'recentFiles.json'), 'utf-8')) as { files: Array<{ originalPath: string }>; };
        expect(persisted.files.map(file => file.originalPath)).toEqual([filePath]);

        await recentFiles.clearRecentFiles();

        recentFiles = await loadRecentFilesModule();
        await recentFiles.initRecentFilesCache();

        expect(recentFiles.getRecentFilesSync()).toEqual([]);
        expect(await recentFiles.getRecentFiles()).toEqual([]);
    });

    it('keeps timed-out recent paths without waiting indefinitely for stat', async () => {
        vi.stubEnv('EVB_RECENT_FILE_STAT_TIMEOUT_MS', '100');
        const filePath = join(userDataDir, 'network-share.pdf');
        writeFileSync(join(userDataDir, 'recentFiles.json'), JSON.stringify({
            version: 1,
            files: [{
                originalPath: filePath,
                fileName: 'network-share.pdf',
                timestamp: 123,
                fileSize: 9,
            }],
        }));
        mocks.stat.mockImplementation((path: unknown) => {
            if (path === filePath) {
                return new Promise(() => {});
            }
            return Promise.reject(new Error(`Unexpected stat path: ${path}`));
        });

        const recentFiles = await loadRecentFilesModule();
        await expect(recentFiles.getRecentFiles()).resolves.toMatchObject([{
            originalPath: filePath,
            fileName: 'network-share.pdf',
        }]);
        expect(recentFiles.getRecentFilesSync()).toEqual([filePath]);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            `Recent file path stat timed out; preserving entry (${filePath})`,
        );
    });
});
