import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { documentOutputService } from '@electron/output/documentOutputService';
import {
    getOcrJobProjection,
    registerOcrJobProjectionPolicy,
    subscribeOcrJobProjection,
} from '@electron/ocr/ocrJobProjection';

describe('OCR durable job projection', () => {
    beforeEach(() => {
        documentOutputService.clearForTests();
    });

    it('reconnects to retained state after the original subscriber is gone', () => {
        documentOutputService.start({
            jobId: '41:ocr-reload',
            operation: 'ocr-projection',
            sourceKind: 'pdf',
            initialPhase: 'queued',
        });
        documentOutputService.update('41:ocr-reload', {
            phase: 'processing',
            percent: 50,
            current: 2,
            total: 4,
        });
        registerOcrJobProjectionPolicy('41:ocr-reload', 'replace-all', true);

        expect(getOcrJobProjection(41, 'ocr-reload')).toMatchObject({
            requestId: 'ocr-reload',
            status: 'running',
            phase: 'processing',
            percent: 50,
            current: 2,
            total: 4,
            supersessionPolicy: 'replace-all',
            replaceAllAcknowledged: true,
        });

        documentOutputService.finish('41:ocr-reload', 'completed');
        expect(getOcrJobProjection(41, 'ocr-reload')).toMatchObject({
            status: 'completed',
            percent: 100,
            supersessionPolicy: 'replace-all',
        });
    });

    it('streams updates only for the scoped renderer job', () => {
        documentOutputService.start({
            jobId: '7:shared-id',
            operation: 'ocr-projection',
            sourceKind: 'pdf',
        });
        documentOutputService.start({
            jobId: '8:shared-id',
            operation: 'ocr-projection',
            sourceKind: 'pdf',
        });
        const listener = vi.fn();
        const unsubscribe = subscribeOcrJobProjection(7, 'shared-id', listener);

        documentOutputService.update('8:shared-id', {
            phase: 'processing',
            percent: 10,
        });
        expect(listener).not.toHaveBeenCalled();
        documentOutputService.update('7:shared-id', {
            phase: 'merging',
            percent: 80,
        });
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({
            jobId: '7:shared-id',
            phase: 'merging',
            percent: 80,
        }));

        unsubscribe();
    });
});
