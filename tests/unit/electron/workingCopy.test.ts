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
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import {
    dirname,
    join,
} from 'path';
import { tmpdir } from 'os';
import type { TOpenPath } from '@electron/file-access/openPathCapabilities';
import {requireDocumentRevisionToken} from '@contracts';

let tempRoot = '';

vi.mock('electron', () => ({ app: { getPath: vi.fn((_name: string) => tempRoot) } }));

vi.mock('@electron/utils/decryptPdfFileIfNeeded', () => ({ decryptPdfFileIfNeeded: vi.fn(async () => undefined) }));
vi.mock('@electron/pdf/pdfPageCount', () => ({getPdfPageCount: vi.fn(async () => 1)}));

describe('workingCopy', () => {
    beforeEach(() => {
        vi.resetModules();
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-working-copy-test-'));
    });

    afterEach(() => {
        vi.useRealTimers();
        rmSync(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('publishes a PDF working copy without starting page identity discovery and joins it before mutation', async () => {
        const pageCount = deferred<number>();
        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
        vi.mocked(getPdfPageCount).mockImplementationOnce(() => pageCount.promise);
        const {createWorkingCopyFromPath} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {awaitPageIdentityStoreInitialization} = await import('@electron/file-access/pageIdentityStore');
        const originalPath = join(tempRoot, 'background-page-identity.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        expect(existsSync(workingPath)).toBe(true);
        expect(getPdfPageCount).not.toHaveBeenCalled();

        let mutationSettled = false;
        const mutation = awaitPageIdentityStoreInitialization(workingPath)
            .finally(() => {
                mutationSettled = true;
            });
        await waitForSettledQueueTurn();
        expect(mutationSettled).toBe(false);

        pageCount.resolve(3);
        await expect(mutation).resolves.toBeUndefined();
        expect(JSON.parse(readFileSync(`${workingPath}.evb-pages.json`, 'utf8'))).toMatchObject({pageIds: expect.arrayContaining([
            expect.any(String),
            expect.any(String),
            expect.any(String),
        ])});
    });

    it('does not stack page-count or fingerprint work across repeated read-only opens', async () => {
        const fingerprint = vi.fn(async () => 'fingerprint');
        vi.doMock('@electron/file-access/workingCopyOriginalFileExpectation', () => ({
            createOriginalFileContentFingerprint: fingerprint,
            createOriginalFileContentFingerprintSync: vi.fn(() => 'sync-fingerprint'),
        }));

        try {
            const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
            vi.mocked(getPdfPageCount).mockClear();
            const {createWorkingCopyFromPath} = await import('@electron/file-access/workingCopyCreation');
            const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
            const {clearAllWorkingCopies} = await import('@electron/file-access/workingCopyCleanup');
            const originalPath = join(tempRoot, 'repeat-open.pdf');
            writeFileSync(originalPath, new Uint8Array([
                1,
                2,
                3,
            ]));
            const trustedOriginalPath = allowOpenPath(originalPath);
            expect(trustedOriginalPath).not.toBeNull();

            for (let index = 0; index < 3; index += 1) {
                await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
            }

            expect(getPdfPageCount).not.toHaveBeenCalled();
            expect(fingerprint).not.toHaveBeenCalled();
            await clearAllWorkingCopies();
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyOriginalFileExpectation');
        }
    });

    it('keeps a readable working copy when background page identity discovery fails but blocks mutation', async () => {
        const pageCount = deferred<number>();
        const {getPdfPageCount} = await import('@electron/pdf/pdfPageCount');
        vi.mocked(getPdfPageCount).mockImplementationOnce(() => pageCount.promise);
        const {createWorkingCopyFromPath} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {awaitPageIdentityStoreInitialization} = await import('@electron/file-access/pageIdentityStore');
        const originalPath = join(tempRoot, 'failed-page-identity.pdf');
        writeFileSync(originalPath, new Uint8Array([
            4,
            5,
            6,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            4,
            5,
            6,
        ]));
        const mutation = awaitPageIdentityStoreInitialization(workingPath);
        pageCount.reject(new Error('page count unavailable'));

        await expect(mutation).rejects.toThrow('page count unavailable');
        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            4,
            5,
            6,
        ]));
    });

    it('prunes retired working-copy metadata after its TTL without requiring a later lookup', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
        const {
            getRetiredWorkingCopyOriginalCountForTests,
            rememberRetiredWorkingCopyOriginal,
        } = await import('@electron/file-access/workingCopyStore');

        rememberRetiredWorkingCopyOriginal('/tmp/retired.pdf', '/tmp/original.pdf');
        expect(getRetiredWorkingCopyOriginalCountForTests()).toBe(1);

        await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);

        expect(getRetiredWorkingCopyOriginalCountForTests()).toBe(0);
    });

    it('recreates an active working copy directory from the original file', async () => {
        const {
            createWorkingCopyFromPath,
            ensureWorkingCopyDirectory,
        } = await import('@electron/file-access/workingCopyCreation');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
        rmSync(dirname(workingPath), {
            force: true,
            recursive: true,
        });

        await expect(ensureWorkingCopyDirectory(workingPath)).resolves.toBe(true);

        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            1,
            2,
            3,
        ]));

        await clearAllWorkingCopies();
    });

    it('recovers a recently cleaned working copy when a stale renderer path is reused', async () => {
        const {
            createWorkingCopyFromPath,
            ensureWorkingCopyDirectory,
        } = await import('@electron/file-access/workingCopyCreation');
        const { getWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const {
            cleanupWorkingCopy,
            clearAllWorkingCopies,
        } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            4,
            5,
            6,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const canonicalOriginalPath = realpathSync.native(originalPath);

        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
        await cleanupWorkingCopy(workingPath);
        expect(existsSync(dirname(workingPath))).toBe(false);

        expect(getWorkingCopyOriginalPath(workingPath)).toEqual({
            originalPath: canonicalOriginalPath,
            retired: true,
        });
        await expect(ensureWorkingCopyDirectory(workingPath)).resolves.toBe(true);

        expect(getWorkingCopyOriginalPath(workingPath)).toEqual({
            originalPath: canonicalOriginalPath,
            retired: false,
        });
        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            4,
            5,
            6,
        ]));

        await clearAllWorkingCopies();
    });

    it('resyncs a working copy after it was marked sync-required', async () => {
        const { createWorkingCopyFromPath } = await import('@electron/file-access/workingCopyCreation');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const {
            assertWorkingCopyMutationAllowed,
            getWorkingCopyRevision,
            markWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');
        const { handleResyncWorkingCopy } = await import('@electron/features/documents/main/workingCopySave');
        const originalPath = join(tempRoot, 'resync-original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        const beforeRevision = await getWorkingCopyRevision(workingPath, 7);
        writeFileSync(originalPath, new Uint8Array([
            9,
            8,
            7,
        ]));
        markWorkingCopySyncRequired(workingPath, 'copy-back failed');

        await expect(handleResyncWorkingCopy({senderId: 7}, workingPath)).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: false,
            workingCopyRefreshed: true,
        });

        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            9,
            8,
            7,
        ]));
        expect(() => assertWorkingCopyMutationAllowed(workingPath)).not.toThrow();
        const afterRevision = await getWorkingCopyRevision(workingPath, 7);
        expect(afterRevision.contentRevision).toBe(beforeRevision.contentRevision + 1);
        expect(afterRevision.token).not.toBe(beforeRevision.token);

        await clearAllWorkingCopies();
    });

    it('resyncs a journaled sync-required working copy after module reload', async () => {
        const { createWorkingCopyFromPath } = await import('@electron/file-access/workingCopyCreation');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const {
            getWorkingCopyRevision,
            markWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');
        const originalPath = join(tempRoot, 'resync-reload-original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        const beforeRevision = await getWorkingCopyRevision(workingPath, 7);
        writeFileSync(originalPath, new Uint8Array([
            6,
            5,
            4,
        ]));
        markWorkingCopySyncRequired(workingPath, 'copy-back failed before restart');

        vi.resetModules();
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const {
            assertWorkingCopyMutationAllowed,
            getWorkingCopyRevision: getReloadedWorkingCopyRevision,
        } = await import('@electron/file-access/documentRevisionStore');
        const { readWorkingCopyRevisionJournalEntries } = await import('@electron/file-access/documentRevisionSidecar');
        const { handleResyncWorkingCopy } = await import('@electron/features/documents/main/workingCopySave');

        expect(() => assertWorkingCopyMutationAllowed(workingPath))
            .toThrow('copy-back failed before restart');
        await expect(handleResyncWorkingCopy({senderId: 7}, workingPath)).resolves.toMatchObject({
            ok: true,
            externalWriteCommitted: false,
            workingCopyRefreshed: true,
        });

        expect(readFileSync(workingPath)).toEqual(Buffer.from([
            6,
            5,
            4,
        ]));
        expect(() => assertWorkingCopyMutationAllowed(workingPath)).not.toThrow();
        expect(readWorkingCopyRevisionJournalEntries(workingPath)
            .some(entry => entry.kind === 'working-copy-sync-required')).toBe(false);
        const afterRevision = await getReloadedWorkingCopyRevision(workingPath, 7);
        expect(afterRevision.contentRevision).toBe(beforeRevision.contentRevision + 1);
        expect(afterRevision.token).not.toBe(beforeRevision.token);

        await clearAllWorkingCopies();
    });

    it('preserves sync-required working copies during shutdown cleanup without renderer reporting', async () => {
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const {
            clearWorkingCopySyncRequired,
            markWorkingCopySyncRequired,
        } = await import('@electron/file-access/documentRevisionStore');
        const {
            getWorkingCopyOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const originalPath = join(tempRoot, 'sync-required-shutdown-original.pdf');
        const workingDir = join(tempRoot, 'evb-viewer', 'pdf-work-sync-required-shutdown');
        const workingPath = join(workingDir, 'sync-required-shutdown-original.pdf');

        mkdirSync(workingDir, {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));
        await setWorkingCopyOriginalPath(workingPath, originalPath, 7);
        markWorkingCopySyncRequired(workingPath, 'renderer did not acknowledge committed save');

        try {
            await clearAllWorkingCopies();

            expect(existsSync(workingDir)).toBe(true);
            expect(getWorkingCopyOriginalPath(workingPath, 7)).toMatchObject({
                originalPath,
                retired: false,
            });
        } finally {
            clearWorkingCopySyncRequired(workingPath);
            await clearAllWorkingCopies();
        }
    });

    it('preserves WORKING_COPY_MISSING when both working copy and original are gone', async () => {
        const { handleFileSaveStructured } = await import('@electron/features/documents/main/workingCopySave');
        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const originalPath = join(tempRoot, 'missing-original.pdf');
        const workingDir = join(tempRoot, 'pdf-work-missing');
        const workingPath = join(workingDir, 'missing-original.pdf');
        await setWorkingCopyOriginalPath(workingPath, originalPath);

        const context = {senderId: 1};
        await expect(handleFileSaveStructured(context, workingPath, {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-before-missing-save')})).resolves.toMatchObject({
            ok: false,
            reason: 'working-copy-missing',
        });

        await clearAllWorkingCopies();
    });

    it('rejects unmanaged existing paths as managed working-copy sources', async () => {
        const { requireManagedWorkingCopyPath } = await import('@electron/file-access/workingCopyCreation');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const unmanagedPath = join(tempRoot, 'unmanaged.pdf');
        writeFileSync(unmanagedPath, new Uint8Array([
            7,
            8,
            9,
        ]));

        await expect(requireManagedWorkingCopyPath(unmanagedPath))
            .rejects.toThrow('Source path is not a managed working copy');

        await clearAllWorkingCopies();
    });

    it('matches Windows original paths by normalized identity', async () => {
        const {
            findWorkingCopyPathByOriginalPath,
            isKnownWorkingCopyOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const workingPath = 'C:\\Users\\Alice\\AppData\\Local\\Temp\\pdf-work-1\\Book.pdf';
        const originalPath = 'C:\\Users\\Alice\\Documents\\Book.pdf';
        await setWorkingCopyOriginalPath(workingPath, originalPath);

        expect(findWorkingCopyPathByOriginalPath('c:/users/alice/documents/book.pdf')).toBe(workingPath);
        expect(isKnownWorkingCopyOriginalPath('\\\\?\\C:\\Users\\Alice\\Documents\\Book.pdf')).toBe(true);

        await clearAllWorkingCopies();
    });

    it('keeps original-path remapping scoped to the owning sender', async () => {
        const {
            findWorkingCopyPathByOriginalPath,
            isKnownWorkingCopyOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const workingPath = join(tempRoot, 'pdf-work-owned', 'Book.pdf');
        const originalPath = join(tempRoot, 'Book.pdf');
        await setWorkingCopyOriginalPath(workingPath, originalPath, 10);

        expect(findWorkingCopyPathByOriginalPath(originalPath, 10)).toBe(workingPath);
        expect(isKnownWorkingCopyOriginalPath(originalPath, 10)).toBe(true);
        expect(findWorkingCopyPathByOriginalPath(originalPath, 11)).toBeNull();
        expect(isKnownWorkingCopyOriginalPath(originalPath, 11)).toBe(false);

        await clearAllWorkingCopies();
    });

    it('keeps snapshot clones out of original-path current resolution', async () => {
        const {
            createWorkingCopyFromData,
            createWorkingCopyFromPath,
        } = await import('@electron/file-access/workingCopyCreation');
        const {
            findWorkingCopyPathByOriginalPath,
            getWorkingCopyOriginalPath,
            getWorkingCopyRole,
        } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
        const originalPath = join(tempRoot, 'snapshot-original.pdf');
        writeFileSync(originalPath, new Uint8Array([
            10,
            11,
            12,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();

        const currentWorkingPath = await createWorkingCopyFromPath(trustedOriginalPath!);
        const snapshotWorkingPath = await createWorkingCopyFromPath(currentWorkingPath as TOpenPath, originalPath);
        const dataSnapshotWorkingPath = await createWorkingCopyFromData(
            'snapshot-original.pdf',
            new Uint8Array([
                13,
                14,
                15,
            ]),
            originalPath,
        );

        expect(snapshotWorkingPath).not.toBe(currentWorkingPath);
        expect(getWorkingCopyRole(snapshotWorkingPath)).toBe('snapshot');
        expect(getWorkingCopyRole(dataSnapshotWorkingPath)).toBe('snapshot');
        expect(getWorkingCopyOriginalPath(snapshotWorkingPath)).toMatchObject({originalPath});
        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(currentWorkingPath);

        await clearAllWorkingCopies();
    });

    it('promotes the newest remaining current copy when the current mapping is retired', async () => {
        const {
            findWorkingCopyPathByOriginalPath,
            setWorkingCopyOriginalPath,
        } = await import('@electron/file-access/workingCopyStore');
        const {
            cleanupWorkingCopy,
            clearAllWorkingCopies,
        } = await import('@electron/file-access/workingCopyCleanup');
        const originalPath = join(tempRoot, 'promote-original.pdf');
        const firstWorkingPath = join(tempRoot, 'pdf-work-promote-1', 'promote-original.pdf');
        const secondWorkingPath = join(tempRoot, 'pdf-work-promote-2', 'promote-original.pdf');
        writeFileSync(originalPath, new Uint8Array([1]));
        mkdirSync(dirname(firstWorkingPath), {recursive: true});
        mkdirSync(dirname(secondWorkingPath), {recursive: true});
        writeFileSync(firstWorkingPath, new Uint8Array([1]));
        writeFileSync(secondWorkingPath, new Uint8Array([1]));

        await setWorkingCopyOriginalPath(firstWorkingPath, originalPath);
        await setWorkingCopyOriginalPath(secondWorkingPath, originalPath);

        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(secondWorkingPath);
        await cleanupWorkingCopy(secondWorkingPath);

        expect(findWorkingCopyPathByOriginalPath(originalPath)).toBe(firstWorkingPath);

        await clearAllWorkingCopies();
    });

    it('waits for an in-flight mutation before retiring ownership and removing the working directory', async () => {
        const {createWorkingCopyFromPath} = await import('@electron/file-access/workingCopyCreation');
        const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
        const {cleanupWorkingCopy} = await import('@electron/file-access/workingCopyCleanup');
        const {workingCopyMap} = await import('@electron/file-access/workingCopyStore');
        const {enqueueWorkingCopyMutation} = await import('@electron/file-access/workingCopyMutationQueue');
        const originalPath = join(tempRoot, 'cleanup-during-mutation.pdf');
        writeFileSync(originalPath, new Uint8Array([
            1,
            2,
            3,
        ]));
        const trustedOriginalPath = allowOpenPath(originalPath);
        expect(trustedOriginalPath).not.toBeNull();
        const workingPath = await createWorkingCopyFromPath(trustedOriginalPath!, undefined, 7);
        const mutationStarted = deferred<undefined>();
        const releaseMutation = deferred<undefined>();
        const mutation = enqueueWorkingCopyMutation(workingPath, async () => {
            mutationStarted.resolve(undefined);
            await releaseMutation.promise;
        });
        await mutationStarted.promise;

        const cleanup = cleanupWorkingCopy(workingPath, 7);
        await waitForSettledQueueTurn();

        expect(workingCopyMap.has(workingPath)).toBe(true);
        expect(existsSync(dirname(workingPath))).toBe(true);

        releaseMutation.resolve(undefined);
        await mutation;
        await cleanup;

        expect(workingCopyMap.has(workingPath)).toBe(false);
        expect(existsSync(dirname(workingPath))).toBe(false);
    });

    it('does not let a delayed original expectation update overwrite a newer registration', async () => {
        const firstFingerprint = deferred<string | undefined>();
        let firstFingerprintSignal: AbortSignal | undefined;
        let fingerprintCalls = 0;
        vi.doMock('@electron/file-access/workingCopyOriginalFileExpectation', () => ({
            createOriginalFileContentFingerprint: vi.fn(async (
                _path: string,
                _size: number,
                signal?: AbortSignal,
            ) => {
                fingerprintCalls += 1;
                if (fingerprintCalls === 1) {
                    firstFingerprintSignal = signal;
                    return firstFingerprint.promise;
                }
                return `fingerprint-${fingerprintCalls}`;
            }),
            createOriginalFileContentFingerprintSync: vi.fn(() => 'sync-fingerprint'),
        }));

        try {
            const {
                getWorkingCopyOriginalFileExpectation,
                getWorkingCopyOriginalPath,
                setWorkingCopyOriginalPath,
            } = await import('@electron/file-access/workingCopyStore');
            const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
            const firstOriginalPath = join(tempRoot, 'first-original.pdf');
            const secondOriginalPath = join(tempRoot, 'second-original.pdf');
            const workingPath = join(tempRoot, 'pdf-work-async-registration', 'working.pdf');
            mkdirSync(dirname(workingPath), {recursive: true});
            writeFileSync(firstOriginalPath, new Uint8Array([1]));
            writeFileSync(secondOriginalPath, new Uint8Array([2]));
            writeFileSync(workingPath, new Uint8Array([3]));

            const firstRegistration = setWorkingCopyOriginalPath(workingPath, firstOriginalPath, 10);
            await vi.waitFor(() => {
                expect(fingerprintCalls).toBe(1);
            });
            await setWorkingCopyOriginalPath(workingPath, secondOriginalPath, 10);
            expect(firstFingerprintSignal?.aborted).toBe(true);

            expect(getWorkingCopyOriginalPath(workingPath, 10)).toMatchObject({
                originalPath: secondOriginalPath,
                retired: false,
            });
            expect(getWorkingCopyOriginalFileExpectation(workingPath, 10)).toMatchObject({
                contentFingerprint: 'fingerprint-2',
                size: 1,
            });

            firstFingerprint.resolve('fingerprint-stale-first');
            await firstRegistration;

            expect(getWorkingCopyOriginalPath(workingPath, 10)).toMatchObject({
                originalPath: secondOriginalPath,
                retired: false,
            });
            expect(getWorkingCopyOriginalFileExpectation(workingPath, 10)).toMatchObject({
                contentFingerprint: 'fingerprint-2',
                size: 1,
            });

            await clearAllWorkingCopies();
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyOriginalFileExpectation');
        }
    });

    it('does not let a delayed expectation refresh overwrite a newer registration', async () => {
        const refreshFingerprint = deferred<string | undefined>();
        let fingerprintCalls = 0;
        let slowNextFingerprint = false;
        vi.doMock('@electron/file-access/workingCopyOriginalFileExpectation', () => ({
            createOriginalFileContentFingerprint: vi.fn(async () => {
                fingerprintCalls += 1;
                if (slowNextFingerprint) {
                    slowNextFingerprint = false;
                    return refreshFingerprint.promise;
                }
                return `fingerprint-${fingerprintCalls}`;
            }),
            createOriginalFileContentFingerprintSync: vi.fn(() => 'sync-fingerprint'),
        }));

        try {
            const {
                getWorkingCopyOriginalFileExpectation,
                refreshWorkingCopyOriginalFileExpectation,
                setWorkingCopyOriginalPath,
            } = await import('@electron/file-access/workingCopyStore');
            const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
            const firstOriginalPath = join(tempRoot, 'refresh-first-original.pdf');
            const secondOriginalPath = join(tempRoot, 'refresh-second-original.pdf');
            const workingPath = join(tempRoot, 'pdf-work-async-refresh', 'working.pdf');
            mkdirSync(dirname(workingPath), {recursive: true});
            writeFileSync(firstOriginalPath, new Uint8Array([1]));
            writeFileSync(secondOriginalPath, new Uint8Array([2]));
            writeFileSync(workingPath, new Uint8Array([3]));

            await setWorkingCopyOriginalPath(workingPath, firstOriginalPath, 10);
            slowNextFingerprint = true;
            const refreshPromise = refreshWorkingCopyOriginalFileExpectation(workingPath, 10);
            await vi.waitFor(() => {
                expect(fingerprintCalls).toBe(2);
            });
            await setWorkingCopyOriginalPath(workingPath, secondOriginalPath, 10);

            refreshFingerprint.resolve('fingerprint-stale-refresh');
            await expect(refreshPromise).resolves.toBe(false);
            expect(getWorkingCopyOriginalFileExpectation(workingPath, 10)).toMatchObject({
                contentFingerprint: 'fingerprint-3',
                size: 1,
            });

            await clearAllWorkingCopies();
        } finally {
            vi.doUnmock('@electron/file-access/workingCopyOriginalFileExpectation');
        }
    });

    it('removes stale OCR sidecar directories with stale working-copy directories', async () => {
        const { cleanupStaleWorkingCopyDirectories } = await import('@electron/file-access/workingCopyCleanup');
        const appTempDir = join(tempRoot, 'evb-viewer');
        const workDir = join(appTempDir, 'pdf-work-stale-ocr');
        const ocrDir = `${workDir}.ocr`;
        mkdirSync(workDir, {recursive: true});
        mkdirSync(ocrDir, {recursive: true});
        writeFileSync(join(workDir, 'document.pdf'), new Uint8Array([1]));
        writeFileSync(join(ocrDir, 'manifest.json'), '{}');

        const staleDate = new Date(Date.now() - (48 * 60 * 60 * 1000));
        utimesSync(workDir, staleDate, staleDate);

        await expect(cleanupStaleWorkingCopyDirectories()).resolves.toEqual({
            removedDirectories: 1,
            removedOcrDirectories: 1,
        });
        expect(existsSync(workDir)).toBe(false);
        expect(existsSync(ocrDir)).toBe(false);
    });

    it('serializes mutation queue entries that use different spellings of one Windows path', async () => {
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const blockedMutation = deferred<undefined>();
        const operations: string[] = [];

        const firstMutation = enqueueWorkingCopyMutation('C:\\Temp\\pdf-work-1\\Book.pdf', async () => {
            operations.push('first-start');
            await blockedMutation.promise;
            operations.push('first-end');
        });
        const secondMutation = enqueueWorkingCopyMutation('\\\\?\\c:\\temp\\pdf-work-1\\book.pdf', async () => {
            operations.push('second-start');
        });
        await waitForSettledQueueTurn();

        expect(operations).toEqual(['first-start']);

        blockedMutation.resolve(undefined);
        await Promise.all([
            firstMutation,
            secondMutation,
        ]);

        expect(operations).toEqual([
            'first-start',
            'first-end',
            'second-start',
        ]);
    });

    it('waits for queued mutations before clearing all working copies', async () => {
        const { setWorkingCopyOriginalPath } = await import('@electron/file-access/workingCopyStore');
        const { clearAllWorkingCopies } = await import('@electron/file-access/workingCopyCleanup');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const originalPath = join(tempRoot, 'drain-original.pdf');
        const workingDir = join(tempRoot, 'evb-viewer', 'pdf-work-drain');
        const workingPath = join(workingDir, 'drain-original.pdf');
        const blockedMutation = deferred<undefined>();
        const operations: string[] = [];
        mkdirSync(workingDir, {recursive: true});
        writeFileSync(originalPath, new Uint8Array([1]));
        writeFileSync(workingPath, new Uint8Array([2]));
        await setWorkingCopyOriginalPath(workingPath, originalPath);

        const mutation = enqueueWorkingCopyMutation(workingPath, async () => {
            operations.push('mutation-start');
            await blockedMutation.promise;
            operations.push(`dir-exists:${existsSync(workingDir)}`);
        });
        await waitForSettledQueueTurn();

        const clearPromise = clearAllWorkingCopies().then(() => {
            operations.push('clear-done');
        });
        await waitForSettledQueueTurn();

        expect(existsSync(workingDir)).toBe(true);
        expect(operations).toEqual(['mutation-start']);

        blockedMutation.resolve(undefined);
        await mutation;
        await clearPromise;

        expect(operations).toEqual([
            'mutation-start',
            'dir-exists:true',
            'clear-done',
        ]);
        expect(existsSync(workingDir)).toBe(false);
    });

    it('registers queued mutations as critical writes and fail-closes aborted queued entries during shutdown', async () => {
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const {
            beginMainOperationShutdown,
            cancelAllMainOperations,
            drainCriticalMainOperations,
            resetMainOperationLifecycleForTests,
            snapshotMainOperations,
        } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const workingPath = join(tempRoot, 'shutdown-queued.pdf');
        const blockedMutation = deferred<undefined>();
        const operations: string[] = [];
        writeFileSync(workingPath, new Uint8Array([1]));

        const firstMutation = enqueueWorkingCopyMutation(workingPath, async () => {
            operations.push('first-start');
            await blockedMutation.promise;
            operations.push('first-end');
        });
        const secondMutation = enqueueWorkingCopyMutation(workingPath, async () => {
            operations.push('second-start');
        });
        await waitForSettledQueueTurn();

        expect(snapshotMainOperations()).toEqual([
            expect.objectContaining({
                kind: 'critical-write',
                workingCopyPath: workingPath,
            }),
            expect.objectContaining({
                kind: 'critical-write',
                workingCopyPath: workingPath,
            }),
        ]);

        beginMainOperationShutdown('Main process is shutting down');
        cancelAllMainOperations('app shutdown');
        const drainPromise = drainCriticalMainOperations({timeoutMs: 1_000});

        blockedMutation.resolve(undefined);
        await firstMutation;
        await expect(secondMutation).rejects.toThrow('app shutdown');
        await expect(drainPromise).resolves.toEqual({
            completed: true,
            pending: [],
        });
        expect(operations).toEqual([
            'first-start',
            'first-end',
        ]);
        resetMainOperationLifecycleForTests();
    });

    it('rejects new queued mutations with a typed shutdown envelope after admission closes', async () => {
        const { getMainOperationErrorEnvelope } = await import('@contracts/mainOperationErrors');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const {
            beginMainOperationShutdown,
            resetMainOperationLifecycleForTests,
        } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        beginMainOperationShutdown('Main process is shutting down');

        let caught: unknown;
        try {
            void enqueueWorkingCopyMutation(join(tempRoot, 'late.pdf'), async () => undefined);
        } catch (error) {
            caught = error;
        }

        expect(getMainOperationErrorEnvelope(caught)).toEqual({
            code: 'shutting-down',
            message: 'Main process is shutting down',
        });
        resetMainOperationLifecycleForTests();
    });

    it('marks queued mutation commit once an atomic replacement starts', async () => {
        const { atomicReplace } = await import('@electron/utils/atomicReplace');
        const { enqueueWorkingCopyMutation } = await import('@electron/file-access/workingCopyMutationQueue');
        const {
            resetMainOperationLifecycleForTests,
            snapshotMainOperations,
        } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const targetPath = join(tempRoot, 'commit-target.pdf');
        const tempPath = join(tempRoot, 'commit-temp.pdf');
        writeFileSync(targetPath, 'old');
        writeFileSync(tempPath, 'new');

        await enqueueWorkingCopyMutation(targetPath, async () => {
            expect(snapshotMainOperations()).toEqual([expect.objectContaining({
                commitStarted: false,
                workingCopyPath: targetPath,
            })]);
            await atomicReplace(tempPath, targetPath);
            expect(snapshotMainOperations()).toEqual([expect.objectContaining({
                commitStarted: true,
                workingCopyPath: targetPath,
            })]);
        });

        expect(readFileSync(targetPath, 'utf8')).toBe('new');
        resetMainOperationLifecycleForTests();
    });

    it('can durably replace a sidecar without marking user-document commit started', async () => {
        const {atomicReplace} = await import('@electron/utils/atomicReplace');
        const {enqueueWorkingCopyMutation} = await import('@electron/file-access/workingCopyMutationQueue');
        const {
            resetMainOperationLifecycleForTests,
            snapshotMainOperations,
        } = await import('@electron/operation-lifecycle/mainOperationLifecycle');
        const targetPath = join(tempRoot, 'revision-sidecar.json');
        const tempPath = join(tempRoot, 'revision-sidecar.tmp');
        writeFileSync(targetPath, 'old');
        writeFileSync(tempPath, 'new');

        await enqueueWorkingCopyMutation(targetPath, async () => {
            await atomicReplace(tempPath, targetPath, {markMutationCommitStarted: false});
            expect(snapshotMainOperations()).toEqual([expect.objectContaining({
                commitStarted: false,
                workingCopyPath: targetPath,
            })]);
        });

        expect(readFileSync(targetPath, 'utf8')).toBe('new');
        resetMainOperationLifecycleForTests();
    });
});

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

async function waitForSettledQueueTurn() {
    await new Promise(resolve => setTimeout(resolve, 20));
}
