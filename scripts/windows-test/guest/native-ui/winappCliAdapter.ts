import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import type {
    IGuestClock,
    IGuestCommandResult,
    IGuestCommandRunner,
} from '@scripts/windows-test/guest/guestRuntime';
import {
    createNativeUiActionLog,
    DesktopUnavailableError,
    selectorNameCandidates,
    waitForUniqueControl,
    type INativeUiActionLog,
    type INativeUiAdapter,
    type IUiElementRef,
    type IUiSelector,
    type IUiWindowQuery,
} from '@scripts/windows-test/guest/native-ui/nativeUiAdapter';

// Pinned by the M0b selection gate: the command schema below must be
// re-verified against this exact release before the adapter is trusted.
export const WINAPP_EXPECTED_VERSION = '0.6.0';

export const WINAPP_DEFAULT_EXECUTABLE = 'winapp.exe';

export const winappCommands = {
    version: ['--version'],
    findWindow: [
        'uia',
        'find-window',
    ],
    findElements: [
        'uia',
        'find-elements',
    ],
    invoke: [
        'uia',
        'invoke',
    ],
    setValue: [
        'uia',
        'set-value',
    ],
    select: [
        'uia',
        'select',
    ],
    sendKeys: [
        'uia',
        'send-keys',
    ],
    dumpTree: [
        'uia',
        'dump-tree',
    ],
    screenshot: [
        'uia',
        'screenshot',
    ],
} as const;

export interface IWinappElementPayload {
    runtimeId: string;
    controlType: string;
    name: string;
    automationId?: string | null;
    processId?: number | null;
}

export function isWinappElementPayload(value: unknown): value is IWinappElementPayload {
    return isRecord(value)
        && typeof value.runtimeId === 'string'
        && value.runtimeId.length > 0
        && typeof value.controlType === 'string'
        && typeof value.name === 'string'
        && (value.automationId === undefined || value.automationId === null || typeof value.automationId === 'string')
        && (value.processId === undefined || value.processId === null || isFiniteNumber(value.processId));
}

export function toUiElementRef(payload: IWinappElementPayload): IUiElementRef {
    return {
        handle: payload.runtimeId,
        controlType: payload.controlType,
        name: payload.name,
        automationId: payload.automationId ?? null,
        processId: payload.processId ?? null,
    };
}

export function parseWinappElements(stdout: string): IUiElementRef[] {
    const trimmed = stdout.trim();
    if (trimmed.length === 0) {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error(`winapp CLI returned output that is not JSON: ${trimmed.slice(0, 200)}`);
    }
    const candidates: unknown = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) ? parsed.elements ?? [parsed] : null;
    if (!Array.isArray(candidates)) {
        throw new Error('winapp CLI JSON did not contain an element list');
    }
    return candidates.map((candidate) => {
        if (!isWinappElementPayload(candidate)) {
            throw new Error(`winapp CLI returned an unrecognized element payload: ${JSON.stringify(candidate)}`);
        }
        return toUiElementRef(candidate);
    });
}

export function parseWinappVersion(stdout: string) {
    const match = /(?:^|[\s:v])(\d+\.\d+\.\d+)(?=$|[\s.,;)])/mu.exec(stdout);
    if (match?.[1] === undefined) {
        throw new Error(`winapp CLI did not report a version: ${stdout.trim().slice(0, 120)}`);
    }
    return match[1];
}

const desktopUnavailableHints = [
    'interactive desktop',
    'input desktop',
    'winsta0',
    'session 0',
    'desktop is locked',
] as const;

export function isDesktopUnavailableMessage(text: string) {
    const normalized = text.toLowerCase();
    return desktopUnavailableHints.some(hint => normalized.includes(hint));
}

function assertCommandSucceeded(result: IGuestCommandResult, description: string) {
    if (result.exitCode === 0) {
        return result;
    }
    const message = `${result.stderr}\n${result.stdout}`;
    if (isDesktopUnavailableMessage(message)) {
        throw new DesktopUnavailableError(`${description} reported ${message.trim().slice(0, 200)}`);
    }
    throw new Error(`winapp CLI ${description} failed with exit ${result.exitCode}: ${message.trim().slice(0, 300)}`);
}

function matchesSelectorName(element: IUiElementRef, selector: IUiSelector) {
    const names = selectorNameCandidates(selector);
    return names.length === 0 || names.includes(element.name);
}

export interface ICreateWinappCliAdapterOptions {
    exec: IGuestCommandRunner;
    clock: IGuestClock;
    executable?: string;
    actionLog?: INativeUiActionLog;
    commandTimeoutMs?: number;
}

