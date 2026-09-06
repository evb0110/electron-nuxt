import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { getViewportVisibilityFromDom } from '@app/modules/pdf-viewer/engine/pdf-scroll-visibility/getViewportVisibilityFromDom';

function createPageElement(options: {
    height: number;
    left: number;
    page: number;
    top: number;
    width: number;
}) {
    // This helper supplies only the layout fields read by the pure visibility
    // calculator. It is intentionally a structural HTMLElement shim.
    return Object.assign(Object.create(null), {
        classList: { contains: vi.fn(() => false) },
        dataset: { page: String(options.page) },
        offsetHeight: options.height,
        offsetLeft: options.left,
        offsetTop: options.top,
        offsetWidth: options.width,
    });
}

describe('getViewportVisibilityFromDom', () => {
    it('uses horizontal overlap when choosing the most visible page', () => {
        const pages = [
            createPageElement({
                height: 100,
                left: 0,
                page: 1,
                top: 0,
                width: 200,
            }),
            createPageElement({
                height: 100,
                left: 200,
                page: 2,
                top: 0,
                width: 200,
            }),
        ];
        const container = Object.assign(Object.create(null), {
            clientHeight: 100,
            clientWidth: 100,
            querySelectorAll: vi.fn(() => pages),
            scrollLeft: 160,
            scrollTop: 0,
        });

        expect(getViewportVisibilityFromDom(container, 2)).toEqual({
            range: {
                start: 1,
                end: 2,
            },
            mostVisiblePage: 2,
        });
    });
});
