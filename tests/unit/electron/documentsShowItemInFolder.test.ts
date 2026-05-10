import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mocks = vi.hoisted(() => ({
    showItemInFolder: vi.fn(),
    resolveAllowedReadPath: vi.fn(async () => null),
}));

vi.mock('electron', () => ({
    app: {
        getPath: vi.fn(() => tmpdir()),
        isPackaged: false,
    },
    BrowserWindow: {
        fromWebContents: vi.fn(() => null),
        getAllWindows: vi.fn(() => []),
        getFocusedWindow: vi.fn(() => null),
    },
    dialog: {
        showOpenDialog: vi.fn(),
        showSaveDialog: vi.fn(),
    },
    shell: { showItemInFolder: mocks.showItemInFolder },
}));

vi.mock('@electron/menu', () => ({
    refreshMenu: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
}));

vi.mock('@electron/utils/path-validator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));

vi.mock('@electron/utils/logger', () => ({ createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}) }));

describe('documents show item in folder', () => {
    let tempRoot = '';

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-show-folder-test-'));
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('reveals paths trusted by the open-path capability', async () => {
        const filePath = join(tempRoot, 'opened.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const { allowOpenPath } = await import('@electron/ipc/openPathCapabilities');
        const { handleShowItemInFolder } = await import('@electron/features/documents/main/dialogs');

        allowOpenPath(filePath);

        await expect(handleShowItemInFolder({ sender: {} } as never, filePath)).resolves.toBe(true);

        expect(mocks.showItemInFolder).toHaveBeenCalledWith(realpathSync.native(filePath));
    });

    it('does not reveal arbitrary existing paths without a capability', async () => {
        const filePath = join(tempRoot, 'untrusted.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const { handleShowItemInFolder } = await import('@electron/features/documents/main/dialogs');

        await expect(handleShowItemInFolder({ sender: {} } as never, filePath)).resolves.toBe(false);

        expect(mocks.showItemInFolder).not.toHaveBeenCalled();
    });
});
