import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

let devServer: ChildProcess | null = null;
let origin = '';
let serverOutput = '';
interface IBrowserLifecycleTestApi {waitForActiveDocumentOpenSettled?: () => Promise<boolean>;}

async function reservePort() {
    const reservation = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
        reservation.once('error', rejectListen);
        reservation.listen(0, '127.0.0.1', resolveListen);
    });
    const address = reservation.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser lifecycle test could not reserve a port');
    }
    await new Promise<void>(resolveClose => reservation.close(() => resolveClose()));
    return address.port;
}

async function waitForServer(url: string) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (devServer?.exitCode !== null) {
            throw new Error(`Nuxt exited before becoming ready:\n${serverOutput.slice(-8_000)}`);
        }
        try {
            const response = await fetch(url);
            if (response.ok) {
                return;
            }
        } catch {
            // The development server is still compiling or binding.
        }
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    throw new Error(`Timed out waiting for Nuxt:\n${serverOutput.slice(-8_000)}`);
}

async function stopServer() {
    const server = devServer;
    devServer = null;
    if (!server || server.exitCode !== null) {
        return;
    }
    server.kill('SIGTERM');
    await Promise.race([
        new Promise<void>(resolveExit => server.once('exit', () => resolveExit())),
        new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
    ]);
    if (server.exitCode === null) {
        server.kill('SIGKILL');
    }
}

beforeAll(async () => {
    const port = await reservePort();
    origin = `http://127.0.0.1:${String(port)}`;
    devServer = spawn('pnpm', [
        'exec',
        'nuxi',
        'dev',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
    ], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            NODE_ENV: 'test',
        },
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });
    const captureOutput = (chunk: Buffer) => {
        serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
    };
    devServer.stdout?.on('data', captureOutput);
    devServer.stderr?.on('data', captureOutput);
    await waitForServer(origin);
}, 120_000);

afterAll(async () => {
    await stopServer();
});

describe('browser document lifecycle UI', () => {
    it('keeps the rendered document and tab identity after a corrupt replacement is rejected', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage({viewport: {
                width: 1_280,
                height: 900,
            }});
            await page.addInitScript(() => {
                Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
            });
            await page.goto(origin, {waitUntil: 'domcontentloaded'});
            await page.evaluate(() => {
                window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
            });

            const validChooserPromise = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Open File',
                exact: true,
            }).first().click();
            const validChooser = await validChooserPromise;
            await validChooser.setFiles(resolve(
                process.cwd(),
                'tests/fixtures/electron/generated-text.pdf',
            ));

            const renderedCanvas = page.locator('.page_container--rendered canvas').first();
            await renderedCanvas.waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await page.evaluate(async () => {
                const testApi = Reflect.get(window, '__evbTestApi') as IBrowserLifecycleTestApi | undefined;
                if (!await testApi?.waitForActiveDocumentOpenSettled?.()) {
                    throw new Error('Active browser document did not settle');
                }
            });
            const activeTab = page.locator('[role="tab"][aria-selected="true"]');
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            const canvasCountBefore = await page.locator('.page_container--rendered canvas').count();

            const corruptChooserPromise = page.waitForEvent('filechooser');
            await page.keyboard.press('Control+O');
            const corruptChooser = await corruptChooserPromise;
            await corruptChooser.setFiles({
                name: 'corrupt-replacement.pdf',
                mimeType: 'application/pdf',
                buffer: Buffer.from('%PDF-1.7\ncorrupt and truncated'),
            });

            await page.getByTestId('workspace-document-pdf-error').waitFor({
                state: 'visible',
                timeout: 30_000,
            });
            await expect.poll(() => activeTab.textContent()).toContain('generated-text.pdf');
            await expect.poll(() => renderedCanvas.isVisible()).toBe(true);
            expect(await page.locator('.page_container--rendered canvas').count())
                .toBe(canvasCountBefore);
        } finally {
            await browser.close();
        }
    }, 90_000);
});
