import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IDjvuOperationContext } from '@electron/features/djvu/ports';
import { documentOutputService } from '@electron/output/documentOutputService';
import {requireOpenPath} from '@electron/file-access/openPathCapabilities';
import {
    awaitDurableDjvuConvertJob,
    awaitDurableDjvuOpenJob,
    cancelDurableDjvuJob,
    clearDurableDjvuJobsForTests,
    startDurableDjvuConvertJob,
    startDurableDjvuOpenJob,
} from '@electron/features/djvu/main/durableDjvuJobs';

const viewingMocks = vi.hoisted(() => ({adoptDjvuViewingPath: vi.fn()}));
const openPathMocks = vi.hoisted(() => ({
    allowOpenPath: vi.fn(),
    requireOpenPath: vi.fn((path: string) => path),
}));

vi.mock('@electron/features/djvu/main/viewing', () => viewingMocks);
vi.mock('@electron/file-access/openPathCapabilities', () => openPathMocks);

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

const context = {senderId: 42} as IDjvuOperationContext;

describe('durable DjVu jobs', () => {
    afterEach(() => {
        clearDurableDjvuJobsForTests();
        documentOutputService.clearForTests();
        viewingMocks.adoptDjvuViewingPath.mockReset();
        openPathMocks.allowOpenPath.mockReset();
    });

    it('publishes an open handle before work settles and adopts without re-probing on await', async () => {
        const work = deferred<{
            success: true;
            pageCount: number
        }>();
        const run = vi.fn(() => work.promise);
        startDurableDjvuOpenJob('djvu-open-reload', requireOpenPath('/tmp/source.djvu', 42), run);
        expect(documentOutputService.getState('djvu-open-reload')).toMatchObject({
            operation: 'djvu-open',
            status: 'queued',
        });

        work.resolve({
            success: true,
            pageCount: 3,
        });
        await expect(awaitDurableDjvuOpenJob(context, 'djvu-open-reload')).resolves.toMatchObject({
            success: true,
            jobId: 'djvu-open-reload',
            pageCount: 3,
        });
        expect(viewingMocks.adoptDjvuViewingPath).toHaveBeenCalledWith(
            context,
            '/tmp/source.djvu',
        );
        expect(documentOutputService.getState('djvu-open-reload')).toMatchObject({status: 'completed'});
    });

    it('cancels open metadata through the durable signal and preserves canceled state', async () => {
        let receivedSignal: AbortSignal | undefined;
        startDurableDjvuOpenJob('djvu-open-cancel', requireOpenPath('/tmp/source.djvu', 42), async (signal) => {
            receivedSignal = signal;
            await Promise.resolve();
            return {
                success: true,
                pageCount: 1,
            };
        });
        await Promise.resolve();

        expect(cancelDurableDjvuJob('djvu-open-cancel', 'superseded')).toBe(true);
        expect(receivedSignal?.aborted).toBe(true);
        await expect(awaitDurableDjvuOpenJob(context, 'djvu-open-cancel')).resolves.toMatchObject({
            success: false,
            error: 'superseded',
        });
        expect(documentOutputService.getState('djvu-open-cancel')).toMatchObject({status: 'canceled'});
        expect(viewingMocks.adoptDjvuViewingPath).not.toHaveBeenCalled();
    });

    it('retains conversion identity independently from the initiating renderer', async () => {
        const work = deferred<{
            success: true;
            jobId: string;
            pdfPath: string
        }>();
        startDurableDjvuConvertJob('djvu-convert-reload', () => work.promise);

        expect(documentOutputService.getState('djvu-convert-reload')).toMatchObject({status: 'queued'});
        work.resolve({
            success: true,
            jobId: 'djvu-convert-reload',
            pdfPath: '/tmp/output.pdf',
        });
        await expect(awaitDurableDjvuConvertJob(context, 'djvu-convert-reload')).resolves.toMatchObject({
            success: true,
            jobId: 'djvu-convert-reload',
        });
        expect(openPathMocks.allowOpenPath).toHaveBeenCalledWith('/tmp/output.pdf', context.sender);
    });

    it('retains at most 64 completed jobs', async () => {
        for (let index = 0; index < 65; index += 1) {
            const jobId = `bounded-convert-${index}`;
            startDurableDjvuConvertJob(jobId, async () => ({
                success: true,
                jobId,
                pdfPath: `/tmp/${jobId}.pdf`,
            }));
        }
        await new Promise(resolve => setImmediate(resolve));

        await expect(awaitDurableDjvuConvertJob(context, 'bounded-convert-0'))
            .rejects.toThrow('Unknown or expired');
        await expect(awaitDurableDjvuConvertJob(context, 'bounded-convert-64'))
            .resolves.toMatchObject({success: true});
    });
});
