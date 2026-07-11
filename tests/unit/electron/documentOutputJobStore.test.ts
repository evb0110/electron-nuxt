import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    clearDocumentOutputJobsForTests,
    getDocumentOutputJobState,
    recordDocumentOutputHandoff,
    recordDocumentOutputProgress,
    subscribeDocumentOutputJob,
} from '@electron/features/djvu/main/documentOutputJobStore';

describe('document output job store', () => {
    afterEach(() => {
        clearDocumentOutputJobsForTests();
    });

    it('keeps reconnectable progress and exposes print handoff explicitly', () => {
        const listener = vi.fn();
        const jobId = 'djvu-print-123';
        const unsubscribe = subscribeDocumentOutputJob(jobId, listener);
        const progress = {
            jobId,
            phase: 'printing' as const,
            percent: 100,
            status: 'running' as const,
        };

        recordDocumentOutputProgress(progress);
        recordDocumentOutputHandoff(jobId, '/tmp/print.pdf', progress);

        expect(getDocumentOutputJobState(jobId)).toMatchObject({
            jobId,
            operation: 'djvu-print',
            status: 'handoff',
            artifactPath: '/tmp/print.pdf',
        });
        expect(listener).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('retains a terminal result for renderer reconnection', () => {
        recordDocumentOutputProgress({
            jobId: 'djvu-convert-123',
            phase: 'optimizing',
            percent: 100,
            status: 'success',
        });

        expect(getDocumentOutputJobState('djvu-convert-123')).toMatchObject({
            operation: 'djvu-convert',
            status: 'completed',
        });
    });
});
