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
} from '@tests/e2e/electron/helpers/fixtures';
import {
    type IElectronE2ESession,
    startElectronE2ESession,
} from '@tests/e2e/electron/helpers/sessionHarness';
import {
    createFreeTextAnnotation,
    getFreeTextEditorCount,
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForActiveWorkspaceHost,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerHelpers';

interface IVueWorkspaceHost extends HTMLElement {__vueParentComponent?: {
    exposed?: unknown;
    setupState?: {
        mountedWorkspace?: { value?: unknown };
        workspaceRef?: { value?: unknown };
    } & Record<string, unknown>;
};}

const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;

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
    const workspaceDebug = await page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return (
                    rect.width > 100
                    && rect.height > 100
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                );
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        return {
            visibleHostCount: visibleHosts.length,
            activeHostVisible: Boolean(activeHost && visibleHosts.includes(activeHost)),
            pageContainers: Array.from(host?.querySelectorAll<HTMLElement>('.page_container') ?? [])
                .map(pageContainer => ({
                    page: pageContainer.dataset.page ?? null,
                    rendered: pageContainer.classList.contains('page_container--rendered'),
                    highlightCount: pageContainer.querySelectorAll('.highlightEditor, .highlightAnnotation').length,
                })),
        };
    });
    throw new Error(
        `Expected visible highlight count ${expectedCount}, got [${counts.join(', ')}]: ${JSON.stringify(details)}; workspace=${JSON.stringify(workspaceDebug)}`,
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
    const clicked = await page.evaluate(async (targetLabel: string) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const commandName = targetLabel === 'Undo'
            ? 'handleUndo'
            : targetLabel === 'Redo'
                ? 'handleRedo'
                : null;
        const canRunKey = targetLabel === 'Undo'
            ? 'canUndo'
            : targetLabel === 'Redo'
                ? 'canRedo'
                : null;
        if (!commandName || !canRunKey) {
            return false;
        }
        const visibleHosts = Array.from(document.querySelectorAll<IVueWorkspaceHost>('.workspace-host')).filter(isVisible);
        const activeHost = document.querySelector<IVueWorkspaceHost>('.editor-group-pane.is-active .workspace-host');
        const preferredHost = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const preferredComponent = preferredHost?.__vueParentComponent;
        const preferredCandidates = [
            preferredComponent?.exposed,
            preferredComponent?.setupState?.mountedWorkspace?.value,
            preferredComponent?.setupState?.workspaceRef?.value,
        ];
        for (const candidate of preferredCandidates) {
            if (!candidate || typeof candidate !== 'object') {
                continue;
            }
            const commandSurface = candidate as {
                getToolbarSnapshot?: () => Record<string, unknown>;
                handleRedo?: () => unknown;
                handleUndo?: () => unknown;
            };
            if (
                typeof commandSurface[commandName] !== 'function'
                || commandSurface.getToolbarSnapshot?.()[canRunKey] !== true
            ) {
                continue;
            }
            await Promise.resolve(commandSurface[commandName]());
            return true;
        }

        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => (
                candidate.getAttribute('aria-label')?.trim() === targetLabel
                && isVisible(candidate)
                && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true'
            ));
        button?.click();
        if (button) {
            return true;
        }

        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            const component = (element as IVueWorkspaceHost).__vueParentComponent;
            const candidates = [
                component?.setupState?.mountedWorkspace?.value,
                component?.setupState?.workspaceRef?.value,
                component?.exposed,
            ];
            for (const candidate of candidates) {
                if (!candidate || typeof candidate !== 'object') {
                    continue;
                }
                const commandSurface = candidate as {
                    getToolbarSnapshot?: () => Record<string, unknown>;
                    handleRedo?: () => unknown;
                    handleUndo?: () => unknown;
                };
                if (
                    typeof commandSurface[commandName] !== 'function'
                    || commandSurface.getToolbarSnapshot?.()[canRunKey] !== true
                ) {
                    continue;
                }
                await Promise.resolve(commandSurface[commandName]());
                return true;
            }
        }
        return false;
    }, label);

    if (!clicked) {
        const debugState = await page.evaluate((targetLabel: string) => {
            const isVisible = (candidate: HTMLElement) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 0
                    && rect.height > 0
                );
            };
            const unwrap = (value: unknown) => (
                value
                && typeof value === 'object'
                && 'value' in value
                    ? (value as { value?: unknown }).value
                    : value
            );
            const toolbarSnapshots: unknown[] = [];
            const annotationStates: unknown[] = [];
            for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                const component = (element as IVueWorkspaceHost).__vueParentComponent;
                const candidates = [
                    component?.setupState,
                    component?.setupState?.mountedWorkspace?.value,
                    component?.setupState?.workspaceRef?.value,
                    component?.exposed,
                ];
                for (const candidate of candidates) {
                    if (
                        candidate
                        && typeof candidate === 'object'
                        && typeof (candidate as { getToolbarSnapshot?: unknown }).getToolbarSnapshot === 'function'
                    ) {
                        toolbarSnapshots.push((candidate as { getToolbarSnapshot: () => unknown }).getToolbarSnapshot());
                    }
                    const setupState = (
                        candidate
                        && typeof candidate === 'object'
                        && '$' in candidate
                            ? (candidate as { $?: { setupState?: unknown } }).$?.setupState
                            : candidate
                    ) as Record<string, unknown> | null | undefined;
                    if (setupState?.annotationEditorState || setupState?.annotationComments) {
                        annotationStates.push({
                            annotationEditorState: unwrap(setupState.annotationEditorState) ?? null,
                            annotationCommentsCount: Array.isArray(unwrap(setupState.annotationComments))
                                ? (unwrap(setupState.annotationComments) as unknown[]).length
                                : null,
                        });
                    }
                }
            }
            return {
                buttons: Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
                    .filter(button => button.getAttribute('aria-label')?.trim() === targetLabel)
                    .map(button => ({
                        visible: isVisible(button),
                        disabled: button.disabled,
                        ariaDisabled: button.getAttribute('aria-disabled'),
                        text: button.textContent?.trim() ?? '',
                    })),
                toolbarSnapshots,
                annotationStates,
            };
        }, label);
        throw new Error(`Enabled toolbar action not found: ${label}: ${JSON.stringify(debugState)}`);
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

