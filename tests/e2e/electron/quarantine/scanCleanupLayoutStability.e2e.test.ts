import {
    mkdirSync,
    writeFileSync,
} from 'node:fs';
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
const EVIDENCE_DIR = '/Users/evb/WebstormProjects/evb-viewer/.devkit/_tasks/audit-jul-25/u19-evidence';

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

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: () => `e2e-scan-cleanup-layout-${Date.now()}`,
    windowMode: 'hidden',
});

describe('scan cleanup layout stability', () => {
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
        const deskewInput = '.scan-cleanup-auto-value-entry input';
        const readDeskew = () => evaluateInPage(page, (selector: string) =>
            document.querySelector<HTMLInputElement>(selector)?.value ?? null, deskewInput);
        const stepDeskew = (direction: 'increment' | 'decrement') => evaluateInPage(page, (
            selector: string,
            slot: string,
        ) => {
            const entry = document.querySelector(selector)?.closest('[data-slot="root"]');
            const button = entry?.querySelector<HTMLButtonElement>(`[data-slot="${slot}"] button`);
            button?.click();
            return button !== null && button !== undefined;
        }, deskewInput, direction);

        const deskewBefore = await readDeskew();
        await transition('deskew: automatic -> manual (increment)', () => stepDeskew('increment'));
        const deskewAfterIncrement = await readDeskew();
        await transition('deskew: manual -> reset', () => evaluateInPage(page, () => {
            const reset = document.querySelector<HTMLButtonElement>('.scan-cleanup-auto-value-reset');
            reset?.click();
            return reset !== null;
        }));
        await transition('deskew: automatic -> manual (decrement)', () => stepDeskew('decrement'));
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

        mkdirSync(EVIDENCE_DIR, {recursive: true});
        writeFileSync(
            `${EVIDENCE_DIR}/u19-layout-stability.json`,
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
                missingControls,
                samples,
            }, null, 2)}\n`,
            'utf8',
        );
        await page.screenshot({path: `${EVIDENCE_DIR}/u19-after-scan-cleanup-surface.png`});

        expect(deskewBefore).toBe('0');
        // Pre-fix, a null number field stepped straight to its minimum, so both
        // buttons produced -15 and the positive half was unreachable.
        expect(Number(deskewAfterIncrement)).toBeCloseTo(0.1, 5);
        expect(Number(deskewAfterDecrement)).toBeCloseTo(-0.1, 5);
        expect(detectionState.cancelLabel).toContain('pages already detected keep their results');
        expect(missingControls).toEqual([]);
        expect(findings).toEqual([]);
    }, 900_000);
});
