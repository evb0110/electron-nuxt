import type { IWheelPageAccumulatorState } from '@app/utils/pdf-viewer/single-page-wheel/singlePageWheelTypes';

export function createWheelPageAccumulatorState(): IWheelPageAccumulatorState {
    return {
        delta: 0,
        direction: 0,
        lastEventTimeMs: 0,
    };
}
