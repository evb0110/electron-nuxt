import type { Page } from 'puppeteer-core';
import type { IAnnotationSyncAutomationActivity } from '@app/types/annotations';
import { delay } from 'es-toolkit/promise';
import { readPdfAnnotationSummary } from '@tests/e2e/electron/helpers/fixtures';
import {
    DEFAULT_TIMEOUT_MS,
    findVisiblePointInActiveHost,
} from '@tests/e2e/electron/helpers/viewerDom';
import {
    openAnnotationsTab,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import {
    collectWorkspaceExposeDebugState,
    installWorkspaceExposeProbe,
    type IWorkspaceExposeProbeWindow,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const TOOL_LABEL_TO_ID: Record<string, string> = {
    'Draw': 'draw',
    'Text': 'text',
    'Highlight': 'highlight',
    'Underline': 'underline',
    'Strikethrough': 'strikethrough',
    'Rectangle': 'rectangle',
    'Circle': 'circle',
    'Line': 'line',
    'Arrow': 'arrow',
};

function resolveToolId(label: string) {
    if (label === 'Select') {
        return 'select';
    }
    return TOOL_LABEL_TO_ID[label] ?? label.toLowerCase();
}

async function waitForActiveAnnotationTool(
    page: Page,
    toolId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    await page.waitForFunction((expectedToolId: string) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        if (!host) {
            return false;
        }
        const activeBtn = host.querySelector('.notes-panel .tool-button.is-active');
        return activeBtn?.getAttribute('data-tool') === expectedToolId;
    }, {timeout: timeoutMs}, toolId);
}

async function waitForAnnotationEditorLayerInteractive(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.waitForFunction(() => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost('.annotationEditorLayer, .annotation-editor-layer');
        if (!host) {
            return false;
        }

        const viewer = host.querySelector('.pdfViewer');
        if (!viewer || viewer.classList.contains('pdfViewer--resize-transition')) {
            return false;
        }

        const editorLayer = Array.from(host.querySelectorAll<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) {
                    return false;
                }
                const layerStyle = window.getComputedStyle(candidate);
                return (
                    layerStyle.display !== 'none'
                    && layerStyle.visibility !== 'hidden'
                    && Number(layerStyle.opacity || '1') > 0
                    && layerStyle.pointerEvents !== 'none'
                );
            });
        return Boolean(editorLayer);
    }, {timeout: timeoutMs});
}

async function waitForAnnotationEditorMode(
    page: Page,
    modeClass: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pageNumber?: number,
) {
    await page.waitForFunction((args: {
        modeClass: string;
        targetPageNumber: number | null;
    }) => {
        const pageSelector = args.targetPageNumber
            ? `.page_container[data-page="${args.targetPageNumber}"]`
            : '.page_container';
        const host = globalThis.__evbE2E.getActiveWorkspaceHost(pageSelector);
        if (!host) {
            return false;
        }

        const pageContainer = host.querySelector<HTMLElement>(pageSelector);
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
        if (!layer || layer.hidden) {
            return false;
        }

        const rect = layer.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const style = window.getComputedStyle(layer);
        if (
            style.display === 'none'
            || style.visibility === 'hidden'
            || Number(style.opacity || '1') === 0
            || style.pointerEvents === 'none'
            || layer.classList.contains('waiting')
            || layer.classList.contains('disabled')
        ) {
            return false;
        }

        return layer.classList.contains(args.modeClass);
    }, { timeout: timeoutMs }, {
        modeClass,
        targetPageNumber: pageNumber ?? null,
    });
}

async function getActiveToolLabel(page: Page) {
    return page.evaluate(() => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        return host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null;
    });
}

export async function clickAnnotationTool(page: Page, label: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openAnnotationsTab(page, timeoutMs);
    await waitForViewerInteractive(page, timeoutMs);

    const toolId = resolveToolId(label);
    if (await getActiveToolLabel(page) === toolId) {
        return;
    }

    const selector = `.notes-panel .tool-button[data-tool="${toolId}"]`;
    const point = await findVisiblePointInActiveHost(page, selector);
    if (!point) {
        throw new Error(`Annotation tool not found: ${label}`);
    }

    await page.mouse.click(point.x, point.y);
    await waitForActiveAnnotationTool(page, toolId, timeoutMs);
}

