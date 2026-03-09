import type { Page } from 'puppeteer-core';
import {
    DEFAULT_TIMEOUT_MS,
    findVisiblePointInActiveHost,
} from './viewer-dom';
import {
    openAnnotationsTab,
    waitForViewerInteractive,
} from './viewer-core';

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

function resolveToolId(label: string): string | null {
    if (label === 'Select') {
        return null;
    }
    return TOOL_LABEL_TO_ID[label] ?? label.toLowerCase();
}

async function waitForAnnotationEditorLayerInteractive(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.waitForFunction(() => {
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
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? visibleHosts.find(candidate => candidate.querySelector('.annotationEditorLayer, .annotation-editor-layer'))
            ?? visibleHosts[0]
            ?? null;
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

export async function clickAnnotationTool(page: Page, label: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openAnnotationsTab(page, timeoutMs);
    await waitForViewerInteractive(page, timeoutMs);

    const toolId = resolveToolId(label);

    if (toolId === null) {
        await page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
            const activeBtn = host?.querySelector<HTMLButtonElement>('.notes-panel .tool-button.is-active');
            activeBtn?.click();
        });
        return;
    }

    const selector = `.notes-panel .tool-button[data-tool="${toolId}"]`;
    const point = await findVisiblePointInActiveHost(page, selector);
    if (!point) {
        throw new Error(`Annotation tool not found: ${label}`);
    }

    await page.mouse.click(point.x, point.y);
    const waitUntilActive = async (waitTimeout: number) => {
        await page.waitForFunction((expectedToolId: string) => {
            const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
            if (!host) {
                return false;
            }
            const activeBtn = host.querySelector('.notes-panel .tool-button.is-active');
            return activeBtn?.getAttribute('data-tool') === expectedToolId;
        }, {timeout: waitTimeout}, toolId);
    };

    try {
        await waitUntilActive(Math.min(timeoutMs, 4_000));
    } catch {
        await page.evaluate((expectedToolId: string) => {
            const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
            const button = host?.querySelector<HTMLButtonElement>(`.notes-panel .tool-button[data-tool="${expectedToolId}"]`);
            button?.click();
        }, toolId);
        await waitUntilActive(Math.max(4_000, timeoutMs));
    }
}

export async function setAnnotationColor(page: Page, colorHex: string) {
    await openAnnotationsTab(page);

    const updated = await page.evaluate((targetColor: string) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        const swatches = Array.from(host?.querySelectorAll<HTMLButtonElement>('.notes-panel .swatch') ?? []);
        const normalise = (c: string) => c.toLowerCase().trim();
        const swatch = swatches.find((btn) => normalise(btn.title) === normalise(targetColor));
        if (!swatch) {
            return false;
        }
        swatch.click();
        return true;
    }, colorHex);

    if (!updated) {
        throw new Error('Annotation color swatch not found');
    }
}

export async function getActiveToolLabel(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        return host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null;
    });
}

export async function getFreeTextEditorCount(page: Page) {
    return page.evaluate(() => {
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
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? visibleHosts.find(candidate => candidate.querySelector('.freeTextEditor'))
            ?? visibleHosts[0]
            ?? null;
        return host?.querySelectorAll('.freeTextEditor').length ?? 0;
    });
}

export async function getHighlightEditorCount(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        return host?.querySelectorAll('.highlightEditor').length ?? 0;
    });
}

