import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {createLargeScannedFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    evaluateInPage,
    waitForFunctionInPage,
} from '@tests/e2e/electron/helpers/pageRuntime';
import {
    clickVisibleToolbarButton,
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import type {IWorkspaceExposeProbeWindow} from '@tests/e2e/electron/helpers/workspaceExpose';

const REFERENCE_PAGE_COUNT = 392;
const EVIDENCE_BASE_DIR = resolve(
    process.cwd(),
    '.devkit',
    'test',
    'electron-e2e-artifacts',
);

// Elements that must hold still while scan-cleanup state changes. They sit
// below or beside the controls the user operates, which is exactly where the
// reported shifts were visible.
const ANCHORS: Readonly<Record<string, string>> = {
    previewLegend: '.overlay-legend',
    previewSurface: '.preview-surface',
    previewComparison: '.preview-controls .scan-cleanup-segmented',
    previewNext: '.page-navigation button:last-of-type',
    settingsScroll: '.scan-cleanup-settings-scroll',
    documentSettingsGroup: '.scan-cleanup-option-group:last-of-type',
    settingsFootnote: '.scan-cleanup-footnote',
    toolbarPrimary: '.scan-cleanup-toolbar-primary-slot',
    toolbarStatus: '.scan-cleanup-toolbar-status-slot',
};

interface IAnchorSample {
    scrollTop: number;
    rects: Record<string, {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null>;
}

interface IGeometryFinding {
    transition: string;
    anchor: string;
    axis: 'x' | 'y';
    before: number;
    after: number;
}

interface IComparisonLayerSample {
    className: string;
    ariaHidden: string | null;
    inert: boolean;
    opacity: string;
    transitionDuration: string;
    rect: {
        x: number;
        y: number;
        width: number;
        height: number
    };
}

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-scan-cleanup-layout-${Date.now()}`,
    windowMode: 'hidden',
});

describe('scan cleanup layout stability', () => {
    it('keeps the workspace vertical origin fixed when scan and PDF panes trade focus', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;
        const sourcePath = await createLargeScannedFixturePdf(
            'scan-cleanup-pane-toolbar-stability.pdf',
            1,
            0,
        );
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForPdfLoaded(page, 90_000);
        await waitForViewerInteractive(page, 90_000);
        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface', {
            timeout: 30_000,
            visible: true,
        });
        const leftPaneId = await evaluateInPage(page, () =>
            document.querySelector<HTMLElement>('.editor-pane.is-active')
                ?.dataset.editorPaneId ?? null);
        expect(leftPaneId).toBeTruthy();

        const split = await evaluateInPage(page, async () => {
            const splitEditor = (window as Window & {__splitEditorEmptyForE2E?: (direction: 'right') => Promise<void> | void;})
                .__splitEditorEmptyForE2E;
            if (typeof splitEditor !== 'function') {
                return false;
            }
            await splitEditor('right');
            return true;
        });
        expect(split).toBe(true);
        await waitForFunctionInPage(page, () =>
            document.querySelectorAll('.editor-pane').length === 2);
        await openPdfInApp(page, sourcePath, 90_000);
        await waitForPdfLoaded(page, 90_000);
        await waitForViewerInteractive(page, 90_000);
        const rightPaneId = await evaluateInPage(page, () =>
            document.querySelector<HTMLElement>('.editor-pane.is-active')
                ?.dataset.editorPaneId ?? null);
        expect(rightPaneId).toBeTruthy();
        expect(rightPaneId).not.toBe(leftPaneId);

        const activatePane = async (paneId: string, toolbarSelector: string) => {
            await evaluateInPage(page, (targetPaneId: string) => {
                const pane = Array.from(document.querySelectorAll<HTMLElement>('.editor-pane'))
                    .find(candidate => candidate.dataset.editorPaneId === targetPaneId);
                pane?.dispatchEvent(new PointerEvent('pointerdown', {
                    bubbles: true,
                    pointerId: 1,
                }));
                return pane !== undefined;
            }, paneId);
            await waitForFunctionInPage(page, (
                targetPaneId: string,
                targetToolbarSelector: string,
            ) => document.querySelector<HTMLElement>('.editor-pane.is-active')
                ?.dataset.editorPaneId === targetPaneId
                && document.querySelector(targetToolbarSelector) !== null, {timeout: 30_000}, paneId, toolbarSelector);
            await evaluateInPage(page, () => new Promise<boolean>(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
            }));
        };
        const sampleGeometry = () => evaluateInPage(page, () => {
            const shell = document.querySelector<HTMLElement>('.editor-global-toolbar-shell');
            const host = document.querySelector<HTMLElement>('.editor-global-toolbar-host');
            const toolbar = host?.querySelector<HTMLElement>(':scope > .toolbar');
            const workspace = document.querySelector<HTMLElement>('.workspace-main-shell');
            const rect = (element: HTMLElement | null | undefined) => {
                const bounds = element?.getBoundingClientRect();
                return bounds
                    ? {
                        height: Math.round(bounds.height * 100) / 100,
                        top: Math.round(bounds.top * 100) / 100,
                    }
                    : null;
            };
            return {
                host: rect(host),
                shell: rect(shell),
                toolbar: rect(toolbar),
                workspace: rect(workspace),
            };
        });

        await activatePane(rightPaneId!, '#editor-global-toolbar-host .toolbar:not(.scan-cleanup-toolbar)');
        const pdfGeometry = await sampleGeometry();
        await activatePane(leftPaneId!, '#editor-global-toolbar-host .scan-cleanup-toolbar');
        const cleanupGeometry = await sampleGeometry();
        await activatePane(rightPaneId!, '#editor-global-toolbar-host .toolbar:not(.scan-cleanup-toolbar)');
        const pdfGeometryAgain = await sampleGeometry();

        expect(cleanupGeometry).toEqual(pdfGeometry);
        expect(pdfGeometryAgain).toEqual(pdfGeometry);
        expect(pdfGeometry.shell?.height).toBeGreaterThan(0);
        expect(pdfGeometry.host?.height).toBe(pdfGeometry.shell?.height);
        expect(pdfGeometry.toolbar?.height).toBe(pdfGeometry.shell?.height);
    }, 240_000);

    it('never moves its controls when state changes, and keeps deskew symmetric', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();
        if (!session) {
            return;
        }
        const {page} = session;

        const sourcePath = await createLargeScannedFixturePdf(
            'scan-cleanup-layout-stability.pdf',
            REFERENCE_PAGE_COUNT,
            0,
        );
        await openPdfInApp(page, sourcePath, 180_000);
        await waitForPdfLoaded(page, 180_000);
        await waitForViewerInteractive(page, 180_000);
        await waitForFunctionInPage(page, () => {
            const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
            const toolbar = api?.getActiveToolbarSnapshot?.();
            return toolbar?.initialVisualReady === true && toolbar.totalPages > 0;
        }, {timeout: 180_000});

        await clickVisibleToolbarButton(page, 'Scan cleanup');
        await page.waitForSelector('.scan-cleanup-surface', {
            timeout: 30_000,
            visible: true,
        });
        await page.waitForSelector('.scan-cleanup-settings-scroll', {
            timeout: 30_000,
            visible: true,
        });
        // The zoom value button only leaves its disabled state once a preview
        // result exists, which is the first moment the surface is measurable.
        await waitForFunctionInPage(page, () => {
            const zoom = document.querySelector<HTMLButtonElement>('.preview-zoom-value');
            return zoom !== null && !zoom.disabled;
        }, {timeout: 180_000});
        await page.waitForSelector('.cleaned-outputs.preview-comparison-layer', {timeout: 180_000});
        await waitForFunctionInPage(page, () => {
            const cleaned = document.querySelector<HTMLElement>('.cleaned-outputs.preview-comparison-layer');
            return cleaned !== null && getComputedStyle(cleaned).opacity === '1';
        }, {timeout: 180_000});

        const sample = async (): Promise<IAnchorSample> => evaluateInPage(
            page,
            (anchors: Readonly<Record<string, string>>) => {
                const rects: Record<string, unknown> = {};
                for (const [
                    name,
                    selector,
                ] of Object.entries(anchors)) {
                    const element = document.querySelector(selector);
                    if (!element) {
                        rects[name] = null;
                        continue;
                    }
                    const rect = element.getBoundingClientRect();
                    rects[name] = {
                        x: Math.round(rect.x * 100) / 100,
                        y: Math.round(rect.y * 100) / 100,
                        width: Math.round(rect.width * 100) / 100,
                        height: Math.round(rect.height * 100) / 100,
                    };
                }
                return {
                    scrollTop: document.querySelector('.scan-cleanup-settings-scroll')?.scrollTop ?? 0,
                    rects,
                };
            },
            ANCHORS as never,
        ) as Promise<IAnchorSample>;

        const settle = async () => {
            await evaluateInPage(page, () => new Promise<boolean>(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
            }));
        };

        const clickByText = async (selector: string, text: string) => evaluateInPage(
            page,
            (candidateSelector: string, label: string) => {
                const target = Array.from(document.querySelectorAll<HTMLElement>(candidateSelector))
                    .find(element => (element.textContent ?? '').trim() === label
                        || element.getAttribute('aria-label') === label);
                target?.click();
                return target !== undefined;
            },
            selector,
            text,
        );

        const findings: IGeometryFinding[] = [];
        const missingControls: string[] = [];
        const samples: Record<string, IAnchorSample> = {};

        const transition = async (name: string, act: () => Promise<unknown>) => {
            const before = await sample();
            const acted = await act();
            if (acted !== true) {
                missingControls.push(name);
                return;
            }
            await settle();
            const after = await sample();
            samples[name] = after;
            for (const anchor of Object.keys(ANCHORS)) {
                const from = before.rects[anchor];
                const to = after.rects[anchor];
                if (!from || !to) {
                    continue;
                }
                if (from.y !== to.y) {
                    findings.push({
                        transition: name,
                        anchor,
                        axis: 'y',
                        before: from.y,
                        after: to.y,
                    });
                }
                if (from.x !== to.x) {
                    findings.push({
                        transition: name,
                        anchor,
                        axis: 'x',
                        before: from.x,
                        after: to.x,
                    });
                }
            }
            if (before.scrollTop !== after.scrollTop) {
                findings.push({
                    transition: `${name} (settings scrollTop)`,
                    anchor: 'settingsScroll',
                    axis: 'y',
                    before: before.scrollTop,
                    after: after.scrollTop,
                });
            }
        };

        // SCUI2 — comparison mode, and the divider under the preview.
        await transition('viewMode: cleaned -> original', () => clickByText('.scan-cleanup-segmented-option', 'Original'));
        await transition('viewMode: original -> cleaned', () => clickByText('.scan-cleanup-segmented-option', 'Cleaned'));
        await new Promise(resolve => setTimeout(resolve, 300));
        const comparisonLayers = await evaluateInPage(page, () =>
            Array.from(document.querySelectorAll<HTMLElement>('.preview-comparison-layer')).map(element => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                    className: element.className,
                    ariaHidden: element.getAttribute('aria-hidden'),
                    inert: element.hasAttribute('inert'),
                    opacity: style.opacity,
                    transitionDuration: style.transitionDuration,
                    rect: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                    },
                };
            })) as IComparisonLayerSample[];

        // SCUI1/SCUI2 — the fit control and the zoom readout.
        await transition('zoom: fit -> 100%', () => evaluateInPage(page, () => {
            const zoom = document.querySelector<HTMLButtonElement>('.preview-zoom-value');
            zoom?.click();
            return zoom !== null;
        }));
        await transition('zoom: 100% -> fit', () => evaluateInPage(page, () => {
            const fit = Array.from(document.querySelectorAll<HTMLButtonElement>('.preview-zoom-button'))
                .find(button => button.getAttribute('aria-pressed') !== null);
            fit?.click();
            return fit !== undefined;
        }));

        // SCUI6 — the page counter must not push its neighbours as it widens.
        const nextPage = () => evaluateInPage(page, () => {
            const next = document.querySelector<HTMLButtonElement>('.page-navigation button:last-of-type');
            next?.click();
            return next !== null;
        });
        for (let step = 1; step <= 12; step += 1) {
            await transition(`page counter step ${String(step)}`, nextPage);
        }

        // SCUI9 — colour mode must not insert or remove a control.
        for (const mode of [
            'B&W',
            'Gray',
            'Color',
            'Auto',
        ]) {
            await transition(`output mode -> ${mode}`, () => clickByText('.scan-cleanup-segmented-option', mode));
        }

        // SCUI10 — checkbox-gated settings.
        const toggleCheckbox = (label: string) => evaluateInPage(page, (text: string) => {
            const target = Array.from(document.querySelectorAll<HTMLElement>(
                'input[type="checkbox"],[role="checkbox"]',
            )).find(element => {
                const named = Array.from((element as HTMLInputElement).labels ?? [])
                    .map(item => item.textContent ?? '')
                    .join(' ');
                const described = element.closest('div')?.textContent ?? '';
                return `${named} ${described}`.includes(text);
            });
            target?.click();
            return target !== undefined;
        }, label);
        for (const checkbox of [
            'Match page size',
            'Crop each output page',
            'Skip blank pages',
        ]) {
            await transition(`checkbox off: ${checkbox}`, () => toggleCheckbox(checkbox));
            await transition(`checkbox on: ${checkbox}`, () => toggleCheckbox(checkbox));
        }

        // SCUI7 — the deskew tag, and SCUI8 — a reachable positive angle.
        const deskewInput = '.scan-cleanup-manual-skew-input input';
        const readDeskew = () => evaluateInPage(page, (selector: string) =>
            document.querySelector<HTMLInputElement>(selector)?.value ?? null, deskewInput);
        const centerDeskew = async () => {
            await evaluateInPage(page, (selector: string) => {
                document.querySelector(selector)?.scrollIntoView({block: 'center'});
                return true;
            }, deskewInput);
            await settle();
        };
        const pointerClick = async (selector: string) => {
            const target = await page.$(selector);
            const bounds = await target?.boundingBox();
            if (target === null || target === undefined || bounds === null || bounds === undefined) {
                return false;
            }
            await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            return true;
        };
        const stepDeskew = async (
            direction: 'increment' | 'decrement',
            expected: number,
        ) => {
            if (!await pointerClick(
                `.scan-cleanup-manual-skew-input [data-slot="${direction}"] button`,
            )) {
                return false;
            }
            await waitForFunctionInPage(page, (
                selector: string,
                target: number,
            ) => Number(document.querySelector<HTMLInputElement>(selector)?.value) === target, {timeout: 10_000}, deskewInput, expected);
            return true;
        };

        await centerDeskew();
        const deskewBefore = await readDeskew();
        await transition('deskew: automatic -> manual (increment)', () => stepDeskew('increment', 0.1));
        const deskewAfterIncrement = await readDeskew();
        await transition('deskew: manual -> reset', () =>
            pointerClick('.scan-cleanup-auto-value-reset'));
        await transition('deskew: automatic -> manual (decrement)', () => stepDeskew('decrement', -0.1));
        const deskewAfterDecrement = await readDeskew();

        // SCUI4/SCUI5 — the detection status line and its stop control.
        const detectionState = await evaluateInPage(page, () => {
            const cancel = document.querySelector<HTMLButtonElement>('.scan-cleanup-toolbar-cancel-detection');
            return {
                cancelLabel: cancel?.getAttribute('aria-label') ?? null,
                spinning: document.querySelectorAll('.scan-thumbnail-detection-pending').length,
                thumbnails: document.querySelectorAll('.scan-thumbnail-overlay').length,
            };
        });

        const evidenceDir = join(EVIDENCE_BASE_DIR, session.name);
        mkdirSync(evidenceDir, {recursive: true});
        writeFileSync(
            join(evidenceDir, 'layout-stability.json'),
            `${JSON.stringify({
                pageCount: REFERENCE_PAGE_COUNT,
                transitions: Object.keys(samples).length,
                findings,
                deskew: {
                    automatic: deskewBefore,
                    afterIncrement: deskewAfterIncrement,
                    afterDecrement: deskewAfterDecrement,
                },
                detectionState,
                comparisonLayers,
                missingControls,
                samples,
            }, null, 2)}\n`,
            'utf8',
        );
        await page.screenshot({path: join(evidenceDir, 'after-scan-cleanup-surface.png')});

        expect(deskewBefore).toBe('0');
        // Pre-fix, a null number field stepped straight to its minimum, so both
        // buttons produced -15 and the positive half was unreachable.
        expect(Number(deskewAfterIncrement)).toBeCloseTo(0.1, 5);
        expect(Number(deskewAfterDecrement)).toBeCloseTo(-0.1, 5);
        expect(detectionState.cancelLabel).toContain('pages already detected keep their results');
        expect(comparisonLayers).toHaveLength(2);
        expect(comparisonLayers[0]).toMatchObject({
            ariaHidden: 'true',
            inert: true,
            opacity: '0',
        });
        expect(comparisonLayers[1]).toMatchObject({
            ariaHidden: 'false',
            inert: false,
            opacity: '1',
        });
        expect(comparisonLayers.every(layer => layer.transitionDuration !== '0s')).toBe(true);
        expect(comparisonLayers[0]?.rect).toEqual(comparisonLayers[1]?.rect);
        expect(missingControls).toEqual([]);
        expect(findings).toEqual([]);
    }, 900_000);
});