export async function setAnnotationColor(page: Page, colorHex: string) {
    await openAnnotationsTab(page);
    const activeTool = await getActiveToolLabel(page);

    const updated = await page.evaluate((targetColor: string) => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        const swatches = Array.from(host?.querySelectorAll<HTMLButtonElement>('.notes-panel .swatch') ?? []);
        const normalise = (c: string) => c.toLowerCase().trim();
        const swatch = swatches.find((btn) => normalise(btn.getAttribute('aria-label') ?? '') === normalise(targetColor));
        if (!swatch) {
            return false;
        }
        swatch.click();
        return true;
    }, colorHex);

    if (!updated) {
        throw new Error('Annotation color swatch not found');
    }

    if (activeTool) {
        await waitForActiveAnnotationTool(page, activeTool, Math.min(DEFAULT_TIMEOUT_MS, 4_000));
    }

    await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
}


export async function getFreeTextEditorCount(page: Page) {
    return page.evaluate(() => {
        const host = globalThis.__evbE2E.getActiveWorkspaceHost('.freeTextEditor');
        return host?.querySelectorAll('.freeTextEditor').length ?? 0;
    });
}

export async function getHighlightEditorCount(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
            ?? null;
        return host?.querySelectorAll('.highlightEditor').length ?? 0;
    });
}


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

export async function getVisibleHighlightEditorCount(page: Page) {
    const counts = await getVisibleHighlightEditorCounts(page);
    return Math.max(0, ...counts);
}

export async function waitForHighlightEditorCount(page: Page, expectedCount: number) {
    const startedAt = Date.now();
    let counts = await getVisibleHighlightEditorCounts(page);
    while (Date.now() - startedAt < 20_000) {
        if (
            (expectedCount === 0 && counts.every(count => count === 0))
            || (expectedCount > 0 && counts.some(count => count === expectedCount))
        ) {
            return;
        }
        await delay(150);
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
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
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

export async function waitForPdfAnnotationSubtypeCount(filePath: string, subtype: string, expectedCount: number) {
    const startedAt = Date.now();
    let lastSummary = await readPdfAnnotationSummary(filePath);
    while (Date.now() - startedAt < 20_000) {
        if ((lastSummary.bySubtype[subtype] ?? 0) === expectedCount) {
            return lastSummary;
        }
        await delay(150);
        lastSummary = await readPdfAnnotationSummary(filePath);
    }
    throw new Error(`Expected ${expectedCount} ${subtype} annotations on disk, got ${lastSummary.bySubtype[subtype] ?? 0}`);
}

export async function createHighlightWithPdfjsManager(page: Page) {
    const before = await getVisibleHighlightEditorCount(page);
    let result = 'missing-ui-manager';
    const startedAt = Date.now();
    await installWorkspaceExposeProbe(page);
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
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
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

            const manager = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredMethods: ['highlightSelection'] }) as {
                highlightSelection?: (methodOfCreation?: string) => void;
                updateMode?: (mode: number) => Promise<void>;
                waitForEditorsRendered?: (pageNumber: number) => Promise<void>;
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
            await delay(150);
        }
    }

    if (result !== 'ok' && result !== 'issued-highlight') {
        throw new Error(`Unable to create highlight: ${result}`);
    }
    await waitForHighlightEditorCount(page, before + 1);
    return getVisibleHighlightEditorCount(page);
}

