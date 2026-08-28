import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {copyFileAtomic} from '@electron/file-access/documentFileWriteAtomic';

describe('documentFileWriteAtomic', () => {
    it('keeps a successful copy successful when phase reporting fails', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-atomic-copy-phase-'));
        const sourcePath = join(tempRoot, 'source.pdf');
        const targetPath = join(tempRoot, 'target.pdf');
        writeFileSync(sourcePath, 'source bytes');

        try {
            const onPhase = vi.fn(() => {
                throw new Error('phase reporter failed');
            });
            await expect(copyFileAtomic(sourcePath, targetPath, {
                durable: false,
                onPhase,
            })).resolves.toBeUndefined();

            expect(onPhase).toHaveBeenCalledWith('clone', expect.any(Number));
            expect(onPhase).toHaveBeenCalledWith('rename', expect.any(Number));
            expect(readFileSync(targetPath, 'utf8')).toBe('source bytes');
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
