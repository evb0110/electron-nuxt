import {setTimeout as delay} from 'node:timers/promises';

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
