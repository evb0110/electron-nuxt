import type { IOcrWord } from '@app/types/pdf';
import { transformWordBox } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformWordBox';

function buildWordBoxKey(word: IOcrWord) {
    return `${word.text}|${word.x}|${word.y}|${word.width}|${word.height}`;
}

export function createWordBoxOverlays(
    words: IOcrWord[],
    pdfPageWidth: number | undefined,
    pdfPageHeight: number | undefined,
    renderedPageWidth: number,
    renderedPageHeight: number,
    currentMatchWords?: Set<string>,
): HTMLElement[] {
    if (!words || words.length === 0) {
        return [];
    }

    const boxes: HTMLElement[] = [];

    for (const word of words) {
        const box = transformWordBox(
            word,
            pdfPageWidth,
            pdfPageHeight,
            renderedPageWidth,
            renderedPageHeight,
        );

        if (box.width === 0 || box.height === 0) {
            continue;
        }

        const boxDiv = document.createElement('div');
        boxDiv.className = 'pdf-word-box';
        boxDiv.setAttribute('data-word', word.text);
        boxDiv.style.cssText = `
            position: absolute;
            left: ${box.x}px;
            top: ${box.y}px;
            width: ${box.width}px;
            height: ${box.height}px;
            background: var(--app-pdf-search-highlight-bg);
            pointer-events: none;
            box-sizing: border-box;
        `;

        if (currentMatchWords?.has(buildWordBoxKey(word))) {
            boxDiv.classList.add('pdf-word-box--current');
            boxDiv.style.backgroundColor = 'var(--app-pdf-search-highlight-current-bg)';
        }

        boxes.push(boxDiv);
    }

    return boxes;
}
