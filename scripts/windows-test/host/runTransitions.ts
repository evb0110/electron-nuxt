import {
    appendFile,
    mkdir,
} from 'node:fs/promises';
import path from 'node:path';
import { windowsTestRunStates } from '@scripts/windows-test/contracts/windowsTestContracts';
import type {
    IWindowsTestTransition,
    TWindowsTestRunState,
} from '@scripts/windows-test/contracts/windowsTestContracts';
import type { IWindowsTestClock } from '@scripts/windows-test/host/hostClock';

export interface IWindowsTestTransitionRecorder {
    record(state: TWindowsTestRunState, reason: string): Promise<IWindowsTestTransition>;
    transitions(): IWindowsTestTransition[];
    currentState(): TWindowsTestRunState;
}

export class WindowsTestTransitionOrderError extends Error {
    constructor(from: TWindowsTestRunState, to: TWindowsTestRunState) {
        super(`Windows test run cannot move backwards from "${from}" to "${to}".`);
        this.name = 'WindowsTestTransitionOrderError';
    }
}

export function createTransitionRecorder(options: {
    transitionsFile: string;
    clock: IWindowsTestClock;
}): IWindowsTestTransitionRecorder {
    const startedAtMs = options.clock.monotonicMs();
    const recorded: IWindowsTestTransition[] = [];
    let current: TWindowsTestRunState = 'queued';

    return {
        record: async (state, reason) => {
            const nextIndex = windowsTestRunStates.indexOf(state);
            const currentIndex = windowsTestRunStates.indexOf(current);
            if (nextIndex < currentIndex) {
                throw new WindowsTestTransitionOrderError(current, state);
            }
            const transition: IWindowsTestTransition = {
                state,
                elapsedMs: options.clock.monotonicMs() - startedAtMs,
                reason,
            };
            current = state;
            recorded.push(transition);
            await mkdir(path.dirname(options.transitionsFile), {recursive: true});
            await appendFile(options.transitionsFile, `${JSON.stringify(transition)}\n`, 'utf8');
            return transition;
        },
        transitions: () => recorded.map(transition => ({...transition})),
        currentState: () => current,
    };
}
