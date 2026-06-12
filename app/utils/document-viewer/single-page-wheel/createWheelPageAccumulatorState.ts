import type { IWheelPageAccumulatorState } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';

export function createWheelPageAccumulatorState(): IWheelPageAccumulatorState {
    return {
        delta: 0,
        direction: 0,
        lastEventTimeMs: 0,
    };
}