export async function clickPageAtRatio(
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
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : (visibleHosts.find(candidate => candidate.querySelector(pageSelector)) ?? visibleHosts[0] ?? null);
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

export async function createFreeTextAnnotation(page: Page, text: string, position?: {
    x: number;
    y: number;
}, pageNumber?: number) {
    const before = await getFreeTextEditorCount(page);
    await clickAnnotationTool(page, 'Text');
    try {
        await waitForAnnotationEditorLayerInteractive(page, Math.min(DEFAULT_TIMEOUT_MS, 5_000));
    } catch {
        await waitForViewerInteractive(page, Math.min(DEFAULT_TIMEOUT_MS, 5_000));
    }
    await clickPageAtRatio(page, position ?? {
        x: 0.4,
        y: 0.3,
    }, pageNumber);
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
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? visibleHosts.find(candidate => candidate.querySelector('.freeTextEditor'))
                ?? visibleHosts[0]
                ?? null;
            return (host?.querySelectorAll('.freeTextEditor').length ?? 0) > minCount;
        }, {timeout: timeoutMs}, before);
    };

    try {
        await waitForEditor(DEFAULT_TIMEOUT_MS);
    } catch {
        await clickAnnotationTool(page, 'Text');
        try {
            await waitForAnnotationEditorLayerInteractive(page, Math.min(DEFAULT_TIMEOUT_MS, 8_000));
        } catch {
            await waitForViewerInteractive(page, Math.min(DEFAULT_TIMEOUT_MS, 8_000));
        }
        const textLayerPoint = await page.evaluate((targetPageNumber: number | null) => {
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
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const pageSelector = targetPageNumber
                ? `.page_container[data-page="${targetPageNumber}"]`
                : '.page_container';
            const host = (
                activeHost
                && visibleHosts.includes(activeHost)
                && activeHost.querySelector(pageSelector)
            )
                ? activeHost
                : (visibleHosts.find(candidate => candidate.querySelector(pageSelector)) ?? visibleHosts[0] ?? null);
            if (!host) {
                return null;
            }

            const pageContainer = host.querySelector<HTMLElement>(pageSelector);
            const textLayer = pageContainer?.querySelector<HTMLElement>('.text-layer, .textLayer');
            const target = textLayer ?? pageContainer;
            if (!target) {
                return null;
            }

            const rect = target.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        }, pageNumber ?? null);

        if (textLayerPoint) {
            await page.mouse.click(textLayerPoint.x, textLayerPoint.y);
        }

        await waitForEditor(8_000);
    }

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
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? visibleHosts.find(candidate => candidate.querySelector('.freeTextEditor'))
            ?? visibleHosts[0]
            ?? null;
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
        const debugState = await page.evaluate(() => {
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
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? visibleHosts[0]
                ?? null;
            return {
                activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? '',
                pageCount: host?.querySelectorAll('.page_container').length ?? 0,
                textLayerCount: host?.querySelectorAll('.text-layer, .textLayer').length ?? 0,
                freeTextCount: host?.querySelectorAll('.freeTextEditor').length ?? 0,
            };
        });
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
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? visibleHosts.find(candidate => candidate.querySelector('.freeTextEditor'))
            ?? visibleHosts[0]
            ?? null;
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
    await page.keyboard.type(text, { delay: 10 });
    await page.waitForFunction((typedText: string) => {
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
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? visibleHosts.find(candidate => candidate.querySelector('.freeTextEditor'))
            ?? visibleHosts[0]
            ?? null;
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
        const latestEditor = editors[editors.length - 1];
        const editable = latestEditor?.querySelector<HTMLElement>('[contenteditable], .internal')
            ?? latestEditor
            ?? null;
        const latestText = (editable?.textContent ?? '')
            .replace(/\u200B/g, '')
            .trim();
        return latestText.includes(typedText.trim());
    }, {timeout: 4_000}, text);

    return getFreeTextEditorCount(page);
}

