import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
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

const mocks = vi.hoisted(() => {
    const app = { getPath: vi.fn() };
    const logger = {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    };
    return {
        app,
        logger,
    };
});

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('@electron/utils/logger', () => ({ createLogger: () => mocks.logger }));

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
});
