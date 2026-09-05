import {setTimeout as delay} from 'node:timers/promises';

interface IPackagedRendererPage {
    isClosed(): boolean;
    url(): string;
}

interface IPackagedRendererBrowser<TPage extends IPackagedRendererPage> {pages(): Promise<TPage[]>;}

export async function waitForPackagedCdpEndpoint(
    port: number,
    timeoutMs: number,
    applicationName: string,
) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) {
                const payload = await response.json() as {webSocketDebuggerUrl?: string};
                if (payload.webSocketDebuggerUrl) {
                    return payload.webSocketDebuggerUrl;
                }
            }
        } catch {
            // The packaged application is still starting.
        }
        await delay(250);
    }
    throw new Error(`${applicationName} did not expose CDP on port ${port}`);
}

export async function waitForPackagedRendererPage<TPage extends IPackagedRendererPage>(
    browser: IPackagedRendererBrowser<TPage>,
    timeoutMs: number,
    applicationName: string,
    pollIntervalMs = 100,
) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pages = await browser.pages();
        const page = pages.find(candidate => candidate.url().startsWith('evb-viewer://app/'))
            ?? pages.find(candidate => !candidate.isClosed());
        if (page) {
            return page;
        }
        await delay(pollIntervalMs);
    }
    throw new Error(`${applicationName} exposed no renderer page within ${timeoutMs}ms`);
}
