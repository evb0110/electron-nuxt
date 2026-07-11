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

    afterEach(() => service.clearForTests());

    it('keeps source-neutral state through progress, handoff, and completion', () => {
        const handle = service.start({
            jobId: 'output-1',
            operation: 'multipage-tiff',
            sourceKind: 'djvu',
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
            operation: 'multipage-tiff',
            sourceKind: 'djvu',
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
            operation: 'djvu-open',
            sourceKind: 'djvu',
        });
        service.cancel(handle.jobId, 'superseded');
        service.finish(handle.jobId, 'completed');

        expect(service.getState(handle.jobId)).toMatchObject({
            status: 'canceled',
            error: 'superseded',
        });
    });
});