async function resolvePageNotePoint(page: Page) {
    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
        if (!pageElement) {
            return null;
        }

        const rect = pageElement.getBoundingClientRect();
        const x = Math.min(
            Math.max(rect.left + 24, rect.left + rect.width * 0.72),
            window.innerWidth - 96,
        );
        const y = Math.min(
            Math.max(rect.top + 24, rect.top + rect.height * 0.24),
            window.innerHeight - 96,
        );
        return {
            x,
            y,
        };
    });
}

async function tryCreatePageNoteViaContextMenu(page: Page) {
    const point = await resolvePageNotePoint(page);
    if (!point) {
        return null;
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    const created = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        ));
        const button = buttons.find(candidate =>
            (candidate.textContent ?? '').trim().toLowerCase() === 'add note here',
        );
        if (!button || button.disabled) {
            return false;
        }
        button.click();
        return true;
    });

    if (!created) {
        return null;
    }

    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch {
        throw new Error(`Context-menu note action did not open a note window: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
    }
    return point;
}

async function tryCreatePageNoteViaSidebarButton(page: Page) {
    const point = await resolvePageNotePoint(page);
    if (!point) {
        return null;
    }

    const started = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(
            '.notes-list-header .notes-header-btn',
        ) ?? [])
            .filter(button => !button.disabled && isVisible(button))
            .find((button) => {
                const label = (button.getAttribute('aria-label') ?? '').trim().toLowerCase();
                return label.startsWith('place note') || label.includes('place note on page');
            });
        button?.click();
        return Boolean(button);
    });

    if (!started) {
        return null;
    }

    await page.mouse.click(point.x, point.y);
    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch {
        return null;
    }
    return point;
}

async function getVisibleSidebarAnnotationCount(page: Page) {
    return page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        return Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible)
            .length;
    });
}

async function waitForSidebarAnnotationCount(page: Page, expectedCount: number) {
    await page.waitForFunction((count: number) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const visibleItems = Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible);
        return visibleItems.length === count;
    }, { timeout: 8_000 }, expectedCount);
}

async function waitForSidebarAnnotationText(page: Page, expectedText: string) {
    await page.waitForFunction((text: string) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        return Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible)
            .some(item => item.textContent?.includes(text));
    }, { timeout: 8_000 }, expectedText);
}

async function openThumbnailsTab(page: Page) {
    const result = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const sidebar = host?.querySelector<HTMLElement>('.pdf-sidebar');
        const tabList = sidebar?.querySelector<HTMLElement>('[role="tablist"]') ?? sidebar?.firstElementChild;
        const roleTabs = Array.from(tabList?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
            .filter(isVisible);
        const tabs = roleTabs.length > 0
            ? roleTabs
            : Array.from(tabList?.querySelectorAll<HTMLElement>('button') ?? [])
                .filter(isVisible);
        const pagesTab = tabs.find(tab => (
            (tab.textContent ?? '').includes('Pages')
            || (tab.getAttribute('aria-label') ?? '').includes('Pages')
            || (tab.getAttribute('title') ?? '').includes('Pages')
        )) ?? tabs[1] ?? null;
        const rect = pagesTab?.getBoundingClientRect();
        return {
            clicked: Boolean(pagesTab),
            clickPoint: rect
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null,
            tabCount: tabs.length,
            tabText: tabs.map(tab => tab.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
        };
    });

    if (!result.clicked || !result.clickPoint) {
        throw new Error(`Could not open thumbnails tab: ${JSON.stringify(result)}`);
    }
    await page.mouse.click(result.clickPoint.x, result.clickPoint.y);

    try {
        await page.waitForFunction(() => {
            const isVisible = (candidate: HTMLElement) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 0
                    && rect.height > 0
                );
            };
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const host = activeHost && isVisible(activeHost)
                ? activeHost
                : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
            const thumbnail = host?.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnail.is-active');
            const canvas = thumbnail?.querySelector<HTMLCanvasElement>('canvas') ?? null;
            return Boolean(thumbnail && canvas && isVisible(thumbnail) && isVisible(canvas));
        }, { timeout: 8_000 });
    } catch {
        const debug = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.pdf-sidebar'))
            .map((sidebar) => {
                const isVisible = (candidate: HTMLElement) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return (
                        style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && rect.width > 0
                        && rect.height > 0
                    );
                };
                const tabs = Array.from(sidebar.querySelectorAll<HTMLElement>('[role="tab"], button'))
                    .map(tab => ({
                        visible: isVisible(tab),
                        text: tab.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                        aria: tab.getAttribute('aria-label') ?? null,
                        title: tab.getAttribute('title') ?? null,
                        selected: tab.getAttribute('aria-selected') ?? null,
                        state: tab.getAttribute('data-state') ?? null,
                        classes: tab.className,
                    }));
                const pages = sidebar.querySelector<HTMLElement>('.pdf-sidebar-pages');
                const pagesRect = pages?.getBoundingClientRect();
                return {
                    sidebarVisible: isVisible(sidebar),
                    tabs,
                    pagesDisplay: pages ? window.getComputedStyle(pages).display : null,
                    pagesRect: pagesRect
                        ? {
                            width: Math.round(pagesRect.width),
                            height: Math.round(pagesRect.height),
                        }
                        : null,
                };
            }));
        throw new Error(`Could not open visible thumbnails tab: clicked=${JSON.stringify(result)} debug=${JSON.stringify(debug)}`);
    }
}

async function getActiveThumbnailYellowPixelCount(page: Page) {
    return page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const canvas = host?.querySelector<HTMLCanvasElement>(
            '.pdf-sidebar-pages-thumbnails .pdf-thumbnail.is-active canvas',
        ) ?? null;
        if (
            !canvas
            || !isVisible(canvas)
            || canvas.width <= 0
            || canvas.height <= 0
            || canvas.dataset.thumbnailRendered !== 'true'
        ) {
            return null;
        }
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            return null;
        }
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let yellowPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            const alpha = pixels[index + 3] ?? 0;
            if (
                alpha > 120
                && red > 190
                && green > 155
                && blue < 205
                && red - blue > 35
                && green - blue > 10
            ) {
                yellowPixels += 1;
            }
        }
        return yellowPixels;
    });
}

async function waitForActiveThumbnailYellowPixelCount(
    page: Page,
    predicate: (count: number) => boolean,
    label: string,
) {
    const startedAt = Date.now();
    let count = await getActiveThumbnailYellowPixelCount(page);
    while (Date.now() - startedAt < 12_000) {
        if (typeof count === 'number' && predicate(count)) {
            return count;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
        count = await getActiveThumbnailYellowPixelCount(page);
    }
    const debug = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const thumbnails = Array.from(host?.querySelectorAll<HTMLElement>(
            '.pdf-sidebar-pages-thumbnails .pdf-thumbnail',
        ) ?? []);
        return {
            hostVisible: Boolean(host),
            activeTabButton: Array.from(host?.querySelectorAll<HTMLElement>('[role="tab"], button') ?? [])
                .filter(isVisible)
                .map(button => ({
                    text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                    aria: button.getAttribute('aria-label') ?? null,
                    selected: button.getAttribute('aria-selected') ?? null,
                    state: button.getAttribute('data-state') ?? null,
                }))
                .slice(0, 8),
            thumbnails: thumbnails.map((thumbnail) => {
                const rect = thumbnail.getBoundingClientRect();
                const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
                return {
                    page: thumbnail.dataset.page ?? null,
                    active: thumbnail.classList.contains('is-active'),
                    visible: isVisible(thumbnail),
                    rect: {
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    },
                    canvasWidth: canvas?.width ?? null,
                    canvasHeight: canvas?.height ?? null,
                    rendered: canvas?.dataset.thumbnailRendered ?? null,
                    renderKey: canvas?.dataset.thumbnailRenderKey ?? null,
                };
            }),
        };
    });
    throw new Error(`Timed out waiting for thumbnail yellow pixels (${label}); last count=${count}; debug=${JSON.stringify(debug)}`);
}

async function waitForNoOpenNoteWindows(page: Page) {
    try {
        await page.waitForFunction(() => (
            document.querySelectorAll('textarea.note-window__textarea').length === 0
        ), { timeout: 8_000 });
    } catch {
        throw new Error(`Timed out waiting for note windows to close: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
    }
}

