import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {
    copyProjectFixture,
    createMultiPageTextFixturePdf,
    readPdfAnnotationSummary,
} from './helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from './helpers/sessionHarness';
import {
    createFreeTextAnnotation,
    getFreeTextEditorCount,
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForActiveWorkspaceHost,
    waitForPdfLoaded,
} from './helpers/viewerHelpers';

async function getVisibleHighlightEditorCounts(page: Page) {
    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 100
                    && rect.height > 100
                );
            });
        return visibleHosts.map(host => host.querySelectorAll('.highlightEditor, .highlightAnnotation').length);
    });
}

async function getVisibleHighlightEditorCount(page: Page) {
    const counts = await getVisibleHighlightEditorCounts(page);
    return Math.max(0, ...counts);
}

async function waitForHighlightEditorCount(page: Page, expectedCount: number) {
    const startedAt = Date.now();
    let counts = await getVisibleHighlightEditorCounts(page);
    while (Date.now() - startedAt < 20_000) {
        if (
            (expectedCount === 0 && counts.every(count => count === 0))
            || (expectedCount > 0 && counts.some(count => count === expectedCount))
        ) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
        counts = await getVisibleHighlightEditorCounts(page);
    }
    const details = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.highlightEditor, .highlightAnnotation'))
        .map(editor => ({
            id: editor.id,
            label: editor.getAttribute('aria-label'),
            page: editor.closest<HTMLElement>('.page_container')?.dataset.page ?? null,
            visible: (() => {
                const rect = editor.getBoundingClientRect();
                const style = window.getComputedStyle(editor);
                return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
            })(),
        })));
    throw new Error(
        `Expected visible highlight count ${expectedCount}, got [${counts.join(', ')}]: ${JSON.stringify(details)}`,
    );
}

async function waitForActiveTabDirtyState(page: Page, expectedDirty: boolean) {
    const startedAt = Date.now();
    let actualDirty = await page.evaluate(() => (
        document.querySelector<HTMLElement>('.tab.is-active')?.classList.contains('is-dirty') ?? false
    ));
    while (Date.now() - startedAt < 10_000) {
        if (actualDirty === expectedDirty) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        actualDirty = await page.evaluate(() => (
            document.querySelector<HTMLElement>('.tab.is-active')?.classList.contains('is-dirty') ?? false
        ));
    }
    throw new Error(`Expected active tab dirty=${expectedDirty}, got ${actualDirty}`);
}