export async function waitForNoOpenNoteWindows(page: Page) {
    try {
        await page.waitForFunction(() => {
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
            const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
                .filter(isVisible);
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && visibleHosts.includes(activeHost)
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const root: ParentNode = host ?? document;
            return Array.from(root.querySelectorAll('textarea.note-window__textarea'))
                .flatMap(candidate => (
                    candidate instanceof HTMLTextAreaElement
                    && isVisible(candidate)
                        ? [candidate]
                        : []
                ))
                .length === 0;
        }, { timeout: 8_000 });
    } catch {
        throw new Error(`Timed out waiting for note windows to close: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
    }
}

export async function clickLatestVisibleNoteWindowClose(page: Page) {
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
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const root: ParentNode = host ?? document;
        const closeButton = Array.from(root.querySelectorAll('.note-window__close'))
            .flatMap(candidate => (
                candidate instanceof HTMLButtonElement
                && isVisible(candidate)
                    ? [candidate]
                    : []
            ))
            .at(-1);
        closeButton?.click();
        return Boolean(closeButton);
    });
    if (!clicked) {
        throw new Error(`Could not close a visible note window: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
    }
}

export async function collectStickyNoteDebugState(page: Page) {
    const workspaceDebug = await collectWorkspaceExposeDebugState(page, { requiredProperties: ['annotationComments'] });
    const domDebug = await page.evaluate(() => {
        const unwrap = (value: unknown) => (
            value
            && typeof value === 'object'
            && 'value' in value
                ? (value as { value?: unknown }).value
                : value
        );
        const setupState = (
            (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['annotationComments'] })
            ?? (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredProperties: ['pdfViewerRef'] })
        ) as Record<string, unknown> | null;
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
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
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
            annotationEditorState,
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
    return {
        ...domDebug,
        toolbarSnapshots: workspaceDebug.toolbarSnapshots,
        matchingComponentSamples: workspaceDebug.matchingComponentSamples,
    };
}


async function resolveAnnotationLayerPoint(
    page: Page,
    ratio: {
        x: number;
        y: number;
    },
    pageNumber?: number,
) {
    await waitForViewerInteractive(page);

    return page.evaluate(({
        xRatio,
        yRatio,
        targetPageNumber,
    }) => {
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const host = globalThis.__evbE2E.getActiveWorkspaceHost(pageSelector);
        if (!host) {
            return null;
        }

        const pageContainer = host.querySelector<HTMLElement>(pageSelector);
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
        const target = layer ?? pageContainer;
        if (!target) {
            return null;
        }

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        return {
            x: Math.round(rect.left + rect.width * xRatio),
            y: Math.round(rect.top + rect.height * yRatio),
        };
    }, {
        xRatio: ratio.x,
        yRatio: ratio.y,
        targetPageNumber: pageNumber ?? null,
    });
}

async function clickPageAtRatio(
    page: Page,
    ratio: {
        x: number;
        y: number;
    },
    pageNumber?: number,
) {
    await waitForViewerInteractive(page);

    const point = await page.evaluate(({
        xRatio,
        yRatio,
        targetPageNumber,
    }) => {
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const host = globalThis.__evbE2E.getActiveWorkspaceHost(pageSelector);
        if (!host) {
            return null;
        }

        const pageContainer = host.querySelector<HTMLElement>(pageSelector);
        if (!pageContainer) {
            return null;
        }

        const rect = pageContainer.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width * xRatio),
            y: Math.round(rect.top + rect.height * yRatio),
        };
    }, {
        xRatio: ratio.x,
        yRatio: ratio.y,
        targetPageNumber: pageNumber ?? null,
    });

    if (!point) {
        throw new Error(`Target page not found${pageNumber ? ` (page ${pageNumber})` : ''}`);
    }

    await page.mouse.click(point.x, point.y);
}

async function synthesizeAnnotationCreationClick(
    page: Page,
    ratio: {
        x: number;
        y: number;
    },
    pageNumber?: number,
) {
    await waitForViewerInteractive(page);

    return page.evaluate(({
        xRatio,
        yRatio,
        targetPageNumber,
    }) => {
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const host = globalThis.__evbE2E.getActiveWorkspaceHost(pageSelector);
        if (!host) {
            return false;
        }

        const pageContainer = host.querySelector<HTMLElement>(pageSelector);
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
        const target = layer ?? pageContainer ?? null;
        if (!target) {
            return false;
        }

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const clientX = Math.round(rect.left + rect.width * xRatio);
        const clientY = Math.round(rect.top + rect.height * yRatio);
        const dispatchTarget = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(
            '.annotationEditorLayer, .annotation-editor-layer, .page_container',
        ) ?? target;
        const eventTarget = dispatchTarget instanceof HTMLElement ? dispatchTarget : target;
        const eventBase = {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            button: 0,
            buttons: 1,
            composed: true,
        };
        const dispatchMouse = (type: string, buttons: number) => eventTarget.dispatchEvent(new MouseEvent(type, {
            ...eventBase,
            buttons,
        }));

        eventTarget.focus?.();
        dispatchMouse('mousemove', 0);
        dispatchMouse('mouseenter', 0);
        dispatchMouse('mouseover', 0);
        dispatchMouse('mousedown', 1);
        dispatchMouse('mouseup', 0);
        dispatchMouse('click', 0);
        return true;
    }, {
        xRatio: ratio.x,
        yRatio: ratio.y,
        targetPageNumber: pageNumber ?? null,
    });
}

