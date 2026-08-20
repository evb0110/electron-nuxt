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
    readdir,
    writeFile,
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
    usingManagedScratchScope,
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

    it('preserves live owners and sweeps only stale dead marked managed prefixes', async () => {
        const liveMarkedPath = await createManagedScratchTempDir('pdfExport-');
        const marker = JSON.parse(await readFile(join(liveMarkedPath, '.evb-managed-scratch.json'), 'utf8')) as {
            pid?: unknown;
            prefix?: unknown;
        };
        expect(marker.prefix).toBe('pdfExport-');
        expect(marker.pid).toBe(process.pid);

        const deadMarkedPath = await createManagedScratchTempDir('qpdfOutput-');
        await writeFile(join(deadMarkedPath, '.evb-managed-scratch.json'), `${JSON.stringify({
            createdAt: 0,
            pid: 2_147_483_647,
            prefix: 'qpdfOutput-',
        })}\n`, 'utf8');

        const unmarkedManagedPath = join(mocks.appTempDir, 'qpdfArgs-unmarked');
        const unrelatedPath = join(mocks.appTempDir, 'other-stale');
        await mkdir(unmarkedManagedPath);
        await mkdir(unrelatedPath);

        await expect(sweepStaleManagedScratchTempDirs(0)).resolves.toBe(1);

        expect(existsSync(liveMarkedPath)).toBe(true);
        expect(existsSync(deadMarkedPath)).toBe(false);
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

    it('applies the sweep budget only to managed scratch candidates', async () => {
        await mkdir(join(mocks.appTempDir, 'aaa-unrelated'));
        const deadMarkedPath = await createManagedScratchTempDir('qpdfOutput-');
        await writeFile(join(deadMarkedPath, '.evb-managed-scratch.json'), `${JSON.stringify({
            createdAt: 0,
            pid: 2_147_483_647,
            prefix: 'qpdfOutput-',
        })}\n`, 'utf8');

        await expect(sweepStaleManagedScratchTempDirs(0, 1)).resolves.toBe(1);

        expect(existsSync(deadMarkedPath)).toBe(false);
        await expect(readdir(mocks.appTempDir)).resolves.toEqual(['aaa-unrelated']);
    });

    it('removes a managed scope after success and failure', async () => {
        let successfulPath = '';
        await usingManagedScratchScope('pdfExport-', async scratchPath => { successfulPath = scratchPath; expect(existsSync(scratchPath)).toBe(true); });
        expect(existsSync(successfulPath)).toBe(false);
        let failedPath = '';
        await expect(usingManagedScratchScope('qpdfArgs-', async scratchPath => { failedPath = scratchPath; throw new Error('scope failed'); })).rejects.toThrow('scope failed');
        expect(existsSync(failedPath)).toBe(false);
    });
});
