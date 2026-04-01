import {
    mkdtempSync,
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
    return import('@electron/recent-files');
}

describe('recent-files persistence', () => {
    let userDataDir = '';

    beforeEach(() => {
        vi.clearAllMocks();
        userDataDir = mkdtempSync(join(tmpdir(), 'evb-recent-files-'));
        mocks.app.getPath.mockReturnValue(userDataDir);
    });

    afterEach(() => {
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
});
