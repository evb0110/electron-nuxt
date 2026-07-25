import type {TPerformanceMode} from '@contracts/hostResourceProfile';
import {BROWSER_SETTINGS_COOKIE_KEY} from '@app/utils/browserSettingsPersistence';
import {
    stabilizeSharedRendererClient,
    startElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';

export async function startConfiguredElectronE2ESession(
    baseName: string,
    performanceMode: TPerformanceMode,
) {
    // The env override drives the main-process profile; the settings cookie
    // drives the renderer fallback used by harness-adopted windows that carry
    // no host-profile launch argument.
    const session = await startElectronE2ESession(baseName, {
        clean: true,
        extraEnv: {EVB_TEST_PERFORMANCE_MODE: performanceMode},
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
    await session.page.reload({waitUntil: 'domcontentloaded'});
    await stabilizeSharedRendererClient(session.page);
    return session;
}
