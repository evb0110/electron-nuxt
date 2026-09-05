import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { BrowserDurableDjvuJobs } from '@app/platform/browser-api/browserDurableDjvuJobs';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    requireJobId,
    requireRequestId,
} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';

describe('BrowserDurableDjvuJobs', () => {
    const jobs = new BrowserDurableDjvuJobs(100, 2);
    const failure: FailureReceipt = {
        eventId: '0123456789abcdef0123456789abcdef' as FailureReceipt['eventId'],
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: requireEpochMs(1),
        severity: 'error',
    };

    afterEach(() => {
        jobs.clearForTests();
        vi.useRealTimers();
    });

    it('normalizes unexpected rejections into retained failed results', async () => {
        jobs.startOpen(requireJobId('open-failed'), requireRequestId('request-1'), () => Promise.reject(new Error('decoder crashed')));

        await expect(jobs.awaitOpen(requireJobId('open-failed'))).resolves.toEqual({
            success: false,
            jobId: requireJobId('open-failed'),
            error: 'decoder crashed',
        });
        expect(jobs.getState(requireJobId('open-failed'))).toMatchObject({
            status: 'failed',
            error: 'decoder crashed',
        });
    });

    it('expires terminal jobs after the retention TTL', async () => {
        vi.useFakeTimers();
        jobs.startConvert(requireJobId('convert-expired'), requireRequestId('request-1'), async () => ({success: true}));
        await jobs.awaitConvert(requireJobId('convert-expired'));

        await vi.advanceTimersByTimeAsync(100);

        expect(jobs.getState(requireJobId('convert-expired'))).toBeNull();
        expect(() => jobs.awaitConvert(requireJobId('convert-expired'))).toThrow('Unknown browser DjVu conversion job');
    });

    it('retains conversion failure identity in the terminal result and state', async () => {
        jobs.startConvert(requireJobId('convert-failed'), requireRequestId('request-1'), async () => ({
            success: false,
            error: 'browser conversion failed',
            failure,
        }));

        await expect(jobs.awaitConvert(requireJobId('convert-failed'))).resolves.toEqual({
            success: false,
            jobId: requireJobId('convert-failed'),
            error: 'browser conversion failed',
            failure,
        });
        expect(jobs.getState(requireJobId('convert-failed'))).toMatchObject({
            status: 'failed',
            error: 'browser conversion failed',
            failure,
        });
    });

    it('retains cancellation as an expected terminal outcome without a receipt', async () => {
        jobs.startConvert(requireJobId('convert-canceled'), requireRequestId('request-1'), async () => ({
            success: false,
            error: 'DjVu conversion canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        }));

        await expect(jobs.awaitConvert(requireJobId('convert-canceled'))).resolves.toEqual({
            success: false,
            jobId: requireJobId('convert-canceled'),
            error: 'DjVu conversion canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
        expect(jobs.getState(requireJobId('convert-canceled'))).toMatchObject({
            status: 'canceled',
            expected: {
                kind: 'expected',
                code: 'canceled',
            },
        });
        expect(jobs.getState(requireJobId('convert-canceled'))).not.toHaveProperty('failure');
    });

    it('bounds retained terminal jobs without evicting active work', async () => {
        let resolveActive!: (result: {
            success: true;
            pageCount: number
        }) => void;
        jobs.startOpen(requireJobId('active'), requireRequestId('request-active'), () => new Promise((resolve) => {
            resolveActive = resolve;
        }));
        for (const jobId of [
            requireJobId('finished-1'),
            requireJobId('finished-2'),
            requireJobId('finished-3'),
        ]) {
            jobs.startOpen(jobId, requireRequestId(`request-${jobId}`), async () => ({
                success: true,
                pageCount: 1,
            }));
            await jobs.awaitOpen(jobId);
        }

        expect(jobs.getState(requireJobId('finished-1'))).toBeNull();
        expect(jobs.getState(requireJobId('active'))).toMatchObject({status: 'running'});
        resolveActive({
            success: true,
            pageCount: 2,
        });
        await expect(jobs.awaitOpen(requireJobId('active'))).resolves.toMatchObject({success: true});
    });
});
