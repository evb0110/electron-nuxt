import type { Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import type { IPoint } from './viewer-dom';

export interface IMarkerInfo {
    key: string;
    cx: number;
    cy: number;
}

export async function getMarkers(page: Page): Promise<IMarkerInfo[]> {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        if (!host) {
            return [];
        }
        return Array.from(host.querySelectorAll<HTMLElement>('.pdf-comment-marker-button')).map((marker) => {
            const rect = marker.getBoundingClientRect();
            return {
                key: marker.dataset.stableKey ?? '',
                cx: Math.round(rect.x + rect.width / 2),
                cy: Math.round(rect.y + rect.height / 2),
            };
        });
    });
}

export async function getConnectorPaths(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        if (!host) {
            return [];
        }
        return Array.from(host.querySelectorAll<SVGPathElement>('path'))
            .filter(pathEl => (pathEl.getAttribute('d') ?? '').match(/^M .+ L /))
            .map(pathEl => pathEl.getAttribute('d') ?? '');
    });
}

export function parsePathStart(pathData: string): IPoint | null {
    const match = pathData.match(/^M\s+([\d.]+)\s+([\d.]+)/);
    if (!match?.[1] || !match[2]) {
        return null;
    }
    return {
        x: parseFloat(match[1]),
        y: parseFloat(match[2]),
    };
}

export async function dragMarker(page: Page, stableKey: string, dx: number, dy: number) {
    const result = await page.evaluate(async (targetKey: string, deltaX: number, deltaY: number) => {
        const marker = document.querySelector<HTMLElement>(
            `.pdf-comment-marker-button[data-stable-key="${targetKey}"]`,
        );
        if (!marker) {
            return null;
        }

        const rect = marker.getBoundingClientRect();
        const startX = rect.x + rect.width / 2;
        const startY = rect.y + rect.height / 2;

        marker.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: startX,
            clientY: startY,
            button: 0,
            pointerId: 1,
            bubbles: true,
            composed: true,
        }));

        await new Promise(resolve => setTimeout(resolve, 50));

        const steps = 12;
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            marker.dispatchEvent(new PointerEvent('pointermove', {
                clientX: startX + deltaX * t,
                clientY: startY + deltaY * t,
                button: 0,
                pointerId: 1,
                bubbles: true,
                composed: true,
            }));
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        marker.dispatchEvent(new PointerEvent('pointerup', {
            clientX: startX + deltaX,
            clientY: startY + deltaY,
            button: 0,
            pointerId: 1,
            bubbles: true,
            composed: true,
        }));

        return {
            startX: Math.round(startX),
            startY: Math.round(startY),
            endX: Math.round(startX + deltaX),
            endY: Math.round(startY + deltaY),
        } as const;
    }, stableKey, dx, dy);

    await delay(500);
    return result;
}

export async function getNoteWindowTextareaPoint(page: Page): Promise<IPoint | null> {
    return page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
            '.pdf-annotation-note-window textarea, [class*="note-window"] textarea',
        );
        if (!textarea) {
            return null;
        }
        textarea.focus();
        const rect = textarea.getBoundingClientRect();
        return {
            x: rect.x + 10,
            y: rect.y + 10,
        };
    });
}
