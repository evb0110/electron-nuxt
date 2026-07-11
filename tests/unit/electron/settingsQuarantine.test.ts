import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    userDataPath: '',
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

describe('settings corruption quarantine', () => {
    afterEach(() => {
        rmSync(mocks.userDataPath, {
            force: true,
            recursive: true,
        });
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('quarantines malformed JSON and atomically persists clean defaults', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-quarantine-'));
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        writeFileSync(settingsPath, '{malformed');
        const {loadSettings} = await import('@electron/settings');

        const settings = await loadSettings();

        expect(settings).toBeTypeOf('object');
        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toEqual(settings);
        expect(readdirSync(mocks.userDataPath).some(name => /^settings\.json\.\d+\.corrupt$/u.test(name))).toBe(true);
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Quarantined corrupt settings'));
    });

    it('preserves the existing target and removes staged data when atomic promotion fails', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-atomic-failure-'));
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        mkdirSync(settingsPath);
        const {updateSettings} = await import('@electron/settings');

        await expect(updateSettings(settings => ({
            ...settings,
            theme: 'dark',
        }))).rejects.toThrow();

        expect(readdirSync(settingsPath)).toEqual([]);
        expect(readdirSync(mocks.userDataPath)).toEqual(['settings.json']);
    });

    it('serializes concurrent updates without losing either mutation', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-concurrent-'));
        const settingsPath = join(mocks.userDataPath, 'settings.json');
        const {updateSettings} = await import('@electron/settings');
        let releaseFirst: () => void = () => {};
        const firstCanFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        const first = updateSettings(async (settings) => {
            await firstCanFinish;
            settings.theme = 'dark';
            return undefined;
        });
        const second = updateSettings((settings) => {
            settings.authorName = 'Concurrent Author';
            return undefined;
        });
        releaseFirst();
        await Promise.all([
            first,
            second,
        ]);

        expect(JSON.parse(readFileSync(settingsPath, 'utf-8'))).toMatchObject({
            authorName: 'Concurrent Author',
            theme: 'dark',
        });
    });
});
