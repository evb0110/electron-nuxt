import {
    createRafCoalescedCallback,
    type IRafCoalescedCallbackEnvironment,
} from '@app/utils/createRafCoalescedCallback';

function resolveThumbnailFrameEnvironment(): IRafCoalescedCallbackEnvironment {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        return window;
    }

    return {
        requestAnimationFrame: callback => Number(setTimeout(
            () => callback(Date.now()),
            16,
        )),
        cancelAnimationFrame: handle => clearTimeout(handle),
    };
}

export function createThumbnailRenderFrameScheduler(callback: () => void) {
    return createRafCoalescedCallback(
        callback,
        resolveThumbnailFrameEnvironment(),
    );
}
