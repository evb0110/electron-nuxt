import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    createMultiPageTextFixturePdf,
    readPdfAnnotationSummary,
} from '@tests/e2e/electron/helpers/fixtures';
import {
    openAnnotationsTab,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { createFreeTextAnnotation } from '@tests/e2e/electron/helpers/viewerAnnotations';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    getLatestAutomationEventId,
    getWorkspaceToolbarSnapshot,
    readWorkspaceStateValues,
    waitForAutomationEvent,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const BLOCKING_SMOKE_TIMEOUT_MS = 120_000;
const SAVE_TIMEOUT_MS = 45_000;

function hashFile(filePath: string) {
    return createHash('sha256')
        .update(readFileSync(filePath))
        .digest('hex');
}

async function waitForToolbarCanSave(page: Page) {
    const startedAt = Date.now();
    let snapshot = await getWorkspaceToolbarSnapshot(page);

    while (Date.now() - startedAt < 15_000) {
        if (snapshot?.canSave === true && snapshot.isAnySaving !== true) {
            return;
        }
        await delay(150);
        snapshot = await getWorkspaceToolbarSnapshot(page);
    }

    throw new Error(`Save did not become available: ${JSON.stringify(snapshot)}`);
}

async function waitForLivePdfJsAnnotationChange(page: Page) {
    const startedAt = Date.now();
    let dirtyState = (await readWorkspaceStateValues<{dirtyState?: {hasLivePdfJsAnnotationChanges?: boolean;};}>(page, ['dirtyState'])).dirtyState;

    while (Date.now() - startedAt < 15_000) {
        if (dirtyState?.hasLivePdfJsAnnotationChanges === true) {
            return;
        }
        await delay(150);
        dirtyState = (await readWorkspaceStateValues<{dirtyState?: {hasLivePdfJsAnnotationChanges?: boolean;};}>(page, ['dirtyState'])).dirtyState;
    }

    throw new Error(`FreeText editor did not enter PDF.js annotation storage: ${JSON.stringify(dirtyState)}`);
}

async function clickVisibleSaveToolbarButton(page: Page) {
    const clicked = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0
            );
        };

        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => (
                candidate.getAttribute('aria-label')?.trim() === 'Save'
                && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true'
                && isVisible(candidate)
            ));
        button?.click();
        return Boolean(button);
    });

    if (!clicked) {
        throw new Error(`Visible enabled Save toolbar button not found: ${JSON.stringify(await getWorkspaceToolbarSnapshot(page))}`);
    }
}

async function waitForFreeTextAnnotationOnDisk(filePath: string) {
    const startedAt = Date.now();
    let summary = await readPdfAnnotationSummary(filePath);

    while (Date.now() - startedAt < 20_000) {
        if ((summary.bySubtype.FreeText ?? 0) > 0) {
            return summary;
        }
        await delay(150);
        summary = await readPdfAnnotationSummary(filePath);
    }

    throw new Error(`Expected saved FreeText annotation on disk: ${JSON.stringify(summary)}`);
}

describe('Electron E2E - Blocking PDF Save Smoke', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('opens a startup PDF path, creates a visible annotation, and saves it to disk', async () => {
        const pdfPath = await createMultiPageTextFixturePdf(`blocking-save-smoke-${Date.now()}.pdf`, 1);
        const beforeHash = hashFile(pdfPath);

        session = await startElectronE2ESession(`e2e-blocking-save-smoke-${Date.now()}`, {
            clean: true,
            initialOpenPaths: [pdfPath],
        });
        const { page } = session;

        await Promise.all([
            waitForAutomationEvent(page, 'document-opened', {
                path: pdfPath,
                timeoutMs: 45_000,
            }),
            waitForAutomationEvent(page, 'first-page-rendered', {
                path: pdfPath,
                timeoutMs: 45_000,
            }),
        ]);

        const startupState = await readWorkspaceStateValues<{originalPath?: string | null;}>(page, ['originalPath']);
        const readinessState = await page.evaluate(() => ({
            appReady: (window as Window & {__appReady?: boolean}).__appReady ?? false,
            appReadyAt: (window as Window & {__appReadyAt?: number}).__appReadyAt ?? null,
            firstPagePaintedAt: performance
                .getEntriesByName('evb:first-page-painted', 'mark')
                .at(-1)?.startTime ?? null,
            navigationStartedAt: performance.timeOrigin,
            overlayPresent: document.querySelector('#evb-startup-overlay') !== null,
        }));
        expect(startupState.originalPath).toBe(pdfPath);
        expect(readinessState.overlayPresent).toBe(false);
        expect(readinessState.appReady).toBe(true);
        expect(readinessState.appReadyAt).not.toBeNull();
        expect(readinessState.firstPagePaintedAt).not.toBeNull();
        await waitForPdfLoaded(page, 30_000);
        await waitForViewerInteractive(page, 30_000);

        await openAnnotationsTab(page, 30_000);
        const annotationText = `Blocking smoke FreeText ${Date.now()}`;
        const createdCount = await createFreeTextAnnotation(page, annotationText);
        expect(createdCount).toBeGreaterThan(0);
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await waitForLivePdfJsAnnotationChange(page);
        await waitForToolbarCanSave(page);

        const saveBaselineEventId = await getLatestAutomationEventId(page);
        const saveCommitted = waitForAutomationEvent(page, 'save-committed', {
            afterEventId: saveBaselineEventId,
            path: pdfPath,
            timeoutMs: SAVE_TIMEOUT_MS,
        });
        await clickVisibleSaveToolbarButton(page);
        await saveCommitted;

        const afterHash = hashFile(pdfPath);
        expect(afterHash).not.toBe(beforeHash);

        const summary = await waitForFreeTextAnnotationOnDisk(pdfPath);
        expect(summary.bySubtype.FreeText ?? 0).toBeGreaterThan(0);
    }, BLOCKING_SMOKE_TIMEOUT_MS);
});
