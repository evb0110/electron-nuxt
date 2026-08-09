import type {TPerformanceMode} from '@contracts/hostResourceProfile';
import {BROWSER_SETTINGS_COOKIE_KEY} from '@app/utils/browserSettingsPersistence';
import {
    stabilizeSharedRendererClient,
    startElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';

async function setReducedMotionPreference(page: Parameters<typeof stabilizeSharedRendererClient>[0]) {
    const client = await page.createCDPSession();
    try {
        await client.send('Emulation.setEmulatedMedia', {features: [{
            name: 'prefers-reduced-motion',
            value: 'no-preference',
        }]});
    } finally {
        await client.detach();
    }
}

export async function startConfiguredElectronE2ESession(
    baseName: string,
    performanceMode: TPerformanceMode,
) {
    // The env override drives the main-process profile; the settings cookie
    // drives the renderer fallback used by harness-adopted windows that carry
    // no host-profile launch argument.
    const session = await startElectronE2ESession(baseName, {
        clean: true,
        extraEnv: {
            EVB_E2E_FORCE_NO_REDUCED_MOTION: '1',
            EVB_TEST_PERFORMANCE_MODE: performanceMode,
        },
    });
    await session.page.evaluate((payload: {
        cookieKey: string;
        performanceMode: TPerformanceMode;
    }) => {
        document.cookie = `${payload.cookieKey}=${encodeURIComponent(JSON.stringify({performanceMode: payload.performanceMode}))}; path=/`;
    }, {
        cookieKey: BROWSER_SETTINGS_COOKIE_KEY,
        performanceMode,
    });
    // Apply the neutral media baseline before the configured reload. The
    // performance-profile plugin reads matchMedia during module startup, so
    // changing the emulation after reload leaves the initial root class stale
    // on runners whose host preferences request reduced motion.
    await setReducedMotionPreference(session.page);
    await session.page.reload({waitUntil: 'domcontentloaded'});
    await stabilizeSharedRendererClient(session.page);
    return session;
}