export function createWinappCliAdapter({
    exec,
    clock,
    executable = WINAPP_DEFAULT_EXECUTABLE,
    actionLog = createNativeUiActionLog(),
    commandTimeoutMs = 60_000,
}: ICreateWinappCliAdapterOptions): INativeUiAdapter {
    const run = async (args: readonly string[], description: string) => assertCommandSucceeded(
        await exec.run(executable, args, { timeoutMs: commandTimeoutMs }),
        description,
    );

    const selectorArgs = (selector: IUiSelector) => {
        const args = [
            '--json',
            '--control-type',
            selector.controlType,
        ];
        if (selector.automationId !== undefined) {
            args.push('--automation-id', selector.automationId);
        }
        if (selector.processId !== undefined) {
            args.push('--process-id', String(selector.processId));
        }
        return args;
    };

    const findControl = async (windowRef: IUiElementRef, selector: IUiSelector) => {
        const result = await run([
            ...winappCommands.findElements,
            '--window',
            windowRef.handle,
            ...selectorArgs(selector),
        ], 'find-elements');
        return parseWinappElements(result.stdout).filter(element => matchesSelectorName(element, selector));
    };

    const desktopRef: IUiElementRef = {
        handle: 'desktop',
        controlType: 'Pane',
        name: 'Desktop',
        automationId: null,
        processId: null,
    };

    const adapter: INativeUiAdapter = {
        driver: 'winapp',
        actionLog,
        findWindow: async (query: IUiWindowQuery) => {
            const args = [
                ...winappCommands.findWindow,
                '--json',
            ];
            if (query.titleContains !== undefined) {
                args.push('--title-contains', query.titleContains);
            }
            if (query.className !== undefined) {
                args.push('--class-name', query.className);
            }
            if (query.automationId !== undefined) {
                args.push('--automation-id', query.automationId);
            }
            if (query.processId !== undefined) {
                args.push('--process-id', String(query.processId));
            }
            const elements = parseWinappElements((await run(args, 'find-window')).stdout);
            return elements[0] ?? null;
        },
        findControl,
        invoke: async (ref) => {
            await run([
                ...winappCommands.invoke,
                '--json',
                '--element',
                ref.handle,
            ], 'invoke');
            actionLog.record({
                actionKind: 'pattern',
                action: 'invoke',
                target: ref.handle,
            });
        },
        setValue: async (ref, text) => {
            await run([
                ...winappCommands.setValue,
                '--json',
                '--element',
                ref.handle,
                '--value',
                text,
            ], 'set-value');
            actionLog.record({
                actionKind: 'pattern',
                action: 'set-value',
                target: ref.handle,
            });
        },
        select: async (ref, item) => {
            await run([
                ...winappCommands.select,
                '--json',
                '--element',
                ref.handle,
                '--item',
                item,
            ], 'select');
            actionLog.record({
                actionKind: 'pattern',
                action: 'select',
                target: ref.handle,
            });
        },
        sendKeys: async (windowRef, keys) => {
            await run([
                ...winappCommands.sendKeys,
                '--json',
                '--window',
                windowRef.handle,
                '--keys',
                keys,
            ], 'send-keys');
            actionLog.record({
                actionKind: 'input',
                action: 'send-keys',
                target: windowRef.handle,
            });
        },
        waitFor: (selector, timeoutMs) => waitForUniqueControl({
            adapter,
            windowRef: desktopRef,
            selector,
            timeoutMs,
            sleep: clock.sleep,
            now: clock.now,
        }),
        captureTree: async (windowRef) => {
            const result = await run([
                ...winappCommands.dumpTree,
                '--json',
                '--window',
                windowRef.handle,
            ], 'dump-tree');
            const parsed: unknown = JSON.parse(result.stdout);
            return parsed;
        },
        screenshot: async (filePath) => {
            await run([
                ...winappCommands.screenshot,
                '--json',
                '--output',
                filePath,
            ], 'screenshot');
            actionLog.record({
                actionKind: 'pattern',
                action: 'screenshot',
                target: filePath,
            });
        },
    };
    return adapter;
}

export async function readWinappCliVersion(exec: IGuestCommandRunner, executable = WINAPP_DEFAULT_EXECUTABLE) {
    const result = await exec.run(executable, winappCommands.version, { timeoutMs: 30_000 });
    assertCommandSucceeded(result, '--version');
    return parseWinappVersion(result.stdout);
}

export async function assertPinnedWinappCliVersion(exec: IGuestCommandRunner, executable = WINAPP_DEFAULT_EXECUTABLE) {
    const version = await readWinappCliVersion(exec, executable);
    if (version !== WINAPP_EXPECTED_VERSION) {
        throw new Error(`winapp CLI ${version} is installed; the lane pins ${WINAPP_EXPECTED_VERSION}`);
    }
    return version;
}
