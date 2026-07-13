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
    finish: vi.fn(),
    handoff: vi.fn(),
    start: vi.fn(() => ({
        jobId: 'save-job',
        signal: new AbortController().signal,
    })),
    stat: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({stat: mocks.stat}));
vi.mock('electron', () => ({utilityProcess: {fork: vi.fn()}}));
vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({WORKER_BUNDLES_BY_ID: {'document-save-utility': {fileName: 'document-save-utility.mjs'}}}));
vi.mock('@electron/utils/workerTask', () => ({resolveUnpackedWorkerPath: vi.fn(() => '/tmp/worker.mjs')}));
vi.mock('@electron/file-access/workingCopyMutationCommitSignal', () => ({markActiveWorkingCopyMutationCommitStarted: vi.fn()}));
vi.mock('@electron/resources/jobBroker', () => ({mainJobBroker: {acquire: mocks.acquire}}));
vi.mock('@electron/output/documentOutputService', () => ({documentOutputService: {
    finish: mocks.finish,
    handoff: mocks.handoff,
    start: mocks.start,
}}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: vi.fn(() => ({qpdf: '/tmp/qpdf'}))}));

describe('commitPdfTempFile', () => {
    afterEach(() => {
        vi.clearAllMocks();
        mocks.start.mockReturnValue({
            jobId: 'save-job',
            signal: new AbortController().signal,
        });
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
});
