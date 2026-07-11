import { createHash } from 'node:crypto';
import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    path: '',
    revision: null as null | {token: string},
}));

vi.mock('@electron/features/documents/main/documentFilePathResolution', () => ({resolveExistingReadableBinaryPath: vi.fn(async () => mocks.path)}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({readWorkingCopyRevisionSidecar: vi.fn(async () => mocks.revision)}));

describe('managed temporary file handles', () => {
    let directory = '';

    beforeEach(async () => {
        directory = mkdtempSync(join(tmpdir(), 'evb-managed-handle-'));
        mocks.path = join(directory, 'large.pdf');
        mocks.revision = null;
        writeFileSync(mocks.path, Buffer.from('managed-file-content'));
        const { clearManagedTempFileHandlesForTests } = await import('@electron/features/documents/main/managedTempFileHandles');
        clearManagedTempFileHandlesForTests();
    });

    afterEach(async () => {
        const { clearManagedTempFileHandlesForTests } = await import('@electron/features/documents/main/managedTempFileHandles');
        clearManagedTempFileHandlesForTests();
        rmSync(directory, {
            force: true,
            recursive: true,
        });
    });

    it('issues a streaming-hash lease that only its owner can release', async () => {
        const {
            createManagedTempFileHandle,
            releaseManagedTempFileHandle,
        } = await import('@electron/features/documents/main/managedTempFileHandles');

        const handle = await createManagedTempFileHandle({senderId: 42}, mocks.path);

        expect(handle).toMatchObject({
            path: mocks.path,
            size: Buffer.byteLength('managed-file-content'),
            sha256: createHash('sha256').update('managed-file-content').digest('hex'),
            revision: null,
        });
        expect(releaseManagedTempFileHandle({senderId: 7}, handle.leaseId)).toBe(false);
        expect(releaseManagedTempFileHandle({senderId: 42}, handle.leaseId)).toBe(true);
        expect(releaseManagedTempFileHandle({senderId: 42}, handle.leaseId)).toBe(false);
    });

    it('resolves only owner-bound handles whose bytes, hash, and revision are unchanged', async () => {
        const {
            createManagedTempFileHandle,
            resolveManagedTempFileHandle,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const handle = await createManagedTempFileHandle({senderId: 42}, mocks.path);

        await expect(resolveManagedTempFileHandle({senderId: 42}, handle)).resolves.toEqual(handle);
        await expect(resolveManagedTempFileHandle({senderId: 7}, handle)).rejects.toThrow('another renderer');

        writeFileSync(mocks.path, Buffer.from('changed'));
        await expect(resolveManagedTempFileHandle({senderId: 42}, handle)).rejects.toThrow('content or revision changed');
    });
});
