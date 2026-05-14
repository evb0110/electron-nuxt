import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { sendCommand } from '../electron-run/client';
import { setCurrentSessionName } from '../electron-run/electronRunSessionPaths';

interface IOptions {
    fixture: string;
    tabs: number;
    cycles: number;
    out: string | null;
    session: string;
    idleMs: number;
    collectGc: boolean;
}

interface IPageMetricsPayload {
    section: string;
    metrics?: Record<string, number>;
    viewport?: unknown;
    url?: string;
}

interface IDomPressureSnapshot {
    workspaceHosts: number;
    visibleWorkspaceHosts: number;
    activeWorkspaceHosts: number;
    pdfViewers: number;
    renderedPages: number;
    canvases: number;
    canvasPixels: number;
    textSpans: number;
    annotationLayerNodes: number;
    djvuImages: number;
    hosts: IWorkspacePressureSnapshot[];
}

interface IWorkspacePressureSnapshot {
    index: number;
    active: boolean;
    visible: boolean;
    pdfViewers: number;
    renderedPages: number;
    canvases: number;
    canvasPixels: number;
    textSpans: number;
    annotationLayerNodes: number;
    djvuImages: number;
}

interface IDiagnosticSnapshot {
    label: string;
    at: string;
    metrics: Record<string, number>;
    dom: IDomPressureSnapshot;
    warnings: string[];
}

const DEFAULT_FIXTURE = 'tests/fixtures/electron/generated-text.pdf';

function parsePositiveInt(value: string | undefined, fallback: number) {
    const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptions(argv = process.argv.slice(2)): IOptions {
    const options: IOptions = {
        fixture: DEFAULT_FIXTURE,
        tabs: 4,
        cycles: 2,
        out: '.tmp/pdf-tab-pressure.json',
        session: 'default',
        idleMs: 750,
        collectGc: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === '--fixture' && next) {
            options.fixture = next;
            index += 1;
        } else if (arg === '--tabs' && next) {
            options.tabs = parsePositiveInt(next, options.tabs);
            index += 1;
        } else if (arg === '--cycles' && next) {
            options.cycles = parsePositiveInt(next, options.cycles);
            index += 1;
        } else if (arg === '--out' && next) {
            options.out = next === '-' ? null : next;
            index += 1;
        } else if (arg === '--session' && next) {
            options.session = next;
            index += 1;
        } else if (arg === '--idle-ms' && next) {
            options.idleMs = parsePositiveInt(next, options.idleMs);
            index += 1;
        } else if (arg === '--gc') {
            options.collectGc = true;
        }
    }

    return options;
}

async function waitForIdle(ms: number) {
    await sendCommand('run', [`await sleep(${JSON.stringify(ms)});`]);
}

async function collectGarbageIfRequested(collectGc: boolean) {
    if (!collectGc) {
        return;
    }

    await sendCommand('run', [`
        const client = await page.target().createCDPSession();
        try {
            await client.send('HeapProfiler.collectGarbage');
        } finally {
            await client.detach();
        }
    `]);
}

async function openFixtureInActiveTab(fixture: string) {
    await sendCommand('run', [`
        const fixturePath = ${JSON.stringify(fixture)};
        await page.evaluate(async (path) => {
            const automationGrant = window.__allowRendererFileOpenForAutomation;
            if (typeof automationGrant === 'function') {
                await automationGrant(path);
            }

            try {
                await window.electronAPI?.documents?.recentFiles?.add?.(path);
            } catch {
                // Recent-file writes are not required for diagnostics.
            }

            const openFileDirect = window.__openFileDirect;
            if (typeof openFileDirect !== 'function') {
                throw new Error('window.__openFileDirect is not available');
            }
            await openFileDirect(path);
        }, fixturePath);
    `], 150_000);
}

async function createTabAndOpenFixture(fixture: string) {
    await sendCommand('run', [`
        const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(modifier);
        await page.keyboard.press('KeyT');
        await page.keyboard.up(modifier);
        await sleep(250);
    `]);
    await openFixtureInActiveTab(fixture);
}

async function activateTabByIndex(index: number) {
    await sendCommand('run', [`
        const tabs = await page.$$('.tab-bar [role="tab"], [data-tab-id], .tab-bar__tab');
        const target = tabs[${JSON.stringify(index)}];
        if (target) {
            await target.click();
        }
        await sleep(250);
    `]);
}

