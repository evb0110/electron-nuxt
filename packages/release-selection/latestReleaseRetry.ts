interface IHeadersLike {get: (name: string) => string | null}

interface ILatestReleaseRetryOptions<TRelease, TInstaller> {
    fetchRelease: () => Promise<TRelease>
    toInstallers: (release: TRelease) => TInstaller[]
    sleep?: (delayMs: number) => Promise<void>
    retries?: number
}

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 450;
const MAX_RETRY_AFTER_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isHeadersLike(value: unknown): value is IHeadersLike {
    return isRecord(value) && typeof value.get === 'function';
}

function toStatusCode(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

export function getReleaseFetchStatusCode(error: unknown) {
    if (!isRecord(error)) {
        return null;
    }

    const directStatus = toStatusCode(error.statusCode) ?? toStatusCode(error.status);
    if (directStatus !== null) {
        return directStatus;
    }

    return isRecord(error.response) ? toStatusCode(error.response.status) : null;
}

function getRetryAfterHeader(error: unknown) {
    if (!isRecord(error) || !isRecord(error.response) || !isHeadersLike(error.response.headers)) {
        return null;
    }

    return error.response.headers.get('retry-after');
}

export function parseRetryAfterMs(value: string | null, now = Date.now()) {
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    const parsedDelay = Number.isFinite(seconds)
        ? seconds * 1_000
        : Date.parse(value) - now;

    if (!Number.isFinite(parsedDelay)) {
        return null;
    }

    return Math.min(Math.max(0, parsedDelay), MAX_RETRY_AFTER_MS);
}

export function shouldRetryReleaseFetch(error: unknown) {
    const statusCode = getReleaseFetchStatusCode(error);
    return statusCode === null || statusCode === 429 || statusCode >= 500;
}

function sleep(delayMs: number) {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
    });
}

export async function fetchLatestReleaseWithRetry<TRelease, TInstaller>(
    options: ILatestReleaseRetryOptions<TRelease, TInstaller>,
) {
    const retryCount = options.retries ?? DEFAULT_RETRIES;
    const wait = options.sleep ?? sleep;
    let latestEmptyResult: {
        release: TRelease,
        installers: TInstaller[]
    } | null = null;

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
            const release = await options.fetchRelease();
            const installers = options.toInstallers(release);
            const result = {
                release,
                installers,
            };
            if (installers.length || attempt === retryCount) {
                return result;
            }
            latestEmptyResult = result;
        } catch (error) {
            if (attempt === retryCount || !shouldRetryReleaseFetch(error)) {
                throw error;
            }

            const retryAfterMs = parseRetryAfterMs(getRetryAfterHeader(error));
            await wait(retryAfterMs ?? DEFAULT_RETRY_DELAY_MS * (attempt + 1));
            continue;
        }

        await wait(DEFAULT_RETRY_DELAY_MS * (attempt + 1));
    }

    if (latestEmptyResult) {
        return latestEmptyResult;
    }

    throw new Error('Latest release fetch exhausted without a result.');
}
