import type {
    CDPSession,
    Page,
} from 'puppeteer-core';
import type { IStressHostProfile } from '@scripts/stress/stressTypes';

export interface IAppliedStressHostProfile {
    profile: IStressHostProfile;
    cdpSession: CDPSession;
    /** Idempotent: resets throttling to 1x before detaching so no session leaks a throttled renderer. */
    release: () => Promise<void>;
}

const RELEASE_TIMEOUT_MS = 5_000;

async function withTimeout<T>(label: string, timeoutMs: number, task: Promise<T>) {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
        return await Promise.race([
            task,
            timeout,
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * `Emulation.setCPUThrottlingRate` slows only the renderer main thread of the
 * attached target. PDF.js workers, the Electron main process, and native
 * helpers keep full speed, which is why SLOW-B exists for cgroup-level limits.
 */
export async function applyStressHostProfile(page: Page, profile: IStressHostProfile): Promise<IAppliedStressHostProfile> {
    const cdpSession = await page.createCDPSession();
    try {
        await page.setViewport({
            width: profile.deviceMetrics.width,
            height: profile.deviceMetrics.height,
            deviceScaleFactor: profile.deviceMetrics.deviceScaleFactor,
        });
        if (profile.cpuThrottlingRate > 1) {
            await cdpSession.send('Emulation.setCPUThrottlingRate', {rate: profile.cpuThrottlingRate});
        }
    } catch (error) {
        await cdpSession.detach().catch(() => undefined);
        throw error;
    }

    let releasePromise: Promise<void> | null = null;
    const release = () => {
        releasePromise ??= (async () => {
            if (profile.cpuThrottlingRate > 1) {
                try {
                    await withTimeout(
                        'reset CPU throttling',
                        RELEASE_TIMEOUT_MS,
                        cdpSession.send('Emulation.setCPUThrottlingRate', {rate: 1}),
                    );
                } catch {
                    // The renderer may already be gone; detaching below is all that is left.
                }
            }
            try {
                await withTimeout('detach CDP session', RELEASE_TIMEOUT_MS, cdpSession.detach());
            } catch {
                // Detach failures after a crash are expected and harmless.
            }
        })();
        return releasePromise;
    };

    return {
        profile,
        cdpSession,
        release,
    };
}
