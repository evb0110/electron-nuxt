import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DocumentOutputService } from '@electron/output/documentOutputService';

describe('DocumentOutputService', () => {
    const service = new DocumentOutputService();

    afterEach(() => {
        service.clearForTests();
        vi.useRealTimers();
    });

    it('keeps source-neutral state through progress, handoff, and completion', () => {
        const handle = service.start({
            jobId: 'output-1',
            operation: 'scan-cleanup',
            sourceKind: 'pdf',
        });
        const listener = vi.fn();
        service.subscribe(handle.jobId, listener);
        service.update(handle.jobId, {
            phase: 'rendering',
            current: 2,
            total: 4,
            percent: 50,
        });
        service.handoff(handle.jobId, '/tmp/output.tiff');
        service.finish(handle.jobId, 'completed');

        expect(listener).toHaveBeenCalledTimes(3);
        expect(service.getState(handle.jobId)).toMatchObject({
            operation: 'scan-cleanup',
            sourceKind: 'pdf',
            status: 'completed',
            artifactPath: '/tmp/output.tiff',
        });
    });

    it('cancels through the job handle signal', () => {
        const handle = service.start({
            operation: 'ocr-projection',
            sourceKind: 'pdf',
        });
        expect(service.cancel(handle.jobId, 'stop')).toBe(true);
        expect(handle.signal.aborted).toBe(true);
        expect(service.getState(handle.jobId)).toMatchObject({status: 'canceled'});
    });

    it('does not let late completion overwrite cancellation', () => {
        const handle = service.start({
            jobId: 'cancel-race',
            operation: 'scan-cleanup',
            sourceKind: 'pdf',
        });
        service.cancel(handle.jobId, 'superseded');
        service.finish(handle.jobId, 'completed');

        expect(service.getState(handle.jobId)).toMatchObject({
            status: 'canceled',
            error: 'superseded',
        });
    });

    it('does not let a stale terminal cleanup delete a reused job ID', () => {
        vi.useFakeTimers();
        const shortRetentionService = new DocumentOutputService(100);
        const first = shortRetentionService.start({
            jobId: 'reused-output',
            operation: 'scan-cleanup',
            sourceKind: 'pdf',
        });
        shortRetentionService.finish(first.jobId, 'completed');
        vi.advanceTimersByTime(50);

        const replacement = shortRetentionService.start({
            jobId: first.jobId,
            operation: 'save-as-pdf',
            sourceKind: 'pdf',
        });
        vi.advanceTimersByTime(100);

        expect(shortRetentionService.getState(replacement.jobId)).toMatchObject({
            operation: 'save-as-pdf',
            status: 'queued',
        });
        shortRetentionService.clearForTests();
        vi.useRealTimers();
    });
});
