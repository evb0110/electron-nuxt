import {
    mkdtempSync,
    rmSync,
} from 'node:fs';
import {rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(),
    events: [] as string[],
    logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
    setMainDiagnosticsPreference: vi.fn((preference: unknown) => {
        mocks.events.push(`preference:${String(preference)}`);
    }),
    userDataPath: '',
}));

vi.mock('electron', () => ({app: {getPath: () => mocks.userDataPath}}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/features/diagnostics/public', () => ({setMainDiagnosticsPreference: mocks.setMainDiagnosticsPreference}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: (targetPath: string) => `${targetPath}.tmp`,
}));

describe('Electron diagnostics consent persistence ordering', () => {
    afterEach(() => {
        rmSync(mocks.userDataPath, {
            force: true,
            recursive: true,
        });
        mocks.events.length = 0;
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('opens the main reporter only after a granted settings write succeeds', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-consent-grant-'));
        mocks.atomicReplace.mockImplementation(async (source: string, target: string) => {
            mocks.events.push('persist');
            await rename(source, target);
        });
        const {updateSettings} = await import('@electron/settings');

        await updateSettings(() => ({clientDiagnosticsPreference: 'granted'}));

        expect(mocks.events).toEqual([
            'persist',
            'preference:granted',
        ]);
    });

    it('drops the main reporter before a failed revoke write and does not restore it', async () => {
        mocks.userDataPath = mkdtempSync(join(tmpdir(), 'evb-settings-consent-revoke-'));
        mocks.atomicReplace.mockImplementation(async (source: string, target: string) => {
            mocks.events.push('persist');
            await rename(source, target);
        });
        const {updateSettings} = await import('@electron/settings');
        await updateSettings(() => ({clientDiagnosticsPreference: 'granted'}));
        mocks.events.length = 0;
        mocks.atomicReplace.mockImplementationOnce(async () => {
            mocks.events.push('persist');
            throw new Error('settings disk full');
        });

        await expect(updateSettings(() => ({clientDiagnosticsPreference: 'denied'})))
            .rejects.toThrow('settings disk full');

        expect(mocks.events).toEqual([
            'preference:denied',
            'persist',
        ]);

        mocks.events.length = 0;
        const laterSettings = await updateSettings(() => ({authorName: 'Still private'}));
        expect(laterSettings.clientDiagnosticsPreference).toBe('denied');
        expect(mocks.events).toEqual([
            'persist',
            'preference:denied',
        ]);
    });
});