async function collectFreeTextCreationDebugState(page: Page, pageNumber?: number) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((targetPageNumber: number | null) => {
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const host = globalThis.__evbE2E.getActiveWorkspaceHost(pageSelector);
        const pageContainer = host?.querySelector<HTMLElement>(pageSelector) ?? null;
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer') ?? null;
        const viewer = layer?.closest<HTMLElement>('.pdfViewer') ?? null;
        const uiManager = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.({ requiredMethods: ['getLayer'] }) as Record<string, unknown> | null | undefined;
        const pageAttribute = Number(pageContainer?.dataset.page ?? '1');
        const resolvedPageNumber = Number.isFinite(pageAttribute) && pageAttribute > 0
            ? pageAttribute
            : 1;
        const resolvedPageIndex = Math.max(0, (targetPageNumber ?? resolvedPageNumber) - 1);
        const uiManagerLayerAccess = uiManager as {
            getLayer?: (pageIndex: number) => unknown;
            currentLayer?: unknown;
        } | null;
        const getLayer = uiManagerLayerAccess?.getLayer;
        const programmaticLayer = getLayer?.call(uiManager, resolvedPageIndex)
            ?? uiManagerLayerAccess?.currentLayer
            ?? null;
        const programmaticLayerEditorAccess: { createAndAddNewEditor?: unknown; } | null = programmaticLayer;
        const fatalDialog = document.querySelector<HTMLElement>('[role="alertdialog"][aria-modal="true"]');
        const detailBlock = fatalDialog?.querySelector('#fatal-runtime-detail') ?? null;

        return {
            activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? '',
            pageCount: host?.querySelectorAll('.page_container').length ?? 0,
            textLayerCount: host?.querySelectorAll('.text-layer, .textLayer').length ?? 0,
            freeTextCount: host?.querySelectorAll('.freeTextEditor').length ?? 0,
            freeTextEditingLayerCount: host?.querySelectorAll('.annotationEditorLayer.freetextEditing, .annotation-editor-layer.freetextEditing').length ?? 0,
            waitingLayerCount: host?.querySelectorAll('.annotationEditorLayer.waiting, .annotation-editor-layer.waiting').length ?? 0,
            disabledLayerCount: host?.querySelectorAll('.annotationEditorLayer.disabled, .annotation-editor-layer.disabled').length ?? 0,
            pageRect: pageContainer
                ? {
                    width: Math.round(pageContainer.getBoundingClientRect().width),
                    height: Math.round(pageContainer.getBoundingClientRect().height),
                }
                : null,
            pageClassName: pageContainer?.className ?? null,
            pageLayerReadiness: pageContainer?.dataset.pageLayerReadiness ?? null,
            pagePointerEvents: pageContainer ? window.getComputedStyle(pageContainer).pointerEvents : null,
            viewerClassName: viewer?.className ?? null,
            viewerPointerEvents: viewer ? window.getComputedStyle(viewer).pointerEvents : null,
            layerClassName: layer?.className ?? null,
            layerPointerEvents: layer ? window.getComputedStyle(layer).pointerEvents : null,
            hasProgrammaticUiManager: Boolean(uiManager),
            hasProgrammaticEditorLayer: Boolean(programmaticLayer),
            programmaticLayerSupportsCreate: typeof programmaticLayerEditorAccess?.createAndAddNewEditor === 'function',
            fatalRuntimeVisible: Boolean(fatalDialog),
            fatalRuntimeDetail: detailBlock?.textContent?.trim() ?? null,
        };
    }, pageNumber ?? null);
}

async function triggerKeyboardFreeTextCreation(page: Page, pageNumber?: number) {
    await waitForViewerInteractive(page);

    const focused = await page.evaluate((targetPageNumber: number | null) => {
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const host = globalThis.__evbE2E.getActiveWorkspaceHost(pageSelector);
        const pageContainer = host?.querySelector<HTMLElement>(pageSelector) ?? null;
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer') ?? null;
        const focusTarget = layer ?? pageContainer ?? host ?? null;
        if (!focusTarget) {
            return false;
        }

        focusTarget.tabIndex = Math.max(0, focusTarget.tabIndex);
        focusTarget.focus();
        return document.activeElement === focusTarget;
    }, pageNumber ?? null);

    if (!focused) {
        return false;
    }

    await page.keyboard.press('Enter');
    return true;
}

