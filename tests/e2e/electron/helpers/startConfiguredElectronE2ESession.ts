import {DEFAULT_SETTINGS} from '@contracts/settings';
import type {TPerformanceMode} from '@contracts/hostResourceProfile';
import {stopSingleSession} from '@scripts/electron-run/sessionManager';
import {startElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';

export async function startConfiguredElectronE2ESession(
    baseName: string,
    performanceMode: TPerformanceMode,
    initialOpenPaths: string[],
) {
    const bootstrap = await startElectronE2ESession(baseName, {clean: true});
    await bootstrap.page.evaluate(async (settings) => {
        await window.electronAPI?.settings.save(settings);
    }, {
        ...DEFAULT_SETTINGS,
        performanceMode,
    });
    await bootstrap.browser.disconnect();
    await stopSingleSession(bootstrap.name, {keepNuxt: true});
    return startElectronE2ESession(baseName, {
        clean: false,
        initialOpenPaths,
    });
}