async function collectStickyNoteDebugState(page: Page) {
    return page.evaluate(() => {
        const unwrap = (value: unknown) => (
            value
            && typeof value === 'object'
            && 'value' in value
                ? (value as { value?: unknown }).value
                : value
        );
        let setupState: Record<string, unknown> | null = null;
        const comments = Array.from(document.querySelectorAll<HTMLElement>('.notes-list .note-item'))
            .map(item => item.textContent?.replace(/\s+/g, ' ').trim() ?? '');
        const noteWindows = Array.from(document.querySelectorAll<HTMLElement>('.note-window'))
            .map(windowElement => windowElement.textContent?.replace(/\s+/g, ' ').trim() ?? '');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return (
                    rect.width > 100
                    && rect.height > 100
                    && style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                );
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const pageContainers = Array.from(host?.querySelectorAll<HTMLElement>('.page_container') ?? [])
            .map((pageContainer) => {
                const rect = pageContainer.getBoundingClientRect();
                const editorLayer = pageContainer.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
                return {
                    page: pageContainer.dataset.page ?? null,
                    rendered: pageContainer.classList.contains('page_container--rendered'),
                    rect: {
                        left: Math.round(rect.left),
                        top: Math.round(rect.top),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    },
                    editorLayerClasses: editorLayer?.className ?? null,
                    freeTextCount: pageContainer.querySelectorAll('.freeTextEditor').length,
                    highlightCount: pageContainer.querySelectorAll('.highlightEditor, .highlightAnnotation').length,
                };
            });
        const toolbarButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .map(button => ({
                label: button.getAttribute('aria-label'),
                disabled: button.disabled,
                classes: button.className,
            }))
            .filter(button => (button.label ?? '').toLowerCase().includes('note'));
        const contextButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        )).map(button => ({
            text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            disabled: button.disabled,
        }));
        const toolbarSnapshots: unknown[] = [];
        const matchingComponentSamples: Array<{
            exposedKeys: string[];
            setupKeys: string[];
            tag: string;
        }> = [];
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
            const component = (element as IVueWorkspaceHost).__vueParentComponent;
            if (!component) {
                continue;
            }
            const exposedKeys = component.exposed && typeof component.exposed === 'object'
                ? Object.keys(component.exposed)
                : [];
            const setupKeys = component.setupState && typeof component.setupState === 'object'
                ? Object.keys(component.setupState)
                : [];
            const candidates = [
                component.setupState?.mountedWorkspace?.value,
                component.setupState?.workspaceRef?.value,
                component.exposed,
            ];
            for (const candidate of candidates) {
                if (
                    candidate
                    && typeof candidate === 'object'
                    && typeof (candidate as { getToolbarSnapshot?: unknown }).getToolbarSnapshot === 'function'
                ) {
                    toolbarSnapshots.push((candidate as { getToolbarSnapshot: () => unknown }).getToolbarSnapshot());
                }
                const candidateSetup = (
                    candidate
                    && typeof candidate === 'object'
                    && '$' in candidate
                        ? (candidate as { $?: { setupState?: unknown } }).$?.setupState
                        : null
                ) as Record<string, unknown> | null;
                if (!setupState && (candidateSetup?.pdfViewerRef || candidateSetup?.annotationComments)) {
                    setupState = candidateSetup;
                }
            }
            if (
                matchingComponentSamples.length < 12
                && [
                    ...exposedKeys,
                    ...setupKeys,
                ].some(key => [
                    'workspaceRef',
                    'mountedWorkspace',
                    'pdfViewerRef',
                    'annotationComments',
                    'handleQuickNote',
                    'commentAtPoint',
                ].includes(key))
            ) {
                matchingComponentSamples.push({
                    tag: element.tagName.toLowerCase(),
                    exposedKeys: exposedKeys.slice(0, 20),
                    setupKeys: setupKeys.slice(0, 20),
                });
            }
        }

        const annotationComments = setupState
            ? unwrap(setupState['annotationComments'])
            : null;
        const annotationEditorState = setupState
            ? unwrap(setupState['annotationEditorState'])
            : null;
        const sortedNoteWindows = setupState
            ? (
                unwrap(setupState['sortedAnnotationNoteWindows'])
                ?? unwrap(setupState['annotationNoteWindows'])
            )
            : null;

        return {
            comments,
            noteWindows,
            visibleHostCount: visibleHosts.length,
            activeHostVisible: Boolean(activeHost && visibleHosts.includes(activeHost)),
            pdfViewerCount: document.querySelectorAll('#pdf-viewer').length,
            pageContainers,
            toolbarButtons,
            contextButtons,
            toolbarSnapshots,
            annotationEditorState,
            matchingComponentSamples,
            annotationComments: Array.isArray(annotationComments)
                ? annotationComments.map((comment) => {
                    const entry = comment as Record<string, unknown>;
                    return {
                        stableKey: entry.stableKey ?? null,
                        source: entry.source ?? null,
                        subtype: entry.subtype ?? null,
                        hasNote: entry.hasNote ?? null,
                        text: entry.text ?? null,
                        createdAt: entry.createdAt ?? null,
                        modifiedAt: entry.modifiedAt ?? null,
                    };
                })
                : null,
            sortedNoteWindows: Array.isArray(sortedNoteWindows)
                ? sortedNoteWindows.map((note) => {
                    const entry = note as Record<string, unknown>;
                    const comment = (entry.comment ?? {}) as Record<string, unknown>;
                    return {
                        stableKey: comment.stableKey ?? null,
                        source: comment.source ?? null,
                        subtype: comment.subtype ?? null,
                        text: comment.text ?? null,
                        createdAt: comment.createdAt ?? null,
                        modifiedAt: comment.modifiedAt ?? null,
                    };
                })
                : null,
        };
    });
}

