import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {runDocumentSaveUtilityProcess} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';

const mocks = vi.hoisted(() => ({fork: vi.fn()}));

vi.mock('electron', () => ({utilityProcess: {fork: mocks.fork}}));
vi.mock('@electron-worker-bundles/electronWorkerBundles.js', () => ({WORKER_BUNDLES_BY_ID: {'document-save-utility': {fileName: 'document-save-utility.mjs'}}}));
vi.mock('@electron/utils/workerTask', () => ({resolveUnpackedWorkerPath: vi.fn(
    () => '/tmp/document-save-utility.mjs',
)}));
vi.mock('@electron/resources/jobBroker', () => ({mainJobBroker: {acquire: vi.fn()}}));

describe('runDocumentSaveUtilityProcess cancellation', () => {
    it('does not fork after cancellation has already been requested', async () => {
        const controller = new AbortController();
        controller.abort(new Error('save canceled before utility launch'));

        await expect(runDocumentSaveUtilityProcess({
            cwd: '/tmp',
            serviceName: 'EVB document save',
            utilityName: 'Document save utility',
            timeoutMs: 1_000,
            request: {
                type: 'inspect',
                sourcePath: '/tmp/source.pdf',
                expectedBytes: 1,
            },
            signal: controller.signal,
        })).rejects.toThrow('save canceled before utility launch');

        expect(mocks.fork).not.toHaveBeenCalled();
    });
});