export async function createFreeTextAnnotation(page: Page, text: string, position?: {
    x: number;
    y: number;
}, pageNumber?: number) {
    const before = await getFreeTextEditorCount(page);
    const targetRatio = position ?? {
        x: 0.4,
        y: 0.3,
    };
    const clickAnnotationCreationPoint = async () => {
        const point = await resolveAnnotationLayerPoint(page, targetRatio, pageNumber);
        if (!point) {
            await clickPageAtRatio(page, targetRatio, pageNumber);
            return 'page';
        }
        await page.mouse.click(point.x, point.y);
        return 'mouse';
    };
    const dispatchAnnotationCreationPoint = async () => {
        const dispatched = await synthesizeAnnotationCreationClick(page, targetRatio, pageNumber);
        if (!dispatched) {
            await clickPageAtRatio(page, targetRatio, pageNumber);
            return 'page';
        }
        return 'dom';
    };
    const triggerKeyboardCreationPoint = async () => {
        const created = await triggerKeyboardFreeTextCreation(page, pageNumber);
        if (!created) {
            await clickPageAtRatio(page, targetRatio, pageNumber);
            return 'page';
        }
        return 'keyboard';
    };
    const waitForEditor = async (timeoutMs: number) => {
        await page.waitForFunction((minCount: number) => {
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
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
                ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
            const createdEditor = editors.length > minCount ? editors[editors.length - 1] : null;
            const createdEditable = createdEditor?.querySelector<HTMLElement>('[contenteditable], .internal')
                ?? createdEditor;
            if (createdEditable) {
                // Seed the editor in the same browser task that observes it.
                // PDF.js may remove an empty editor between this predicate and
                // the next CDP round trip, particularly on headless Linux.
                createdEditable.textContent ||= '\u200B';
                return true;
            }

            const targetLayer = host?.querySelector<HTMLElement>('.annotationEditorLayer.freetextEditing, .annotation-editor-layer.freetextEditing');
            const activeEditor = targetLayer?.querySelector<HTMLElement>('.freeTextEditor .internal[contenteditable="true"], .freeTextEditor [contenteditable="true"]');
            if (!activeEditor) {
                return false;
            }
            activeEditor.textContent ||= '\u200B';
            return true;
        }, {timeout: timeoutMs}, before);
    };

    const ensureFreeTextCreationReady = async (timeoutMs: number) => {
        if (await getActiveToolLabel(page) !== 'text') {
            await clickAnnotationTool(page, 'Text', timeoutMs);
        } else {
            await openAnnotationsTab(page, timeoutMs);
            await waitForViewerInteractive(page, timeoutMs);
        }
        try {
            await waitForAnnotationEditorLayerInteractive(page, Math.min(timeoutMs, 8_000));
        } catch {
            await waitForViewerInteractive(page, Math.min(timeoutMs, 8_000));
        }
        await waitForAnnotationEditorMode(page, 'freetextEditing', timeoutMs, pageNumber);
    };

    let lastEditorWaitError: unknown = null;
    let editorReady = false;
    for (const attemptTimeoutMs of [
        4_000,
        6_000,
        10_000,
    ]) {
        try {
            await ensureFreeTextCreationReady(attemptTimeoutMs);
        } catch (error) {
            lastEditorWaitError = error;
            continue;
        }

        for (const strategy of [
            clickAnnotationCreationPoint,
            dispatchAnnotationCreationPoint,
            triggerKeyboardCreationPoint,
        ]) {
            await strategy();

            try {
                await waitForEditor(attemptTimeoutMs);
                editorReady = true;
                break;
            } catch (error) {
                lastEditorWaitError = error;
                await page.evaluate(async () => {
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                });
            }
        }

        if (editorReady) {
            break;
        }
    }

    if (!editorReady) {
        const debugState = await collectFreeTextCreationDebugState(page, pageNumber);
        const baseMessage = lastEditorWaitError instanceof Error
            ? lastEditorWaitError.message
            : 'Failed to create FreeText editor';
        throw new Error(`${baseMessage} (${JSON.stringify(debugState)})`);
    }

    // Prevent PDF.js from auto-removing the empty editor before we can type
    // into it. Mirrors useAnnotationHighlight.ts:1082-1087.
    await page.evaluate(() => {
        const editors = Array.from(document.querySelectorAll<HTMLElement>('.freeTextEditor'));
        const latest = editors[editors.length - 1];
        const editable = latest?.querySelector<HTMLElement>('[contenteditable], .internal') ?? latest;
        if (editable) {
            editable.textContent = '\u200B';
        }
    });

    const editorPoint = await page.evaluate(() => {
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
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const editor = editors[editors.length - 1];
        if (!editor) {
            return null;
        }

        const editable = editor.querySelector<HTMLElement>('[contenteditable], .internal') ?? editor;
        const rect = editable.getBoundingClientRect();
        return {
            x: Math.round(rect.left + Math.max(4, rect.width / 2)),
            y: Math.round(rect.top + Math.max(4, rect.height / 2)),
        };
    });

    if (!editorPoint) {
        const debugState = await collectFreeTextCreationDebugState(page, pageNumber);
        throw new Error(`Failed to locate created FreeText editor (${JSON.stringify(debugState)})`);
    }

    await page.mouse.click(editorPoint.x, editorPoint.y);
    await page.evaluate(() => {
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
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const latestEditor = editors[editors.length - 1];
        const editable = latestEditor?.querySelector<HTMLElement>('[contenteditable], .internal')
            ?? latestEditor
            ?? null;
        if (!editable) {
            return false;
        }
        editable.focus();
        if (editable.isContentEditable) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editable);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
        }
        return true;
    });
    const waitForLatestFreeTextContent = async (typedText: string, timeoutMs: number) => {
        await page.waitForFunction((expectedText: string) => {
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
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
                ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
            const latestEditor = editors[editors.length - 1];
            const editable = latestEditor?.querySelector<HTMLElement>('[contenteditable], .internal')
                ?? latestEditor
                ?? null;
            const latestText = (editable?.textContent ?? '')
                .replace(/\u200B/g, '')
                .trim();
            return latestText.includes(expectedText.trim());
        }, {timeout: timeoutMs}, typedText);
    };

    const tryInjectEditorContent = (expectedText: string) => page.evaluate((text: string) => {
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
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
        const latestEditor = editors[editors.length - 1];
        const editable = latestEditor?.querySelector<HTMLElement>('[contenteditable], .internal')
            ?? latestEditor
            ?? null;
        if (!editable) {
            return 'no-editor';
        }

        editable.focus();

        if (!editable.isContentEditable) {
            editable.setAttribute('contenteditable', 'true');
        }

        editable.textContent = text;

        try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editable);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } catch {
            // Selection API may not work in headless — content is already set.
        }

        editable.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: text,
            inputType: 'insertText',
        }));
        editable.dispatchEvent(new Event('change', {bubbles: true}));
        return 'ok';
    }, expectedText);

    const injectLatestFreeTextContent = async (typedText: string) => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await page.evaluate(async () => {
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            });
            const result = await tryInjectEditorContent(typedText);
            if (result === 'ok') {
                return;
            }
            if (attempt < 4) {
                await page.evaluate(() => new Promise<void>(r => setTimeout(r, 300)));
            }
        }
        throw new Error('Failed to inject created FreeText editor content');
    };

    await page.keyboard.type(text, { delay: 10 });

    try {
        await waitForLatestFreeTextContent(text, 6_000);
    } catch {
        await injectLatestFreeTextContent(text);
        await waitForLatestFreeTextContent(text, 8_000);
    }

    return getFreeTextEditorCount(page);
}

