import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    app: {getPath: vi.fn(() => '/tmp/app-data')},
    dialog: {showMessageBox: vi.fn()},
    loadSettings: vi.fn(async () => ({})),
    logger: {
        error: vi.fn(),
        warn: vi.fn(),
    },
    readFile: vi.fn(),
    saveSettings: vi.fn(),
    shell: {openExternal: vi.fn()},
    te: vi.fn((key: string) => key),
}));

vi.mock('electron', () => ({
    app: mocks.app,
    dialog: mocks.dialog,
    shell: mocks.shell,
}));

vi.mock('fs/promises', () => ({readFile: mocks.readFile}));

vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    saveSettings: mocks.saveSettings,
}));

vi.mock('@electron/te', () => ({te: mocks.te}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

const originalPlatform = process.platform;

async function loadDefaultViewerModule() {
    vi.resetModules();
    return import('@electron/promptSetDefaultViewer');
}

describe('default viewer prompt', () => {
    beforeEach(() => {
        Object.defineProperty(process, 'platform', {
            configurable: true,
            value: 'win32',
        });
        vi.clearAllMocks();
        mocks.loadSettings.mockResolvedValue({});
        mocks.readFile.mockRejectedValue(new Error('missing'));
        mocks.shell.openExternal.mockRejectedValue(new Error('unsupported protocol'));
        mocks.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        mocks.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    });

    it('shows fallback instructions when Windows default-app settings cannot be opened', async () => {
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.shell.openExternal).toHaveBeenCalledWith('ms-settings:defaultapps');
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            'Failed to open Windows default apps settings: unsupported protocol',
        );
        expect(mocks.dialog.showMessageBox).toHaveBeenCalledTimes(2);
        expect(mocks.dialog.showMessageBox).toHaveBeenLastCalledWith({}, {
            buttons: ['OK'],
            message: 'dialogs.defaultViewer.message',
            title: 'dialogs.defaultViewer.instructionsTitle',
            type: 'info',
        });
    });

    it('honors prompt suppression from known settings files only when explicitly true', async () => {
        mocks.readFile.mockResolvedValueOnce(JSON.stringify({suppressDefaultViewerPrompt: true}));
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.dialog.showMessageBox).not.toHaveBeenCalled();
        expect(mocks.saveSettings).toHaveBeenCalledWith({suppressDefaultViewerPrompt: true});
    });

    it.each([
        [
            'false',
            { suppressDefaultViewerPrompt: false },
        ],
        [
            'string true',
            { suppressDefaultViewerPrompt: 'true' },
        ],
        [
            'missing key',
            {},
        ],
    ])('ignores non-true suppression value from settings file: %s', async (_label, settings) => {
        mocks.readFile.mockResolvedValueOnce(JSON.stringify(settings));
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.dialog.showMessageBox).toHaveBeenCalled();
        expect(mocks.dialog.showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.saveSettings.mock.invocationCallOrder[0]!,
        );
        expect(mocks.saveSettings).toHaveBeenCalledWith({suppressDefaultViewerPrompt: true});
    });

    it('ignores invalid JSON while checking known settings files', async () => {
        mocks.readFile.mockResolvedValueOnce('{');
        const { promptSetDefaultViewer } = await loadDefaultViewerModule();

        await promptSetDefaultViewer({} as never);

        expect(mocks.dialog.showMessageBox).toHaveBeenCalled();
        expect(mocks.dialog.showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.saveSettings.mock.invocationCallOrder[0]!,
        );
        expect(mocks.saveSettings).toHaveBeenCalledWith({suppressDefaultViewerPrompt: true});
    });
});

afterAll(() => {
    Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
    });
});
