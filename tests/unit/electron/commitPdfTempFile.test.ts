import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { commitPdfTempFile } from '@electron/features/documents/main/commitPdfTempFile';

const mocks = vi.hoisted(() => ({
    acquire: vi.fn(),
    atomicReplace: vi.fn(),
    finish: vi.fn(),
    handoff: vi.fn(),
    start: vi.fn(() => ({
        jobId: 'save-job',
        signal: new AbortController().signal,
    })),
    stat: vi.fn(),
    resolveTypedStagedArtifact: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({stat: mocks.stat}));
vi.mock('electron', () => ({utilityProcess: {fork: vi.fn()}}));
vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({WORKER_BUNDLES_BY_ID: {'document-save-utility': {fileName: 'document-save-utility.mjs'}}}));
vi.mock('@electron/utils/workerTask', () => ({resolveUnpackedWorkerPath: vi.fn(() => '/tmp/worker.mjs')}));
vi.mock('@electron/utils/atomicReplace', () => ({atomicReplace: mocks.atomicReplace}));
vi.mock('@electron/file-access/workingCopyMutationCommitSignal', () => ({markActiveWorkingCopyMutationCommitStarted: vi.fn()}));
vi.mock('@electron/resources/jobBroker', () => ({mainJobBroker: {acquire: mocks.acquire}}));
vi.mock('@electron/output/documentOutputService', () => ({documentOutputService: {
    finish: mocks.finish,
    handoff: mocks.handoff,
    start: mocks.start,
}}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: vi.fn(() => ({qpdf: '/tmp/qpdf'}))}));
vi.mock('@electron/features/documents/main/managedTempFileHandles', () => ({resolveTypedStagedArtifact: mocks.resolveTypedStagedArtifact}));

describe('commitPdfTempFile', () => {
    afterEach(() => {
        vi.clearAllMocks();
        mocks.start.mockReturnValue({
            jobId: 'save-job',
            signal: new AbortController().signal,
        });
        mocks.resolveTypedStagedArtifact.mockImplementation(async (_context, artifact) => artifact);
    });

    it('terminalizes a source stat failure', async () => {
        mocks.stat.mockRejectedValueOnce(new Error('source disappeared'));

        await expect(commitPdfTempFile('/tmp/missing.pdf', '/tmp/output.pdf'))
            .rejects.toThrow('source disappeared');
        expect(mocks.finish).toHaveBeenCalledWith(
            'save-job',
            'failed',
            'source disappeared',
        );
    });

    it('terminalizes a broker admission failure', async () => {
        mocks.acquire.mockRejectedValueOnce(new Error('admission unavailable'));

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {
            expectedBytes: 1,
            changedObjectRefs: ['1 0 R'],
        })).rejects.toThrow('admission unavailable');
        expect(mocks.finish).toHaveBeenCalledWith(
            'save-job',
            'failed',
            'admission unavailable',
        );
    });

    it('terminalizes an authoritative receipt resolution failure', async () => {
        mocks.resolveTypedStagedArtifact.mockRejectedValueOnce(new Error('receipt altered'));

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {receipt: {
            artifact: {
                receiptVersion: 1,
                artifactKind: 'pdf',
                path: '/tmp/source.pdf',
                size: 100,
                sha256: 'a'.repeat(64),
                fileIdentity: {
                    platform: 'posix',
                    deviceId: '1',
                    inode: '2',
                },
                validations: {
                    qpdfCheck: false,
                    tailCheck: false,
                    semanticCheck: false,
                    fsynced: false,
                },
                leaseId: 'lease-1',
                revision: null,
            },
            context: {senderId: 42},
        }})).rejects.toThrow('receipt altered');
        expect(mocks.finish).toHaveBeenCalledWith(
            'save-job',
            'failed',
            'receipt altered',
        );
        expect(mocks.stat).not.toHaveBeenCalled();
    });

    it('uses an unchanged authoritative receipt without restating a small source', async () => {
        const artifact = {
            receiptVersion: 1 as const,
            artifactKind: 'pdf' as const,
            path: '/tmp/source.pdf',
            size: 100,
            sha256: 'a'.repeat(64),
            fileIdentity: {
                platform: 'posix' as const,
                deviceId: '1',
                inode: '2',
            },
            validations: {
                qpdfCheck: false,
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
            leaseId: 'lease-1',
            revision: null,
        };

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {receipt: {
            artifact,
            context: {senderId: 42},
        }})).resolves.toBeNull();

        expect(mocks.resolveTypedStagedArtifact).toHaveBeenCalledWith(
            {senderId: 42},
            artifact,
        );
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.atomicReplace).toHaveBeenCalledWith('/tmp/source.pdf', '/tmp/output.pdf');
    });

    it('rejects an authoritative receipt resolved for another source path', async () => {
        const artifact = {
            receiptVersion: 1 as const,
            artifactKind: 'pdf' as const,
            path: '/tmp/source.pdf',
            size: 100,
            sha256: 'a'.repeat(64),
            fileIdentity: {
                platform: 'posix' as const,
                deviceId: '1',
                inode: '2',
            },
            validations: {
                qpdfCheck: false,
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
            leaseId: 'lease-1',
            revision: null,
        };
        mocks.resolveTypedStagedArtifact.mockResolvedValueOnce({
            ...artifact,
            path: '/tmp/other.pdf',
        });

        await expect(commitPdfTempFile('/tmp/source.pdf', '/tmp/output.pdf', {receipt: {
            artifact,
            context: {senderId: 42},
        }})).rejects.toThrow('does not identify');
    });
});
