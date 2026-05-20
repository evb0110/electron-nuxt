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
    fromWebContents: vi.fn<() => { setTitle: (title: string) => void; } | null>(() => null),
    refreshMenu: vi.fn(),
    showItemInFolder: vi.fn(),
    resolveAllowedReadPath: vi.fn(async () => null),
}));

vi.mock('electron', () => ({
    app: {
        getPath: vi.fn(() => tmpdir()),
        isPackaged: false,
    },
    BrowserWindow: {
        fromWebContents: mocks.fromWebContents,
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
    refreshMenu: mocks.refreshMenu,
    updateRecentFilesMenu: vi.fn(),
}));

vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));

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
        const { handleShowItemInFolder } = await import('@electron/features/documents/main/documentWindowHandlers');

        allowOpenPath(filePath);

        await expect(handleShowItemInFolder({ sender: {} } as never, filePath)).resolves.toBe(true);

        expect(mocks.showItemInFolder).toHaveBeenCalledWith(realpathSync.native(filePath));
    });

    it('does not reveal arbitrary existing paths without a capability', async () => {
        const filePath = join(tempRoot, 'untrusted.pdf');
        writeFileSync(filePath, new Uint8Array([1]));

        const { handleShowItemInFolder } = await import('@electron/features/documents/main/documentWindowHandlers');

        await expect(handleShowItemInFolder({ sender: {} } as never, filePath)).resolves.toBe(false);

        expect(mocks.showItemInFolder).not.toHaveBeenCalled();
    });

    it('trims and clamps window titles before setting the native title', async () => {
        const setTitle = vi.fn();
        mocks.fromWebContents.mockReturnValue({setTitle});
        const { handleSetWindowTitle } = await import('@electron/features/documents/main/documentWindowHandlers');

        handleSetWindowTitle(
            { sender: {id: 9} } as never,
            `  ${'Document'.repeat(100)}  `,
        );

        expect(setTitle).toHaveBeenCalledWith('Document'.repeat(100).slice(0, 512));
        expect(mocks.refreshMenu).toHaveBeenCalled();
    });
});