interface IAnnotationUndoBoundarySample {
    label: string;
    highlightEditorCount: number;
    highlightAnnotationCount: number;
    canonicalHighlightCount: number;
    canonicalAnnotationCount: number;
    freeTextEditorCount: number;
    editorLayerTags: string[];
    removedHighlightNodeIds: string[];
    addedHighlightNodeIds: string[];
}

interface ICanonicalAnnotationProjection {
    subtype?: string;
    deleted?: boolean;
}

interface IAnnotationUndoBoundaryProbe {
    removed: string[];
    added: string[];
    host: HTMLElement;
    disconnect: () => void;
}

interface IAnnotationUndoBoundaryProbeWindow extends Window {__evbAnnotationUndoBoundaryProbe?: IAnnotationUndoBoundaryProbe;}

/**
 * Clicks a history toolbar action and records what the annotation editor layer
 * looks like at the synchronous replay, across two animation frames, and in a
 * following macrotask. A MutationObserver records which highlight nodes the
 * replay actually removed or restored, so an assertion can name the node rather
 * than infer it from a count.
 *
 * Every count, layer tag, and observed record is scoped to the active workspace
 * host, resolved once up front: inactive tabs keep their viewers mounted, and a
 * document-wide count would fold their editors into the comparison.
 */
export async function clickHistoryActionAcrossAnimationBoundaries(page: Page, label: 'Undo' | 'Redo') {
    // The canonical projection below reads the shared workspace expose test API,
    // so it has to be installed before the page evaluation starts.
    await installWorkspaceExposeProbe(page);
    const samples = await page.evaluate(async (targetLabel: string) => {
        const probeWindow = window as IAnnotationUndoBoundaryProbeWindow & IWorkspaceExposeProbeWindow;
        probeWindow.__evbAnnotationUndoBoundaryProbe?.disconnect();

        // A missing test API would make every canonical count read as zero, which
        // is exactly the value an undo assertion expects, so fail instead.
        const testApi = probeWindow.__evbTestApi;
        if (typeof testApi?.readActiveWorkspaceStateValues !== 'function') {
            throw new Error('Annotation undo boundary probe requires window.__evbTestApi.readActiveWorkspaceStateValues');
        }

        // Resolved once and reused by every sample: re-resolving per boundary
        // could silently switch hosts mid-run, and an unresolvable host would
        // otherwise degrade into document-wide counts.
        const host = globalThis.__evbE2E.getActiveWorkspaceHost();
        if (!host) {
            throw new Error('Annotation undo boundary probe could not resolve the active workspace host');
        }

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
        const highlightNodeId = (node: Node) => {
            if (!(node instanceof HTMLElement)) {
                return null;
            }
            const match = node.matches('.highlightEditor, .highlightAnnotation')
                ? node
                : node.querySelector<HTMLElement>('.highlightEditor, .highlightAnnotation');
            return match ? (match.id || '(anonymous)') : null;
        };

        // Tag the editor layers before the replay: a sample whose tags still
        // match proves the node disappeared from a surviving layer instead of
        // the whole layer being torn down and rebuilt.
        Array.from(host.querySelectorAll<HTMLElement>('.annotationEditorLayer'))
            .forEach((layer, index) => {
                layer.dataset.evbUndoProbeLayer ??= `layer-${index}-${layer.childElementCount}`;
            });

        const removed: string[] = [];
        const added: string[] = [];
        const observer = new MutationObserver((records) => {
            records.forEach((record) => {
                // Belt and braces with the scoped observe() below: a record
                // whose target left the active host describes another viewer.
                if (!host.contains(record.target)) {
                    return;
                }
                record.removedNodes.forEach((node) => {
                    const id = highlightNodeId(node);
                    if (id) removed.push(id);
                });
                record.addedNodes.forEach((node) => {
                    const id = highlightNodeId(node);
                    if (id) added.push(id);
                });
            });
        });
        observer.observe(host, {
            childList: true,
            subtree: true,
        });

        // The canonical projection is read in-page at each boundary: an editor
        // and its entity have to disappear together, and only a same-task read
        // can show whether they did.
        const canonicalAnnotations = () => {
            const state = testApi.readActiveWorkspaceStateValues<{annotationComments?: ICanonicalAnnotationProjection[]}>(
                ['annotationComments'],
            );
            const comments = state?.annotationComments;
            if (!Array.isArray(comments)) {
                observer.disconnect();
                throw new Error(`Annotation undo boundary probe read no canonical annotationComments projection: ${JSON.stringify(state ?? null)}`);
            }
            return comments.filter(comment => comment.deleted !== true);
        };

        const collected: IAnnotationUndoBoundarySample[] = [];
        const sample = (sampleLabel: string) => {
            collected.push({
                label: sampleLabel,
                highlightEditorCount: host.querySelectorAll('.highlightEditor').length,
                highlightAnnotationCount: host.querySelectorAll('.highlightAnnotation').length,
                canonicalHighlightCount: canonicalAnnotations()
                    .filter(comment => comment.subtype === 'Highlight').length,
                canonicalAnnotationCount: canonicalAnnotations().length,
                freeTextEditorCount: host.querySelectorAll('.freeTextEditor').length,
                editorLayerTags: Array.from(host.querySelectorAll<HTMLElement>('.annotationEditorLayer'))
                    .map(layer => layer.dataset.evbUndoProbeLayer ?? '(untagged)'),
                removedHighlightNodeIds: [...removed],
                addedHighlightNodeIds: [...added],
            });
        };

        // The workspace toolbar is teleported into the shell toolbar host, so it
        // sits outside the workspace host; the visible-and-enabled filter is
        // what keeps this on the active document's action.
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => (
                candidate.getAttribute('aria-label')?.trim() === targetLabel
                && isVisible(candidate)
                && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true'
            ));
        if (!button) {
            observer.disconnect();
            throw new Error(`Enabled toolbar action not found: ${targetLabel}`);
        }
        sample('before');
        button.click();
        sample('synchronous');
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        sample('frame-1');
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        sample('frame-2');
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        sample('deferred-task');

        // The observer stays attached past the sampled boundaries so a later
        // deferred sync that resurrects a node is still recorded.
        probeWindow.__evbAnnotationUndoBoundaryProbe = {
            removed,
            added,
            host,
            disconnect: () => observer.disconnect(),
        };
        return collected;
    }, label);
    return {
        samples,
        at: (sampleLabel: string) => {
            const sample = samples.find(candidate => candidate.label === sampleLabel);
            if (!sample) {
                throw new Error(`Missing ${sampleLabel} sample: ${JSON.stringify(samples)}`);
            }
            return sample;
        },
    };
}

