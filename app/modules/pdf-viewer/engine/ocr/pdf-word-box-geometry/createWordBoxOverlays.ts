import type { IOcrWord } from '@app/types/pdf';
import { transformWordBox } from '@app/modules/pdf-viewer/engine/ocr/pdf-word-box-geometry/transformWordBox';

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
            border: 1px solid rgba(0, 100, 255, 0.4);
            background: rgba(0, 100, 255, 0.1);
            pointer-events: none;
            box-sizing: border-box;
        `;

        if (currentMatchWords?.has(word.text)) {
            boxDiv.classList.add('pdf-word-box--current');
            boxDiv.style.backgroundColor = 'rgba(0, 150, 255, 0.25)';
            boxDiv.style.borderColor = 'rgba(0, 150, 255, 0.8)';
        }

        boxes.push(boxDiv);
    }

    return boxes;
}
