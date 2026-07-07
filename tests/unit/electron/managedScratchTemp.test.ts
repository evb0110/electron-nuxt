import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    existsSync,
    mkdtempSync,
    rmSync,
} from 'fs';
import {
    mkdir,
    readFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const mocks = vi.hoisted(() => ({
    appTempDir: '',
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('@electron/utils/appTempDir', () => ({getAppTempDir: () => mocks.appTempDir}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));

const {
    createManagedScratchTempDir,
    sweepStaleManagedScratchTempDirs,
} = await import('@electron/utils/managedScratchTemp');

describe('managed scratch temp cleanup', () => {
    beforeEach(() => {
        mocks.appTempDir = mkdtempSync(join(tmpdir(), 'managed-scratch-test-'));
        vi.clearAllMocks();
    });

    afterEach(() => {
        rmSync(mocks.appTempDir, {
            force: true,
            recursive: true,
        });
    });

    it('creates owner-marked scratch dirs and sweeps only stale marked managed prefixes', async () => {
        const markedPath = await createManagedScratchTempDir('pdfExport-');
        const marker = JSON.parse(await readFile(join(markedPath, '.evb-managed-scratch.json'), 'utf8')) as {
            pid?: unknown;
            prefix?: unknown;
        };
        expect(marker.prefix).toBe('pdfExport-');
        expect(marker.pid).toBe(process.pid);

        const unmarkedManagedPath = join(mocks.appTempDir, 'qpdfArgs-unmarked');
        const unrelatedPath = join(mocks.appTempDir, 'other-stale');
        await mkdir(unmarkedManagedPath);
        await mkdir(unrelatedPath);

        await expect(sweepStaleManagedScratchTempDirs(0)).resolves.toBe(1);

        expect(existsSync(markedPath)).toBe(false);
        expect(existsSync(unmarkedManagedPath)).toBe(true);
        expect(existsSync(unrelatedPath)).toBe(true);
        expect(mocks.logger.info).toHaveBeenCalledWith('Cleaned up 1 stale managed scratch directory');
    });

    it('leaves fresh marked scratch dirs inside the TTL window', async () => {
        const markedPath = await createManagedScratchTempDir('pdf-page-ops-');

        await expect(sweepStaleManagedScratchTempDirs(60_000)).resolves.toBe(0);

        expect(existsSync(markedPath)).toBe(true);
        expect(mocks.logger.info).not.toHaveBeenCalled();
    });
});