/**
 * Disconnects the retained boundary probe. The observer deliberately outlives the
 * sampled boundaries so a later deferred sync is still recorded, so a suite that
 * uses the probe has to release it during cleanup.
 */
export async function disconnectAnnotationUndoBoundaryProbe(page: Page) {
    await page.evaluate(() => {
        const probeWindow = window as IAnnotationUndoBoundaryProbeWindow;
        probeWindow.__evbAnnotationUndoBoundaryProbe?.disconnect();
        delete probeWindow.__evbAnnotationUndoBoundaryProbe;
    });
}

/**
 * Reads everything the still-attached MutationObserver has seen so far, counted
 * inside the same workspace host the probe was installed against. An absent
 * probe would read as "nothing was added" — exactly what the callers assert —
 * so a missing or relocated probe throws instead of passing vacuously.
 */
export async function readAnnotationUndoBoundaryProbe(page: Page) {
    return page.evaluate((): {
        removed: string[];
        added: string[];
        highlightEditorCount: number;
        highlightAnnotationCount: number;
    } => {
        const probe = (window as IAnnotationUndoBoundaryProbeWindow).__evbAnnotationUndoBoundaryProbe;
        if (!probe) {
            throw new Error('Annotation undo boundary probe is not installed');
        }
        if (!probe.host.isConnected) {
            throw new Error('Annotation undo boundary probe host left the document');
        }
        const activeHost = globalThis.__evbE2E.getActiveWorkspaceHost();
        if (activeHost && activeHost !== probe.host) {
            throw new Error('Annotation undo boundary probe host is no longer the active workspace host');
        }
        return {
            removed: [...probe.removed],
            added: [...probe.added],
            highlightEditorCount: probe.host.querySelectorAll('.highlightEditor').length,
            highlightAnnotationCount: probe.host.querySelectorAll('.highlightAnnotation').length,
        };
    });
}

