import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { BrowserDurableDjvuJobs } from '@app/platform/browser-api/browserDurableDjvuJobs';

describe('BrowserDurableDjvuJobs', () => {
    const jobs = new BrowserDurableDjvuJobs(100, 2);

    afterEach(() => {
        jobs.clearForTests();
        vi.useRealTimers();
    });

    it('normalizes unexpected rejections into retained failed results', async () => {
        jobs.startOpen('open-failed', 'request-1', () => Promise.reject(new Error('decoder crashed')));

        await expect(jobs.awaitOpen('open-failed')).resolves.toEqual({
            success: false,
            jobId: 'open-failed',
            error: 'decoder crashed',
        });
        expect(jobs.getState('open-failed')).toMatchObject({
            status: 'failed',
            error: 'decoder crashed',
        });
    });

    it('expires terminal jobs after the retention TTL', async () => {
        vi.useFakeTimers();
        jobs.startConvert('convert-expired', 'request-1', async () => ({success: true}));
        await jobs.awaitConvert('convert-expired');

        await vi.advanceTimersByTimeAsync(100);

        expect(jobs.getState('convert-expired')).toBeNull();
        expect(() => jobs.awaitConvert('convert-expired')).toThrow('Unknown browser DjVu conversion job');
    });

    it('bounds retained terminal jobs without evicting active work', async () => {
        let resolveActive!: (result: {
            success: true;
            pageCount: number
        }) => void;
        jobs.startOpen('active', 'request-active', () => new Promise((resolve) => {
            resolveActive = resolve;
        }));
        for (const jobId of [
            'finished-1',
            'finished-2',
            'finished-3',
        ]) {
            jobs.startOpen(jobId, `request-${jobId}`, async () => ({
                success: true,
                pageCount: 1,
            }));
            await jobs.awaitOpen(jobId);
        }

        expect(jobs.getState('finished-1')).toBeNull();
        expect(jobs.getState('active')).toMatchObject({status: 'running'});
        resolveActive({
            success: true,
            pageCount: 2,
        });
        await expect(jobs.awaitOpen('active')).resolves.toMatchObject({success: true});
    });
});