export async function deleteLatestFreeTextAnnotation(page: Page) {
    const before = await getFreeTextEditorCount(page);
    if (before === 0) {
        return 0;
    }

    await clickAnnotationTool(page, 'Select');
    await waitForViewerInteractive(page);

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
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? visibleHosts.find(candidate => candidate.querySelector('.freeTextEditor'))
            ?? visibleHosts[0]
            ?? null;
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const editor = editors[editors.length - 1];
        if (!editor) {
            return null;
        }

        const overlay = editor.querySelector<HTMLElement>('.overlay');
        const targetRect = (overlay ?? editor).getBoundingClientRect();
        return {
            x: Math.round(targetRect.left + Math.max(4, Math.min(targetRect.width - 4, 8))),
            y: Math.round(targetRect.top + Math.max(4, Math.min(targetRect.height - 4, 8))),
        };
    });

    if (!editorPoint) {
        return before;
    }

    await page.mouse.click(editorPoint.x, editorPoint.y);
    await page.keyboard.press('Delete');

    const waitForCountDrop = async (timeoutMs: number) => {
        await page.waitForFunction((previousCount: number) => {
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
            const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? visibleHosts.find(candidate => candidate.querySelector('.freeTextEditor'))
                ?? visibleHosts[0]
                ?? null;
            return (host?.querySelectorAll('.freeTextEditor').length ?? 0) < previousCount;
        }, {timeout: timeoutMs}, before);
    };

    try {
        await waitForCountDrop(Math.min(DEFAULT_TIMEOUT_MS, 3_500));
    } catch {
        await page.mouse.click(editorPoint.x, editorPoint.y, { button: 'right' });
        await page.waitForSelector('.annotation-context-menu .pdf-context-menu__action--danger', {timeout: 4_000});
        await page.click('.annotation-context-menu .pdf-context-menu__action--danger');
        await waitForCountDrop(DEFAULT_TIMEOUT_MS);
    }

    return getFreeTextEditorCount(page);
}

export async function createHighlightFromVisibleText(page: Page) {
    const before = await getHighlightEditorCount(page);
    await clickAnnotationTool(page, 'Highlight');

    const dragPoints = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        if (!host) {
            return null;
        }

        const spans = Array.from(host.querySelectorAll<HTMLElement>('.page_container .text-layer span, .page_container .textLayer span'))
            .filter((span) => (span.textContent ?? '').trim().length > 0);
        if (spans.length < 2) {
            return null;
        }

        const first = spans[0]?.getBoundingClientRect();
        const second = spans[1]?.getBoundingClientRect();
        if (!first || !second) {
            return null;
        }

        return {
            x1: Math.round(first.left + 2),
            y1: Math.round(first.top + first.height / 2),
            x2: Math.round(second.right - 2),
            y2: Math.round(second.top + second.height / 2),
        };
    });

    if (!dragPoints) {
        throw new Error('Unable to locate visible text spans for highlight creation');
    }

    await page.mouse.move(dragPoints.x1, dragPoints.y1);
    await page.mouse.down();
    await page.mouse.move(dragPoints.x2, dragPoints.y2, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction((previousCount: number) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        return (host?.querySelectorAll('.highlightEditor').length ?? 0) > previousCount;
    }, {timeout: DEFAULT_TIMEOUT_MS}, before);

    return getHighlightEditorCount(page);
}

export async function openContextMenuOnLatestFreeText(page: Page) {
    await clickAnnotationTool(page, 'Select');

    const point = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const editor = editors[editors.length - 1];
        if (!editor) {
            return null;
        }
        const rect = editor.getBoundingClientRect();
        return {
            x: Math.round(rect.left + Math.max(4, rect.width / 2)),
            y: Math.round(rect.top + Math.max(4, rect.height / 2)),
        };
    });

    if (!point) {
        return {
            visible: false,
            items: [] as string[],
        };
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    await page.waitForSelector('.annotation-context-menu', {timeout: 4_000});

    return page.evaluate(() => {
        const menu = document.querySelector('.annotation-context-menu');
        const items = Array.from(document.querySelectorAll('.annotation-context-menu button, .annotation-context-menu [role="menuitem"]'))
            .map(item => (item.textContent ?? '').trim())
            .filter(Boolean);
        return {
            visible: Boolean(menu),
            items,
        };
    });
}

export async function countFreeTextEditorsOnPage(page: Page, pageNumber: number) {
    return page.evaluate((targetPageNumber: number) => {
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
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const pageSelector = `.page_container[data-page="${targetPageNumber}"]`;
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : (visibleHosts.find(candidate => candidate.querySelector(pageSelector)) ?? visibleHosts[0] ?? null);
        if (!host) {
            return 0;
        }
        return host.querySelectorAll(`${pageSelector} .freeTextEditor`).length;
    }, pageNumber);
}

export async function getFirstFreeTextComputedColor(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        const editor = host?.querySelector<HTMLElement>('.freeTextEditor [contenteditable], .freeTextEditor');
        if (!editor) {
            return null;
        }
        return window.getComputedStyle(editor).color;
    });
}