async function placeEmptyNote(page: Page) {
    const contextMenuPoint = await tryCreatePageNoteViaContextMenu(page);
    if (contextMenuPoint) {
        return;
    }

    const sidebarPoint = await tryCreatePageNoteViaSidebarButton(page);
    if (sidebarPoint) {
        return;
    }

    throw new Error(`Could not create sticky note through visible controls: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
}

async function setLatestNoteWindowText(page: Page, text: string) {
    await page.evaluate((noteText: string) => {
        const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'));
        const textarea = textareas.at(-1) ?? null;
        if (!textarea) {
            throw new Error('No note window textarea found');
        }
        const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
        )?.set;
        setter?.call(textarea, noteText);
        textarea.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: noteText,
            inputType: 'insertText',
        }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
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

    it('shows a placed empty sticky note in the sidebar before text is entered', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 session was not initialized');
        }

        const noteFixturePath = await createMultiPageTextFixturePdf(
            `phase1-${Date.now()}-sticky-sidebar.pdf`,
            1,
        );
        await openPdfInApp(page, noteFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineCount = await getVisibleSidebarAnnotationCount(page);
        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineCount + 1);

        const noteText = `Sticky sidebar text ${Date.now()}`;
        await setLatestNoteWindowText(page, noteText);
        await waitForSidebarAnnotationCount(page, baselineCount + 1);
        await waitForSidebarAnnotationText(page, noteText);

        await clickFirstSidebarAnnotationDelete(page);
        await waitForNoOpenNoteWindows(page);
        await waitForSidebarAnnotationCount(page, baselineCount);
    });

    it('undoes a sticky note created after a highlight without removing the highlight', async () => {
        const page = session?.page;
        if (!page) {
            throw new Error('Phase 1 session was not initialized');
        }

        const noteFixturePath = await createMultiPageTextFixturePdf(
            `phase1-${Date.now()}-highlight-then-note-undo.pdf`,
            1,
        );
        await openPdfInApp(page, noteFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineHighlightCount = await getVisibleHighlightEditorCount(page);
        const baselineSidebarCount = await getVisibleSidebarAnnotationCount(page);
        await createHighlightWithPdfjsManager(page);
        await waitForHighlightEditorCount(page, baselineHighlightCount + 1);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);

        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 2);

        await clickEnabledToolbarAction(page, 'Undo');

        await waitForNoOpenNoteWindows(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);
        await waitForHighlightEditorCount(page, baselineHighlightCount + 1);
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
        await openThumbnailsTab(page);
        await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count > 80,
            'live highlight visible before save',
        );
        await openAnnotationsTab(page);

        await saveViaWindowHandle(page);
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, true);
        await openThumbnailsTab(page);
        await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count < 20,
            'undone live highlight hidden before save',
        );
        await openAnnotationsTab(page);

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
        await openThumbnailsTab(page);
        const highlightedThumbnailYellowCount = await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count > 80,
            'persisted highlight visible in thumbnail',
        );
        await openAnnotationsTab(page);

        await clickFirstSidebarAnnotationDelete(page);
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, true);
        await openThumbnailsTab(page);
        const deletedThumbnailYellowCount = await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count <= Math.max(20, Math.floor(highlightedThumbnailYellowCount * 0.25)),
            'deleted persisted highlight hidden in thumbnail',
        );
        expect(deletedThumbnailYellowCount).toBeLessThan(highlightedThumbnailYellowCount);
        await openAnnotationsTab(page);

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
