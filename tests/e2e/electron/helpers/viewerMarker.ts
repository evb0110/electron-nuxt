import type { Page } from 'puppeteer-core';
import type { IPoint } from '@tests/e2e/electron/helpers/viewerDom';
import { waitForActiveWorkspaceHost } from '@tests/e2e/electron/helpers/viewerDom';

export interface IMarkerInfo {
    key: string;
    cx: number;
    cy: number;
}

export async function getMarkers(page: Page): Promise<IMarkerInfo[]> {
    await waitForActiveWorkspaceHost(page);

    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
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
    await waitForActiveWorkspaceHost(page);

    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
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
    await waitForActiveWorkspaceHost(page);

    const startPoint = await page.evaluate((targetKey: string) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        const marker = host?.querySelector<HTMLElement>(
            `.pdf-comment-marker-button[data-stable-key="${targetKey}"]`,
        );
        if (!marker) {
            return null;
        }

        const rect = marker.getBoundingClientRect();
        return {
            startX: Math.round(rect.x + rect.width / 2),
            startY: Math.round(rect.y + rect.height / 2),
        };
    }, stableKey);

    if (!startPoint) {
        return null;
    }

    const intendedEndPoint = {
        endX: Math.round(startPoint.startX + dx),
        endY: Math.round(startPoint.startY + dy),
    };
    const minMovementDistance = Math.max(
        8,
        Math.min(24, Math.round(Math.hypot(dx, dy) * 0.2)),
    );

    await page.mouse.move(startPoint.startX, startPoint.startY);
    await page.mouse.down();
    await page.mouse.move(intendedEndPoint.endX, intendedEndPoint.endY, { steps: 14 });
    await page.mouse.up();

    await page.waitForFunction(({
        minDistance,
        startX,
        startY,
        targetKey,
    }) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        const marker = host?.querySelector<HTMLElement>(
            `.pdf-comment-marker-button[data-stable-key="${targetKey}"]`,
        );
        if (!marker) {
            return false;
        }

        const rect = marker.getBoundingClientRect();
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;
        return Math.hypot(centerX - startX, centerY - startY) >= minDistance;
    }, {timeout: 6_000}, {
        minDistance: minMovementDistance,
        startX: startPoint.startX,
        startY: startPoint.startY,
        targetKey: stableKey,
    });

    const finalPoint = await page.evaluate((targetKey: string) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        const marker = host?.querySelector<HTMLElement>(
            `.pdf-comment-marker-button[data-stable-key="${targetKey}"]`,
        );
        if (!marker) {
            return null;
        }

        const rect = marker.getBoundingClientRect();
        return {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
        };
    }, stableKey);

    return {
        startX: startPoint.startX,
        startY: startPoint.startY,
        endX: finalPoint?.x ?? intendedEndPoint.endX,
        endY: finalPoint?.y ?? intendedEndPoint.endY,
    } as const;
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
