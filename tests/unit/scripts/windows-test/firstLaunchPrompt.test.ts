import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    AmbiguousSelectorError,
    createNativeUiActionLog,
    type INativeUiAdapter,
    type IUiElementRef,
    type IUiSelector,
    type IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';
import {
    DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT,
    dismissFirstLaunchPrompt,
    waitForOwnedWindow,
} from '@scripts/windows-test/guest/native-ui/firstLaunchPrompt';

const ownedProcessId = 4_242;

function element(overrides: Partial<IUiElementRef> = {}): IUiElementRef {
    return {
        handle: 'dialog-1',
        controlType: 'Window',
        name: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.title,
        automationId: null,
        processId: ownedProcessId,
        ...overrides,
    };
}

function fakeClock() {
    let current = 0;
    return {
        now: () => current,
        sleep: async (milliseconds: number) => {
            current += milliseconds;
        },
    };
}

function fakeAdapter({
    windows = [element()],
    buttons = [element({
        handle: 'not-now',
        controlType: 'Button',
        name: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonName,
        automationId: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonAutomationId,
    })],
    closeOnInvoke = true,
    appearAfterQueries = 0,
}: {
    windows?: IUiElementRef[];
    buttons?: IUiElementRef[];
    closeOnInvoke?: boolean;
    appearAfterQueries?: number;
} = {}) {
    const actionLog = createNativeUiActionLog();
    const queries: IUiWindowQuery[] = [];
    const selectors: IUiSelector[] = [];
    const invoked: IUiElementRef[] = [];
    let visibleWindows = [...windows];
    let windowQueryCount = 0;
    const adapter: INativeUiAdapter = {
        driver: 'uia3',
        actionLog,
        findWindow: async query => {
            queries.push(query);
            windowQueryCount += 1;
            if (windowQueryCount <= appearAfterQueries) {
                return null;
            }
            return visibleWindows.find(candidate => candidate.processId === query.processId
                && candidate.name === query.titleContains
                && candidate.controlType === 'Window') ?? null;
        },
        findControl: async (_window, selector) => {
            selectors.push(selector);
            return buttons.filter(candidate => candidate.processId === selector.processId);
        },
        invoke: async ref => {
            invoked.push(ref);
            actionLog.record({
                actionKind: 'pattern',
                action: 'invoke',
                target: ref.handle,
            });
            if (closeOnInvoke) {
                visibleWindows = [];
            }
        },
        setValue: async () => undefined,
        select: async () => undefined,
        sendKeys: async () => undefined,
        waitFor: async () => {
            throw new Error('waitFor is not used by the first-launch prompt helper');
        },
        captureTree: async () => ({}),
        screenshot: async () => undefined,
    };
    return {
        adapter,
        actionLog,
        invoked,
        queries,
        selectors,
    };
}

describe('Default Viewer first-launch prompt', () => {
    it('waits for the owned application window within the startup bound', async () => {
        const clock = fakeClock();
        const fake = fakeAdapter({
            windows: [element({name: 'EVB Viewer'})],
            appearAfterQueries: 2,
        });

        await expect(waitForOwnedWindow({
            adapter: fake.adapter,
            processId: ownedProcessId,
            query: {
                titleContains: 'EVB Viewer',
                className: 'Chrome_WidgetWin_1',
            },
            clock,
            timeoutMs: 200,
            pollIntervalMs: 50,
        })).resolves.toMatchObject({
            name: 'EVB Viewer',
            processId: ownedProcessId,
        });
    });

    it('returns false when no owned prompt appears before the bounded wait', async () => {
        const clock = fakeClock();
        const fake = fakeAdapter({ windows: [] });

        await expect(dismissFirstLaunchPrompt({
            adapter: fake.adapter,
            processId: ownedProcessId,
            clock,
            timeoutMs: 200,
            pollIntervalMs: 50,
        })).resolves.toBe(false);

        expect(fake.invoked).toEqual([]);
        expect(fake.queries.at(-1)).toMatchObject({
            titleContains: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.title,
            className: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.className,
            processId: ownedProcessId,
        });
    });

    it('invokes the exact Not Now button and verifies the owned prompt closes', async () => {
        const fake = fakeAdapter();

        await expect(dismissFirstLaunchPrompt({
            adapter: fake.adapter,
            processId: ownedProcessId,
            clock: fakeClock(),
            timeoutMs: 200,
            pollIntervalMs: 50,
        })).resolves.toBe(true);

        expect(fake.invoked.map(ref => ref.handle)).toEqual(['not-now']);
        expect(fake.selectors).toContainEqual({
            automationId: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonAutomationId,
            controlType: 'Button',
            name: {exact: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonName},
            processId: ownedProcessId,
        });
        expect(fake.actionLog.entries()).toEqual([{
            actionKind: 'pattern',
            action: 'invoke',
            target: 'not-now',
        }]);
    });

    it('fails closed when the exact prompt button is ambiguous', async () => {
        const fake = fakeAdapter({buttons: [
            element({
                handle: 'not-now-1',
                controlType: 'Button',
                name: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonName,
                automationId: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonAutomationId,
            }),
            element({
                handle: 'not-now-2',
                controlType: 'Button',
                name: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonName,
                automationId: DEFAULT_VIEWER_FIRST_LAUNCH_PROMPT.buttonAutomationId,
            }),
        ]});

        await expect(dismissFirstLaunchPrompt({
            adapter: fake.adapter,
            processId: ownedProcessId,
            clock: fakeClock(),
            timeoutMs: 200,
            pollIntervalMs: 50,
        })).rejects.toBeInstanceOf(AmbiguousSelectorError);
        expect(fake.invoked).toEqual([]);
    });

    it('ignores a same-titled prompt owned by another process', async () => {
        const fake = fakeAdapter({
            windows: [element({processId: ownedProcessId + 1})],
            buttons: [element({processId: ownedProcessId + 1})],
        });

        await expect(dismissFirstLaunchPrompt({
            adapter: fake.adapter,
            processId: ownedProcessId,
            clock: fakeClock(),
            timeoutMs: 100,
            pollIntervalMs: 50,
        })).resolves.toBe(false);
        expect(fake.invoked).toEqual([]);
        expect(fake.queries.every(query => query.processId === ownedProcessId)).toBe(true);
    });

    it('fails if Not Now does not close the owned prompt', async () => {
        const fake = fakeAdapter({closeOnInvoke: false});

        await expect(dismissFirstLaunchPrompt({
            adapter: fake.adapter,
            processId: ownedProcessId,
            clock: fakeClock(),
            timeoutMs: 100,
            pollIntervalMs: 50,
        })).rejects.toThrow('remained open');
        expect(fake.invoked.map(ref => ref.handle)).toEqual(['not-now']);
    });

    it('handles a prompt that appears after the initial window poll', async () => {
        const fake = fakeAdapter({appearAfterQueries: 2});

        await expect(dismissFirstLaunchPrompt({
            adapter: fake.adapter,
            processId: ownedProcessId,
            clock: fakeClock(),
            timeoutMs: 200,
            pollIntervalMs: 50,
        })).resolves.toBe(true);

        expect(fake.invoked.map(ref => ref.handle)).toEqual(['not-now']);
    });
});
