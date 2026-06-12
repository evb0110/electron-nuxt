import type {
    IWheelPageAccumulatorState,
    TWheelDirection,
} from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';

const WHEEL_IDLE_RESET_MS = 140;
const MAX_PAGE_FLIPS_PER_EVENT = 3;
const WHEEL_DELTA_EPSILON = 0.01;

interface IAccumulateWheelForPageFlipsInput {
    state: IWheelPageAccumulatorState;
    delta: number;
    direction: TWheelDirection;
    eventTimeMs: number;
    stepDelta: number;
    maxSteps?: number;
}

export function accumulateWheelForPageFlips(
    input: IAccumulateWheelForPageFlipsInput,
) {
    const {
        delta,
        direction,
        eventTimeMs,
        stepDelta,
    } = input;

    let accumulatedDelta = input.state.delta;
    const isDirectionChanged =
        input.state.direction !== 0 && input.state.direction !== direction;
    const isStale =
        input.state.lastEventTimeMs > 0 &&
        eventTimeMs - input.state.lastEventTimeMs > WHEEL_IDLE_RESET_MS;

    if (isDirectionChanged || isStale) {
        accumulatedDelta = 0;
    }

    accumulatedDelta += delta;

    const safeStepDelta = Math.max(stepDelta, WHEEL_DELTA_EPSILON);
    const rawSteps = Math.floor(Math.abs(accumulatedDelta) / safeStepDelta);
    const stepsToFlip = Math.min(rawSteps, input.maxSteps ?? MAX_PAGE_FLIPS_PER_EVENT);
    const consumedDelta = direction * stepsToFlip * safeStepDelta;

    return {
        stepsToFlip,
        state: {
            delta: accumulatedDelta - consumedDelta,
            direction,
            lastEventTimeMs: eventTimeMs,
        },
    };
}
