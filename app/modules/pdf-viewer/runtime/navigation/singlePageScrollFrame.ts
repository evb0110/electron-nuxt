import { delay } from 'es-toolkit/promise';

export function scheduleSinglePageScrollFrame(callback: () => void) {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        setTimeout(callback, 0);
        return;
    }
    window.requestAnimationFrame(callback);
}

export function waitForContinuousRenderFrame() {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
        return delay(0);
    }
    return new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
    });
}
