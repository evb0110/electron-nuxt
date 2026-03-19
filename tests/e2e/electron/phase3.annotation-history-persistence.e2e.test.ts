import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    copyProjectFixture,
    readPdfAnnotationSummary,
} from './helpers/fixtures';
import { startElectronE2ESession } from './helpers/session-harness';
import {
    clickToolbarButtonWhenEnabled,
    clickAnnotationTool,
    createFreeTextAnnotation,
    getFreeTextEditorCount,
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
} from './helpers/viewer-helpers';

async function waitForToolbarActionState(
    page: Awaited<ReturnType<typeof startElectronE2ESession>>['page'],
    ariaLabel: string,
    enabled: boolean,
    timeoutMs = 8_000,
) {
    const iconHints = ariaLabel === 'Undo'
        ? [
            '.i-lucide-undo-2',
            '.iconify.i-lucide-undo-2',
        ]
        : ariaLabel === 'Redo'
            ? [
                '.i-lucide-redo-2',
                '.iconify.i-lucide-redo-2',
            ]
            : [];

    await page.waitForFunction((args: {
        ariaLabel: string;
        enabled: boolean;
        iconHints: string[];
    }) => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'));
        const visibleButton = buttons.find((button) => {
            const ariaLabel = button.getAttribute('aria-label')?.trim() ?? '';
            const matches = (
                ariaLabel === args.ariaLabel
                || ariaLabel.startsWith(`${args.ariaLabel} (`)
                || args.iconHints.some(selector => Boolean(button.querySelector(selector)))
            );
            if (!matches) {
                return false;
            }
            const rect = button.getBoundingClientRect();
            const style = window.getComputedStyle(button);
            return (
                rect.width > 8
                && rect.height > 8
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
            );
        }) ?? null;
        if (!visibleButton) {
            return false;
        }
        const isDisabled = visibleButton.hasAttribute('disabled') || visibleButton.getAttribute('aria-disabled') === 'true';
        return args.enabled ? !isDisabled : isDisabled;
    }, { timeout: timeoutMs }, {
        ariaLabel,
        enabled,
        iconHints,
    });
}

describe('Electron E2E - Phase 3 (Undo/Redo + Persistence)', () => {
    it('undoes/redoes an annotation and persists it across app restart', async () => {
        const fixturePath = copyProjectFixture('generated-text.pdf', `phase3-persistence-${Date.now()}.pdf`);
        const summaryBefore = await readPdfAnnotationSummary(fixturePath);

        const primarySession = await startElectronE2ESession(`e2e-phase3-primary-${Date.now()}`);

        try {
            await openPdfInApp(primarySession.page, fixturePath);
            await waitForPdfLoaded(primarySession.page);
            await openAnnotationsTab(primarySession.page);

            const baselineCount = await getFreeTextEditorCount(primarySession.page);
            const createdCount = await createFreeTextAnnotation(primarySession.page, `phase3-note-${Date.now()}`);
            expect(createdCount).toBeGreaterThan(baselineCount);
            await clickAnnotationTool(primarySession.page, 'Select');
            await clickToolbarButtonWhenEnabled(primarySession.page, 'Undo', 6_000);
            await waitForToolbarActionState(primarySession.page, 'Redo', true);
            const undoCount = await getFreeTextEditorCount(primarySession.page);
            expect(undoCount).toBeLessThanOrEqual(createdCount);

            await clickToolbarButtonWhenEnabled(primarySession.page, 'Redo', 6_000);
            await waitForToolbarActionState(primarySession.page, 'Redo', false);
            const redoCount = await getFreeTextEditorCount(primarySession.page);
            expect(redoCount).toBeGreaterThanOrEqual(undoCount);

            await saveViaWindowHandle(primarySession.page);
        } finally {
            await primarySession.stop();
        }

        const summaryAfterSave = await readPdfAnnotationSummary(fixturePath);
        expect(summaryAfterSave.total).toBeGreaterThanOrEqual(summaryBefore.total);
        expect(summaryAfterSave.bySubtype.FreeText ?? 0).toBeGreaterThan(summaryBefore.bySubtype.FreeText ?? 0);

        const reloadSession = await startElectronE2ESession(`e2e-phase3-reload-${Date.now()}`);
        try {
            await openPdfInApp(reloadSession.page, fixturePath);
            await waitForPdfLoaded(reloadSession.page);

            const restoredAnnotationNodes = await reloadSession.page.evaluate(() => {
                const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
                    ?? null;
                if (!host) {
                    return 0;
                }
                const selector = '[data-annotation-id], .freeTextEditor, .pdf-comment-marker-button';
                return host.querySelectorAll(selector).length;
            });

            expect(restoredAnnotationNodes).toBeGreaterThan(0);
        } finally {
            await reloadSession.stop();
        }
    });
});