interface IAnnotationSyncActivityWindow extends Window {__evbAnnotationSyncActivity?: IAnnotationSyncAutomationActivity;}

const ANNOTATION_SYNC_IDLE_TIMEOUT_MS = 15_000;

function readAnnotationSyncActivity(page: Page) {
    return page.evaluate((): IAnnotationSyncAutomationActivity | null => {
        const activity = (window as IAnnotationSyncActivityWindow).__evbAnnotationSyncActivity;
        return activity ? { ...activity } : null;
    });
}

/**
 * Reads the annotation sync ledger's request counter. Captured before a
 * mutation, it is the baseline `waitForAnnotationSyncIdle` uses to tell the
 * sync that mutation triggers from one that had already finished.
 */
export async function readAnnotationSyncRequestSeq(page: Page) {
    return (await readAnnotationSyncActivity(page))?.requestSeq ?? 0;
}

/**
 * Waits until a comment sync requested after `afterRequestSeq` has run to
 * completion — editor scan, awaited PDF snapshot, and applied state — and
 * nothing further is queued or debounced.
 *
 * A sidebar count settles from the canonical projection, which moves before the
 * sync that could still overwrite it, so it cannot stand in for this. The
 * ledger only exists under the renderer automation grant, so a run without it
 * times out here rather than asserting against an unfinished sync.
 */
export async function waitForAnnotationSyncIdle(
    page: Page,
    afterRequestSeq: number,
    timeoutMs = ANNOTATION_SYNC_IDLE_TIMEOUT_MS,
) {
    try {
        await page.waitForFunction((baselineSeq: number) => {
            const activity = (window as IAnnotationSyncActivityWindow).__evbAnnotationSyncActivity;
            if (!activity) {
                return false;
            }
            return activity.requestSeq > baselineSeq
                && activity.servicedSeq >= activity.requestSeq
                && activity.runningPasses === 0
                && activity.pendingDebounces === 0;
        }, {timeout: timeoutMs}, afterRequestSeq);
    } catch (error) {
        const activity = await readAnnotationSyncActivity(page);
        throw new Error(
            `Timed out waiting for an annotation sync after request ${afterRequestSeq} to settle: ${JSON.stringify(activity)}`,
            {cause: error},
        );
    }
    return readAnnotationSyncActivity(page);
}
