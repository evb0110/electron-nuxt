/**
 * Text layer selection handling based on Mozilla PDF.js TextLayerBuilder
 * Fixes selection "wandering" by dynamically repositioning an endOfContent sentinel div
 */

interface ITextLayerEntry {
    textLayer: HTMLElement;
    endOfContent: HTMLElement;
}

const textLayers = new Map<HTMLElement, ITextLayerEntry>();
const mouseDownHandlers = new WeakMap<HTMLElement, () => void>();
let selectionAbortController: AbortController | null = null;
let prevRange: Range | null = null;
let isPointerDown = false;
let activeSelectionLayer: HTMLElement | null = null;
let previousSelectionLayer: HTMLElement | null = null;

function reset(entry: ITextLayerEntry) {
    const {
        textLayer,
        endOfContent,
    } = entry;
    textLayer.appendChild(endOfContent);
    endOfContent.style.width = '';
    endOfContent.style.height = '';
    textLayer.classList.remove('selecting');
}

function resolveTextLayerFromNode(node: Node | null) {
    if (!node) {
        return null;
    }

    const element = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
    return element?.closest('.text-layer') as HTMLElement | null;
}

function clearTrackedSelectionLayers() {
    const layersToReset = new Set<HTMLElement>();
    if (activeSelectionLayer) {
        layersToReset.add(activeSelectionLayer);
    }
    if (previousSelectionLayer) {
        layersToReset.add(previousSelectionLayer);
    }

    layersToReset.forEach((layer) => {
        const entry = textLayers.get(layer);
        if (entry) {
            reset(entry);
        }
    });

    activeSelectionLayer = null;
    previousSelectionLayer = null;
}

function updateSelectionSentinel(
    textLayerDiv: HTMLElement,
    entry: ITextLayerEntry,
    range: Range,
) {
    const { endOfContent } = entry;
    endOfContent.style.width = textLayerDiv.style.width || '100%';
    endOfContent.style.height = textLayerDiv.style.height || '100%';
    endOfContent.style.userSelect = 'text';

    const modifyStart = prevRange && (
        range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0
    );

    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;

    if (anchor?.nodeType === Node.TEXT_NODE) {
        anchor = anchor.parentNode;
    }

    if (!modifyStart && range.endOffset === 0 && anchor) {
        while (anchor && !anchor.previousSibling) {
            anchor = anchor.parentNode;
        }
        if (anchor) {
            anchor = anchor.previousSibling;
            while (anchor && !(anchor as Element).childNodes?.length) {
                anchor = anchor.previousSibling;
            }
        }
    }

    if (!anchor) {
        return;
    }

    const anchorParent = (anchor as Element).parentElement;
    if (anchorParent) {
        anchorParent.insertBefore(
            endOfContent,
            modifyStart ? anchor : (anchor as Element).nextSibling,
        );
    }
}

function enableGlobalSelectionListener() {
    if (selectionAbortController) {
        return;
    }

    selectionAbortController = new AbortController();
    const { signal } = selectionAbortController;

    document.addEventListener(
        'pointerdown',
        () => {
            isPointerDown = true;
        },
        { signal },
    );

    document.addEventListener(
        'pointerup',
        () => {
            isPointerDown = false;
            clearTrackedSelectionLayers();
        },
        { signal },
    );

    window.addEventListener(
        'blur',
        () => {
            isPointerDown = false;
            clearTrackedSelectionLayers();
        },
        { signal },
    );

    document.addEventListener(
        'keyup',
        () => {
            if (!isPointerDown) {
                clearTrackedSelectionLayers();
            }
        },
        { signal },
    );

    document.addEventListener(
        'selectionchange',
        () => {
            const selection = document.getSelection();
            if (!selection || selection.rangeCount === 0) {
                clearTrackedSelectionLayers();
                prevRange = null;
                return;
            }

            const range = selection.getRangeAt(0);
            const nextActiveLayer =
                resolveTextLayerFromNode(range.commonAncestorContainer) ??
                resolveTextLayerFromNode(selection.anchorNode) ??
                resolveTextLayerFromNode(selection.focusNode) ??
                activeSelectionLayer ??
                previousSelectionLayer;

            const layersToReset = new Set<HTMLElement>();
            if (activeSelectionLayer && activeSelectionLayer !== nextActiveLayer) {
                layersToReset.add(activeSelectionLayer);
            }
            if (
                previousSelectionLayer &&
                previousSelectionLayer !== nextActiveLayer &&
                previousSelectionLayer !== activeSelectionLayer
            ) {
                layersToReset.add(previousSelectionLayer);
            }

            layersToReset.forEach((layer) => {
                const entry = textLayers.get(layer);
                if (entry) {
                    reset(entry);
                }
            });

            previousSelectionLayer = activeSelectionLayer;
            activeSelectionLayer = nextActiveLayer;

            if (!nextActiveLayer) {
                prevRange = range.cloneRange();
                return;
            }

            const entry = textLayers.get(nextActiveLayer);
            if (entry) {
                nextActiveLayer.classList.add('selecting');
                updateSelectionSentinel(nextActiveLayer, entry, range);
            }

            prevRange = range.cloneRange();
        },
        { signal },
    );
}

function teardownTextLayer(textLayerDiv: HTMLElement) {
    const entry = textLayers.get(textLayerDiv);
    if (entry) {
        textLayers.delete(textLayerDiv);
        textLayerDiv.classList.remove('selecting');
        entry.endOfContent.remove();
    }

    if (activeSelectionLayer === textLayerDiv) {
        activeSelectionLayer = null;
    }
    if (previousSelectionLayer === textLayerDiv) {
        previousSelectionLayer = null;
    }

    const mouseDownHandler = mouseDownHandlers.get(textLayerDiv);
    if (mouseDownHandler) {
        textLayerDiv.removeEventListener('mousedown', mouseDownHandler);
        mouseDownHandlers.delete(textLayerDiv);
    }

    if (textLayers.size === 0 && selectionAbortController) {
        selectionAbortController.abort();
        selectionAbortController = null;
        prevRange = null;
        activeSelectionLayer = null;
        previousSelectionLayer = null;
    }
}

export const useTextLayerSelection = () => {
    function setupTextLayer(textLayerDiv: HTMLElement) {
        const existingEntry = textLayers.get(textLayerDiv);
        if (existingEntry) {
            return () => {
                teardownTextLayer(textLayerDiv);
            };
        }

        for (const staleEndOfContent of textLayerDiv.querySelectorAll<HTMLElement>('.end-of-content[data-evb-text-layer-selection="true"]')) {
            staleEndOfContent.remove();
        }

        const endOfContent = document.createElement('div');
        endOfContent.className = 'end-of-content';
        endOfContent.dataset.evbTextLayerSelection = 'true';
        textLayerDiv.appendChild(endOfContent);

        let mouseDownHandler = mouseDownHandlers.get(textLayerDiv);
        if (!mouseDownHandler) {
            mouseDownHandler = () => {
                textLayerDiv.classList.add('selecting');
            };
            textLayerDiv.addEventListener('mousedown', mouseDownHandler);
            mouseDownHandlers.set(textLayerDiv, mouseDownHandler);
        }

        textLayers.set(textLayerDiv, {
            textLayer: textLayerDiv,
            endOfContent,
        });

        enableGlobalSelectionListener();

        return () => {
            teardownTextLayer(textLayerDiv);
        };
    }

    return { setupTextLayer };
};