async function collectDomPressure(): Promise<IDomPressureSnapshot> {
    return await sendCommand('eval', [`
        (() => {
            const isVisible = (element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 0
                    && rect.height > 0;
            };
            const countCanvasPixels = (root) => Array.from(root.querySelectorAll('canvas'))
                .reduce((total, canvas) => total + ((canvas.width || 0) * (canvas.height || 0)), 0);
            const summarizeHost = (host, index) => {
                const visible = isVisible(host);
                return {
                    index,
                    active: visible && Boolean(host.closest('.editor-group-pane.is-active')),
                    visible,
                    pdfViewers: host.querySelectorAll('#pdf-viewer, .pdfViewer').length,
                    renderedPages: host.querySelectorAll('.page_container--rendered').length,
                    canvases: host.querySelectorAll('canvas').length,
                    canvasPixels: countCanvasPixels(host),
                    textSpans: host.querySelectorAll('.text-layer span, .textLayer span').length,
                    annotationLayerNodes: host.querySelectorAll('.annotation-layer *, .annotation-editor-layer *').length,
                    djvuImages: host.querySelectorAll('.djvu-page-shell img').length,
                };
            };
            const canvases = Array.from(document.querySelectorAll('canvas'));
            const hosts = Array.from(document.querySelectorAll('.workspace-host')).map(summarizeHost);
            return {
                workspaceHosts: hosts.length,
                visibleWorkspaceHosts: hosts.filter(host => host.visible).length,
                activeWorkspaceHosts: hosts.filter(host => host.active).length,
                pdfViewers: document.querySelectorAll('#pdf-viewer, .pdfViewer').length,
                renderedPages: document.querySelectorAll('.page_container--rendered').length,
                canvases: canvases.length,
                canvasPixels: canvases.reduce((total, canvas) => total + ((canvas.width || 0) * (canvas.height || 0)), 0),
                textSpans: document.querySelectorAll('.text-layer span, .textLayer span').length,
                annotationLayerNodes: document.querySelectorAll('.annotation-layer *, .annotation-editor-layer *').length,
                djvuImages: document.querySelectorAll('.djvu-page-shell img').length,
                hosts,
            };
        })()
    `]) as IDomPressureSnapshot;
}

function buildSnapshotWarnings(dom: IDomPressureSnapshot) {
    const warnings: string[] = [];
    const inactiveHostsWithCanvases = dom.hosts.filter(host => !host.active && host.canvases > 0);
    if (inactiveHostsWithCanvases.length > 0) {
        warnings.push(`Inactive hosts still have ${inactiveHostsWithCanvases.reduce((total, host) => total + host.canvases, 0)} canvas element(s).`);
    }

    const inactiveHostsWithRenderedPages = dom.hosts.filter(host => !host.active && host.renderedPages > 0);
    if (inactiveHostsWithRenderedPages.length > 0) {
        warnings.push(`Inactive hosts still have ${inactiveHostsWithRenderedPages.reduce((total, host) => total + host.renderedPages, 0)} rendered page(s).`);
    }

    return warnings;
}

async function collectSnapshot(label: string, options: Pick<IOptions, 'collectGc'>): Promise<IDiagnosticSnapshot> {
    await collectGarbageIfRequested(options.collectGc);
    const [
        metricsPayload,
        dom,
    ] = await Promise.all([
        sendCommand('devtools', ['metrics']) as Promise<IPageMetricsPayload>,
        collectDomPressure(),
    ]);

    return {
        label,
        at: new Date().toISOString(),
        metrics: metricsPayload.metrics ?? {},
        dom,
        warnings: buildSnapshotWarnings(dom),
    };
}

async function runDiagnostics(options: IOptions) {
    setCurrentSessionName(options.session);
    const fixture = resolve(options.fixture);
    const snapshots: IDiagnosticSnapshot[] = [];

    snapshots.push(await collectSnapshot('baseline', options));
    await openFixtureInActiveTab(fixture);
    await waitForIdle(options.idleMs);
    snapshots.push(await collectSnapshot('tab-1-opened', options));

    for (let index = 1; index < options.tabs; index += 1) {
        await createTabAndOpenFixture(fixture);
        await waitForIdle(options.idleMs);
        snapshots.push(await collectSnapshot(`tab-${index + 1}-opened`, options));
    }

    for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
        for (let index = 0; index < options.tabs; index += 1) {
            await activateTabByIndex(index);
            await waitForIdle(options.idleMs);
            snapshots.push(await collectSnapshot(`cycle-${cycle}-tab-${index + 1}`, options));
        }
    }

    const warnings = snapshots.flatMap(snapshot => snapshot.warnings.map(warning => `${snapshot.label}: ${warning}`));

    return {
        fixture,
        tabs: options.tabs,
        cycles: options.cycles,
        idleMs: options.idleMs,
        collectGc: options.collectGc,
        generatedAt: new Date().toISOString(),
        warnings,
        snapshots,
    };
}

const options = readOptions();
const result = await runDiagnostics(options);
const output = JSON.stringify(result, null, 2);

if (options.out) {
    const outPath = resolve(options.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${output}\n`);
    console.log(`Wrote PDF tab pressure diagnostics to ${outPath}`);
    if (result.warnings.length > 0) {
        console.warn(`Diagnostics completed with ${result.warnings.length} warning(s). See ${outPath}`);
    }
} else {
    console.log(output);
}
