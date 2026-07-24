import { createHash } from 'node:crypto';
import {
    appendFileSync,
    chmodSync,
    copyFileSync,
    linkSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
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
    inspect: vi.fn(),
    path: '',
    revision: null as null | {token: string},
}));

const waitForFilesystemTimestampTick = () => new Promise(resolve => setTimeout(resolve, 5));

vi.mock('@electron/features/documents/main/documentFilePathResolution', () => ({resolveExistingReadableBinaryPath: vi.fn(async () => mocks.path)}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({readWorkingCopyRevisionSidecar: vi.fn(async () => mocks.revision)}));
vi.mock('@electron/features/documents/main/fingerprintFileWithUtilityProcess', () => ({fingerprintFileWithUtilityProcess: mocks.inspect}));

describe('managed temporary file handles', () => {
    let directory = '';

    beforeEach(async () => {
        directory = mkdtempSync(join(tmpdir(), 'evb-managed-handle-'));
        mocks.path = join(directory, 'large.pdf');
        mocks.revision = null;
        writeFileSync(mocks.path, Buffer.from('managed-file-content'));
        mocks.inspect.mockImplementation(async (path: string) => {
            const bytes = readFileSync(path);
            return {
                bytes: bytes.byteLength,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            };
        });
        const { clearManagedTempFileHandlesForTests } = await import('@electron/features/documents/main/managedTempFileHandles');
        clearManagedTempFileHandlesForTests();
    });

    afterEach(async () => {
        vi.useRealTimers();
        const { clearManagedTempFileHandlesForTests } = await import('@electron/features/documents/main/managedTempFileHandles');
        clearManagedTempFileHandlesForTests();
        rmSync(directory, {
            force: true,
            recursive: true,
        });
    });

    it('issues an off-main fingerprint lease that only its owner can release', async () => {
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
        expect(mocks.inspect).toHaveBeenCalledWith(mocks.path);
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

    it('keeps typed staged artifact evidence authoritative for its owner-bound lease', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });

        expect(artifact).toMatchObject({
            receiptVersion: 1,
            artifactKind: 'pdf',
            path: mocks.path,
            fileIdentity: {platform: process.platform === 'win32' ? 'win32' : 'posix'},
        });
        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact)).resolves.toEqual(artifact);
        await expect(resolveTypedStagedArtifact({senderId: 7}, artifact)).rejects.toThrow('another renderer');
        await expect(resolveTypedStagedArtifact({senderId: 42}, {
            ...artifact,
            validations: {
                ...artifact.validations,
                tailCheck: true,
            },
        })).rejects.toThrow('altered');
    });

    it('does not rehash an unchanged POSIX staged artifact', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: true,
            semanticCheck: false,
            fsynced: false,
        });
        mocks.inspect.mockClear();

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact)).resolves.toEqual(artifact);
        expect(mocks.inspect).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 0);
    });

    it('mints a staged receipt from a trusted incremental fingerprint without rehashing', async () => {
        const {createTypedStagedArtifact} = await import('@electron/features/documents/main/managedTempFileHandles');
        const bytes = readFileSync(mocks.path);
        const trustedFingerprint = {
            bytes: bytes.byteLength,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        };

        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: true,
            semanticCheck: false,
            fsynced: true,
        }, {trustedFingerprint});

        expect(artifact).toMatchObject({
            size: trustedFingerprint.bytes,
            sha256: trustedFingerprint.sha256,
        });
        expect(mocks.inspect).not.toHaveBeenCalled();
    });

    it('rejects a trusted incremental fingerprint whose byte count drifted', async () => {
        const {createTypedStagedArtifact} = await import('@electron/features/documents/main/managedTempFileHandles');
        const trustedFingerprint = {
            bytes: statSync(mocks.path).size + 1,
            sha256: 'a'.repeat(64),
        };

        await expect(createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: true,
            semanticCheck: false,
            fsynced: true,
        }, {trustedFingerprint})).rejects.toThrow('changed while its receipt was being created');
        expect(mocks.inspect).not.toHaveBeenCalled();
    });

    it('rejects inconsistent validation evidence while minting a receipt', async () => {
        const {createTypedStagedArtifact} = await import('@electron/features/documents/main/managedTempFileHandles');

        await expect(createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: true,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        })).rejects.toThrow('Invalid staged artifact validation receipt');
    });

    it('invalidates receipt reuse after size drift', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });

        appendFileSync(mocks.path, 'x');

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('changed after staging');
        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('missing');
    });

    it('invalidates receipt reuse after mtime drift', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });

        const fileStat = statSync(mocks.path);
        utimesSync(mocks.path, fileStat.atime, new Date(fileStat.mtimeMs + 2_000));

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('changed after staging');
    });

    it('invalidates receipt reuse after ctime drift', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });
        const fileStat = statSync(mocks.path);

        await waitForFilesystemTimestampTick();
        chmodSync(mocks.path, fileStat.mode ^ 0o100);

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('changed after staging');
    });

    it('invalidates receipt reuse after a same-size rewrite', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });

        await waitForFilesystemTimestampTick();
        writeFileSync(mocks.path, Buffer.from('rewritten-file-bytes'));

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('changed after staging');
    });

    it('invalidates receipt reuse after atomic same-size identity replacement', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });
        const replacementPath = join(directory, 'replacement.pdf');
        writeFileSync(replacementPath, Buffer.from('managed-file-content'));

        renameSync(replacementPath, mocks.path);

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('changed after staging');
    });

    it('rejects a receipt path swap even when the replacement bytes match', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });
        const otherPath = join(directory, 'other.pdf');
        writeFileSync(otherPath, Buffer.from('managed-file-content'));

        await expect(resolveTypedStagedArtifact({senderId: 42}, {
            ...artifact,
            path: otherPath,
        })).rejects.toThrow('altered');
    });

    it('rejects expired staged artifact leases', async () => {
        vi.useFakeTimers();
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });

        vi.advanceTimersByTime(5 * 60 * 1_000 + 1);

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('expired');
    });

    it('keeps validation flags and qpdf warnings authoritative against mutation', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const validations = {
            qpdfCheck: true,
            tailCheck: true,
            semanticCheck: false,
            fsynced: true,
            qpdfResult: {
                isValid: true,
                tool: 'qpdf' as const,
                errors: [] as string[],
                warnings: ['original warning'],
            },
        };
        const artifact = await createTypedStagedArtifact(
            {senderId: 42},
            mocks.path,
            validations,
        );
        const authoritativeEcho = structuredClone(artifact);

        validations.tailCheck = false;
        validations.qpdfResult.warnings.push('input mutation');
        artifact.validations.fsynced = false;
        artifact.validations.qpdfResult?.warnings.push('receipt mutation');

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('altered');
        await expect(resolveTypedStagedArtifact({senderId: 42}, authoritativeEcho))
            .resolves.toMatchObject({validations: {
                tailCheck: true,
                fsynced: true,
                qpdfResult: {warnings: ['original warning']},
            }});
    });

    it('rejects staged artifact access from another owner without invalidating its lease', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });

        await expect(resolveTypedStagedArtifact({senderId: 7}, artifact))
            .rejects.toThrow('another renderer');
        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .resolves.toEqual(artifact);
    });

    it('rebinds an atomic rename only when identity and stat witnesses are preserved', async () => {
        const {
            createTypedStagedArtifact,
            rebindTypedStagedArtifactPath,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: true,
            semanticCheck: false,
            fsynced: true,
        });
        const renamedPath = join(directory, 'renamed.pdf');
        renameSync(mocks.path, renamedPath);
        mocks.path = renamedPath;

        const rebound = await rebindTypedStagedArtifactPath(
            {senderId: 42},
            artifact,
            renamedPath,
        );

        expect(rebound.path).toBe(renamedPath);
        expect(rebound.fileIdentity).toEqual(artifact.fileIdentity);
        await expect(resolveTypedStagedArtifact({senderId: 42}, rebound))
            .resolves.toEqual(rebound);
    });

    it('mints a new identity-bound receipt for a trusted copy without inheriting fsync', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const sourceArtifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: true,
            tailCheck: true,
            semanticCheck: false,
            fsynced: true,
            qpdfResult: {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: ['source warning'],
            },
        });
        const copiedPath = join(directory, 'copied.pdf');
        copyFileSync(mocks.path, copiedPath);
        mocks.path = copiedPath;
        const copiedArtifact = await createTypedStagedArtifact({senderId: 42}, copiedPath, {
            qpdfCheck: true,
            tailCheck: true,
            semanticCheck: false,
            fsynced: false,
            ...(sourceArtifact.validations.qpdfResult
                ? {qpdfResult: sourceArtifact.validations.qpdfResult}
                : {}),
        });

        expect(copiedArtifact.leaseId).not.toBe(sourceArtifact.leaseId);
        if (process.platform !== 'win32') {
            expect(copiedArtifact.fileIdentity).not.toEqual(sourceArtifact.fileIdentity);
        }
        expect(copiedArtifact.validations).toMatchObject({
            qpdfCheck: true,
            tailCheck: true,
            fsynced: false,
            qpdfResult: {warnings: ['source warning']},
        });
        await expect(resolveTypedStagedArtifact({senderId: 42}, sourceArtifact))
            .resolves.toEqual(sourceArtifact);
        await expect(resolveTypedStagedArtifact({senderId: 42}, copiedArtifact))
            .resolves.toEqual(copiedArtifact);
    });

    it.runIf(process.platform !== 'win32')('invalidates a symlink substitution', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });
        const movedPath = join(directory, 'moved.pdf');
        renameSync(mocks.path, movedPath);
        symlinkSync(movedPath, mocks.path);

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('changed after staging');
    });

    it.runIf(process.platform !== 'win32')('invalidates a hard-link substitution witness', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });
        const linkedPath = join(directory, 'linked.pdf');
        await waitForFilesystemTimestampTick();
        linkSync(mocks.path, linkedPath);

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('changed after staging');
    });

    it('invalidates a receipt after revision-sidecar drift', async () => {
        const {
            createTypedStagedArtifact,
            resolveTypedStagedArtifact,
        } = await import('@electron/features/documents/main/managedTempFileHandles');
        const artifact = await createTypedStagedArtifact({senderId: 42}, mocks.path, {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        });
        mocks.revision = {token: 'changed-revision'};

        await expect(resolveTypedStagedArtifact({senderId: 42}, artifact))
            .rejects.toThrow('changed after staging');
    });
});