async function waitForPdfAnnotationSubtypeCount(filePath: string, subtype: string, expectedCount: number) {
    const startedAt = Date.now();
    let lastSummary = await readPdfAnnotationSummary(filePath);
    while (Date.now() - startedAt < 20_000) {
        if ((lastSummary.bySubtype[subtype] ?? 0) === expectedCount) {
            return lastSummary;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
        lastSummary = await readPdfAnnotationSummary(filePath);
    }
    throw new Error(`Expected ${expectedCount} ${subtype} annotations on disk, got ${lastSummary.bySubtype[subtype] ?? 0}`);
}

async function createHighlightWithPdfjsManager(page: Page) {
    const before = await getVisibleHighlightEditorCount(page);
    let result = 'missing-ui-manager';
    const startedAt = Date.now();
    while (Date.now() - startedAt < 8_000 && result !== 'ok' && result !== 'issued-highlight') {
        result = await page.evaluate(async (previousCount: number) => {
            const isVisible = (candidate: HTMLElement) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 100
                    && rect.height > 100
                );
            };
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter(isVisible);
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const matchingHosts = visibleHosts
                .filter(candidate => candidate.querySelector('.annotationEditorLayer, .annotation-editor-layer'));
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
                ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
            if (!host) {
                return 'missing-host';
            }
            if (host.querySelectorAll('.highlightEditor').length > previousCount) {
                return 'ok';
            }

            type TVueComponentLike = {
                parent?: TVueComponentLike | null;
                exposed?: unknown;
                setupState?: Record<string, unknown>;
            };
            const unwrap = (value: unknown) => (
                value
                && typeof value === 'object'
                && 'value' in value
                    ? (value as {value?: unknown;}).value
                    : value
            );
            const fromCandidate = (candidate: unknown) => {
                const setupState = (candidate as {$?: {setupState?: Record<string, unknown>;};} | null)?.$?.setupState
                    ?? (candidate as {setupState?: Record<string, unknown>;} | null)?.setupState
                    ?? null;
                const direct = unwrap(setupState?.annotationUiManager);
                if (direct) {
                    return direct;
                }
                const pdfViewer = unwrap(setupState?.pdfViewerRef) as {
                    $?: {setupState?: Record<string, unknown>;};
                    annotationUiManager?: {value?: unknown;};
                } | null;
                return unwrap(pdfViewer?.$?.setupState?.annotationUiManager)
                    ?? unwrap(pdfViewer?.annotationUiManager)
                    ?? null;
            };
            const viewerElement = host.querySelector<HTMLElement>('#pdf-viewer') ?? host;
            let component = (viewerElement as HTMLElement & {__vueParentComponent?: TVueComponentLike;}).__vueParentComponent
                ?? (host as HTMLElement & {__vueParentComponent?: TVueComponentLike;}).__vueParentComponent
                ?? null;
            let uiManager: unknown = null;
            while (component && !uiManager) {
                const setupState = component.setupState;
                for (const candidate of [
                    component,
                    component.exposed,
                    unwrap(setupState?.mountedWorkspace),
                    unwrap(setupState?.workspaceRef),
                    unwrap(setupState?.pdfViewerRef),
                ]) {
                    uiManager = fromCandidate(candidate);
                    if (uiManager) {
                        break;
                    }
                }
                component = component.parent ?? null;
            }

            const manager = uiManager as {
                updateMode?: (mode: number) => Promise<void>;
                waitForEditorsRendered?: (pageNumber: number) => Promise<void>;
                highlightSelection?: (methodOfCreation?: string) => void;
            } | null;
            if (typeof manager?.highlightSelection !== 'function') {
                return 'missing-ui-manager';
            }

            const textNodes = Array.from(host.querySelectorAll<HTMLElement>(
                '.page_container--rendered .text-layer span, .page_container--rendered .textLayer span',
            ))
                .map((span) => {
                    const node = Array.from(span.childNodes)
                        .find(candidate => candidate.nodeType === Node.TEXT_NODE);
                    return {
                        node,
                        text: node?.textContent ?? '',
                    };
                })
                .filter(({
                    node,
                    text,
                }) => node && text.trim().length > 4);
            const first = textNodes[0];
            if (!first?.node) {
                return 'missing-text';
            }
            const pageElement = (first.node.parentElement ?? null)
                ?.closest<HTMLElement>('.page_container');
            const pageNumber = Number(pageElement?.dataset.page ?? '1');
            if (typeof manager.updateMode === 'function') {
                await manager.updateMode(9);
            }
            if (Number.isFinite(pageNumber) && typeof manager.waitForEditorsRendered === 'function') {
                await manager.waitForEditorsRendered(pageNumber);
            }

            const range = document.createRange();
            range.setStart(first.node, 0);
            range.setEnd(first.node, first.text.length);
            const selection = document.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            manager.highlightSelection('e2e');
            selection?.removeAllRanges();
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if ((host.querySelectorAll('.highlightEditor').length ?? 0) > previousCount) {
                return 'ok';
            }
            return 'issued-highlight';
        }, before);
        if (result !== 'ok' && result !== 'issued-highlight') {
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }

    if (result !== 'ok' && result !== 'issued-highlight') {
        throw new Error(`Unable to create highlight: ${result}`);
    }
    await waitForHighlightEditorCount(page, before + 1);
    return getVisibleHighlightEditorCount(page);
}

async function clickEnabledToolbarAction(page: Page, label: string) {
    const clicked = await page.evaluate((targetLabel: string) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => (
                candidate.getAttribute('aria-label')?.trim() === targetLabel
                && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true'
            ));
        button?.click();
        return Boolean(button);
    }, label);

    if (!clicked) {
        throw new Error(`Enabled toolbar action not found: ${label}`);
    }
}

