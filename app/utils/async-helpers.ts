import { until } from '@vueuse/core';

interface IWaitUntilIdleOptions {
    delayMs?: number;
    maxAttempts?: number;
}

export async function waitUntilIdle(
    isBusy: () => boolean,
    options: IWaitUntilIdleOptions = {},
) {
    const {
        delayMs = 25,
        maxAttempts = 120,
    } = options;
    const timeout = Math.max(0, delayMs * maxAttempts);
    if (timeout === 0) {
        return;
    }

    try {
        await until(() => !isBusy()).toBe(true, { timeout });
    } catch {
        // Preserve previous behavior: idle wait is best-effort and never throws.
    }
}
