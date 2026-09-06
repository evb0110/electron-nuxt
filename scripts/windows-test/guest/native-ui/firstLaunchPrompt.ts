import type { IGuestClock } from '@scripts/windows-test/guest/guestRuntime';
import {
    waitForUniqueControl,
    type INativeUiAdapter,
    type IUiElementRef,
    type IUiSelector,
    type IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';

export const DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT = {
    title: 'Default Viewer',
    className: '#32770',
    buttonName: 'Not Now',
    buttonAutomationId: 'CommandLink_102',
    timeoutMs: 4_000,
    pollIntervalMs: 100,
} as const;

export interface IFirstLaunchPromptOptions {
    adapter: INativeUiAdapter;
    processId: number;
    clock?: Pick<IGuestClock, 'now' | 'sleep'>;
    timeoutMs?: number;
    pollIntervalMs?: number;
}

export interface IWaitForOwnedWindowOptions {
    adapter: INativeUiAdapter;
    processId: number;
    query: IUiWindowQuery;
    clock?: Pick<IGuestClock, 'now' | 'sleep'>;
    timeoutMs: number;
    pollIntervalMs?: number;
}

const systemClock: Pick<IGuestClock, 'now' | 'sleep'> = {
    now: () => Date.now(),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};

function promptWindowQuery(processId: number): IUiWindowQuery {
    return {
        titleContains: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.title,
        className: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.className,
        processId,
    };
}

function promptButtonSelector(processId: number): IUiSelector {
    return {
        automationId: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonAutomationId,
        controlType: 'Button',
        name: {exact: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonName},
        processId,
    };
}

function assertOwnedPromptWindow(windowRef: IUiElementRef, processId: number) {
    if (windowRef.processId !== processId || windowRef.name !== DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.title) {
        throw new Error(
            `The first-launch prompt query returned an unexpected window: ${windowRef.controlType} `
            + `${JSON.stringify(windowRef.name)} for process ${windowRef.processId ?? 'unknown'}`,
        );
    }
}

function assertOwnedPromptButton(buttonRef: IUiElementRef, processId: number) {
    if (buttonRef.processId !== processId
        || buttonRef.controlType !== 'Button'
        || buttonRef.name !== DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonName
        || buttonRef.automationId !== DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonAutomationId) {
        throw new Error(
            `The first-launch prompt query returned an unexpected button: ${buttonRef.controlType} `
            + `${JSON.stringify(buttonRef.name)}#${buttonRef.automationId ?? '-'} `
            + `for process ${buttonRef.processId ?? 'unknown'}`,
        );
    }
}

export async function waitForOwnedWindow({
    adapter,
    processId,
    query,
    clock = systemClock,
    timeoutMs,
    pollIntervalMs = DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.pollIntervalMs,
}: IWaitForOwnedWindowOptions) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error(`Owned window timeout must be a non-negative finite number, received ${timeoutMs}`);
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
        throw new Error(`Owned window poll interval must be a positive finite number, received ${pollIntervalMs}`);
    }
    const deadline = clock.now() + timeoutMs;
    for (;;) {
        const windowRef = await adapter.findWindow({
            ...query,
            processId,
        });
        if (windowRef !== null) {
            if (windowRef.processId !== processId) {
                throw new Error(
                    `The owned window query returned process ${windowRef.processId ?? 'unknown'}; expected ${processId}`,
                );
            }
            return windowRef;
        }
        const remainingMs = deadline - clock.now();
        if (remainingMs <= 0) {
            throw new Error(
                `Owned window ${query.titleContains ?? query.className ?? 'requested'} did not appear within ${timeoutMs}ms`,
            );
        }
        await clock.sleep(Math.min(pollIntervalMs, remainingMs));
    }
}

async function findPromptWindow(adapter: INativeUiAdapter, processId: number) {
    const windowRef = await adapter.findWindow(promptWindowQuery(processId));
    if (windowRef !== null) {
        assertOwnedPromptWindow(windowRef, processId);
    }
    return windowRef;
}

async function waitForPromptWindow(
    adapter: INativeUiAdapter,
    processId: number,
    deadline: number,
    pollIntervalMs: number,
    clock: Pick<IGuestClock, 'now' | 'sleep'>,
) {
    for (;;) {
        const windowRef = await findPromptWindow(adapter, processId);
        if (windowRef !== null) {
            return windowRef;
        }
        const remainingMs = deadline - clock.now();
        if (remainingMs <= 0) {
            return null;
        }
        await clock.sleep(Math.min(pollIntervalMs, remainingMs));
    }
}

async function waitForPromptToClose(
    adapter: INativeUiAdapter,
    processId: number,
    deadline: number,
    pollIntervalMs: number,
    clock: Pick<IGuestClock, 'now' | 'sleep'>,
) {
    for (;;) {
        const windowRef = await findPromptWindow(adapter, processId);
        if (windowRef === null) {
            return;
        }
        const remainingMs = deadline - clock.now();
        if (remainingMs <= 0) {
            throw new Error('The Default Viewer first-launch prompt remained open after Not Now was invoked');
        }
        await clock.sleep(Math.min(pollIntervalMs, remainingMs));
    }
}

export async function dismissFirstLaunchPrompt({
    adapter,
    processId,
    clock = systemClock,
    timeoutMs = DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.timeoutMs,
    pollIntervalMs = DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.pollIntervalMs,
}: IFirstLaunchPromptOptions) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error(`First-launch prompt timeout must be a non-negative finite number, received ${timeoutMs}`);
    }
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
        throw new Error(`First-launch prompt poll interval must be a positive finite number, received ${pollIntervalMs}`);
    }
    const deadline = clock.now() + timeoutMs;
    const windowRef = await waitForPromptWindow(adapter, processId, deadline, pollIntervalMs, clock);
    if (windowRef === null) {
        return false;
    }

    const button = await waitForUniqueControl({
        adapter,
        windowRef,
        selector: promptButtonSelector(processId),
        timeoutMs: Math.max(0, deadline - clock.now()),
        pollIntervalMs,
        sleep: clock.sleep,
        now: clock.now,
    });
    assertOwnedPromptButton(button, processId);
    await adapter.invoke(button);
    await waitForPromptToClose(adapter, processId, clock.now() + timeoutMs, pollIntervalMs, clock);
    return true;
}
