import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    fetchLatestReleaseWithRetry,
    parseRetryAfterMs,
    shouldRetryReleaseFetch,
} from '@releaseSelection';

interface IReleaseFixture {
    assets: string[]
    tag: string
}

function createResponseError(status: number, retryAfter: string | null = null) {
    return {response: {
        status,
        headers: {get: (name: string) => name === 'retry-after' ? retryAfter : null},
    }};
}

function createOptions(fetchRelease: () => Promise<IReleaseFixture>) {
    return {
        fetchRelease,
        sleep: vi.fn(async () => {}),
        toInstallers: (release: IReleaseFixture) => release.assets,
    };
}

describe('latest landing release retry', () => {
    it('retries an initial server failure and returns the first usable release', async () => {
        const fetchRelease = vi.fn()
            .mockRejectedValueOnce(createResponseError(503))
            .mockResolvedValue({
                tag: 'v2',
                assets: ['installer'],
            });
        const options = createOptions(fetchRelease);

        await expect(fetchLatestReleaseWithRetry(options)).resolves.toEqual({
            release: {
                tag: 'v2',
                assets: ['installer'],
            },
            installers: ['installer'],
        });
        expect(fetchRelease).toHaveBeenCalledTimes(2);
        expect(options.sleep).toHaveBeenCalledWith(450);
    });

    it('honors a bounded Retry-After delay for rate limits', async () => {
        const fetchRelease = vi.fn()
            .mockRejectedValueOnce(createResponseError(429, '2'))
            .mockResolvedValue({
                tag: 'v2',
                assets: ['installer'],
            });
        const options = createOptions(fetchRelease);

        await fetchLatestReleaseWithRetry(options);

        expect(options.sleep).toHaveBeenCalledWith(2_000);
        expect(parseRetryAfterMs('60')).toBe(10_000);
    });

    it('does not retry a permanent client error', async () => {
        const error = createResponseError(404);
        const fetchRelease = vi.fn().mockRejectedValue(error);
        const options = createOptions(fetchRelease);

        await expect(fetchLatestReleaseWithRetry(options)).rejects.toBe(error);
        expect(fetchRelease).toHaveBeenCalledTimes(1);
        expect(options.sleep).not.toHaveBeenCalled();
        expect(shouldRetryReleaseFetch(error)).toBe(false);
    });

    it('bounds repeated network failures to the configured attempt count', async () => {
        const error = new Error('socket closed');
        const fetchRelease = vi.fn().mockRejectedValue(error);
        const options = createOptions(fetchRelease);

        await expect(fetchLatestReleaseWithRetry(options)).rejects.toBe(error);
        expect(fetchRelease).toHaveBeenCalledTimes(3);
        expect(options.sleep).toHaveBeenCalledTimes(2);
    });

    it('retries empty releases but preserves the final empty response', async () => {
        const fetchRelease = vi.fn()
            .mockResolvedValueOnce({
                tag: 'v1',
                assets: [],
            })
            .mockResolvedValueOnce({
                tag: 'v2',
                assets: [],
            })
            .mockResolvedValue({
                tag: 'v3',
                assets: [],
            });
        const options = createOptions(fetchRelease);

        await expect(fetchLatestReleaseWithRetry(options)).resolves.toEqual({
            release: {
                tag: 'v3',
                assets: [],
            },
            installers: [],
        });
        expect(fetchRelease).toHaveBeenCalledTimes(3);
    });
});