async function clickFirstSidebarAnnotationDelete(page: Page) {
    const result = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 100
                && rect.height > 100
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = (activeHost && isVisible(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const buttons = Array.from(host?.querySelectorAll<HTMLButtonElement>('.pdf-sidebar .note-item-delete') ?? [])
            .filter(button => !button.disabled && button.offsetParent !== null);
        buttons[0]?.click();
        return buttons.length;
    });

    if (result < 1) {
        throw new Error('No visible sidebar annotation delete button found');
    }
}

describe('Electron E2E - Phase 1 (Annotation Lifecycle)', () => {
    let session: IElectronE2ESession | null = null;
    let fixturePath = '';

    beforeAll(async () => {
        session = await startElectronE2ESession(`e2e-phase1-${Date.now()}`);
        fixturePath = copyProjectFixture('freetext-lifecycle-test.pdf', `phase1-${Date.now()}-freetext.pdf`);
        await openPdfInApp(session.page, fixturePath);
        await waitForPdfLoaded(session.page);
    });

    afterAll(async () => {
        await session?.stop();
    });

    it('creates and edits a FreeText annotation in the active workspace', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 session was not initialized');
        }

        await openAnnotationsTab(page);

        const baselineCount = await getFreeTextEditorCount(page);
        const typedText = `Phase 1 free text ${Date.now()}`;
        const createdCount = await createFreeTextAnnotation(page, typedText);
        expect(createdCount).toBeGreaterThan(baselineCount);

        await waitForActiveWorkspaceHost(page);
        const latestTextHandle = await page.waitForFunction((expectedText: string) => {
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return (
                        style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0
                        && rect.width > 100
                        && rect.height > 100
                    );
                });
            const host = (activeHost && visibleHosts.includes(activeHost))
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
            const matchingText = editors
                .map((editor) => (editor.querySelector<HTMLElement>('[contenteditable], .internal') ?? editor).textContent ?? '')
                .map(text => text.replace(/\u200B/g, '').trim())
                .find(text => text.includes(expectedText));
            return matchingText ?? false;
        }, { timeout: 8_000 }, typedText);
        const latestText = await latestTextHandle.jsonValue();
        expect(latestText).toContain(typedText);
    });

    it('keeps highlight undo and redo coherent after saving', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 session was not initialized');
        }

        const highlightFixturePath = await createMultiPageTextFixturePdf(
            `phase1-${Date.now()}-highlight.pdf`,
            1,
        );
        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getVisibleHighlightEditorCount(page);
        const createdCount = await createHighlightWithPdfjsManager(page);
        expect(createdCount).toBeGreaterThan(baselineCount);
        await waitForActiveTabDirtyState(page, true);

        await saveViaWindowHandle(page);
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, true);

        await saveViaWindowHandle(page);
        const deletedSummary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 0);
        expect(deletedSummary.bySubtype.Highlight ?? 0).toBe(0);
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Redo');
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForActiveTabDirtyState(page, true);

        await saveViaWindowHandle(page);
        const summary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        expect(summary.bySubtype.Highlight ?? 0).toBe(1);
        await waitForActiveTabDirtyState(page, false);
    });

    it('restores a persisted highlight when undoing a saved sidebar delete', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 session was not initialized');
        }

        const highlightFixturePath = await createMultiPageTextFixturePdf(
            `phase1-${Date.now()}-persisted-highlight-delete.pdf`,
            1,
        );
        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getVisibleHighlightEditorCount(page);
        await createHighlightWithPdfjsManager(page);
        await saveViaWindowHandle(page);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);

        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForHighlightEditorCount(page, baselineCount + 1);

        await clickFirstSidebarAnnotationDelete(page);
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, true);

        await saveViaWindowHandle(page);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 0);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForActiveTabDirtyState(page, true);

        await saveViaWindowHandle(page);
        const restoredSummary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        expect(restoredSummary.bySubtype.Highlight ?? 0).toBe(1);
        await waitForActiveTabDirtyState(page, false);
    });

});
