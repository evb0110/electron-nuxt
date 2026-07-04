import type { Page } from 'puppeteer-core';
import type {
    IEvbAutomationEvent,
    TEvbAutomationEventType,
} from '@app/types/evbAutomationEvents';
import type { IEvbTestApi } from '@app/types/evbTestApi';
import type {
    IWorkspaceExpose,
    IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';

export type { IWorkspaceExpose };

export interface IFindWorkspaceExposeOptions {
    includeAllElements?: boolean;
    minVisibleSize?: number;
    preferActiveHost?: boolean;
    requiredMethods?: string[];
    requiredProperties?: string[];
    requireVisible?: boolean;
}

export interface IWorkspaceToolbarSnapshotRequirements {
    continuousScroll?: boolean;
    currentPage?: number;
    hasPdf?: boolean;
    minEffectiveZoom?: number;
    minTotalPages?: number;
}

export interface IWaitForWorkspaceToolbarSnapshotOptions extends IFindWorkspaceExposeOptions {timeoutMs?: number;}

export interface IWorkspaceCommandResult<TResult = unknown> {
    called: boolean;
    value: TResult | null;
}

export interface IWorkspaceExposeProbeWindow {
    __evbCollectWorkspaceExposeDebug?: (options?: IFindWorkspaceExposeOptions) => IWorkspaceExposeDebugState;
    __evbFindWorkspaceExpose?: (options?: IFindWorkspaceExposeOptions) => IWorkspaceExpose | Record<string, unknown> | null;
    __evbTestApi?: IEvbTestApi;
}

export interface IWorkspaceExposeDebugState {
    annotationStates: unknown[];
    componentCount: number;
    componentSamples: Array<{
        exposedKeys: string[];
        setupKeys: string[];
        tag: string;
    }>;
    matchingComponentSamples: Array<{
        exposedKeys: string[];
        setupKeys: string[];
        tag: string;
    }>;
    toolbarSnapshots: unknown[];
}

function collectRequiredMethods(
    options: IFindWorkspaceExposeOptions | undefined,
    requiredMethod: string,
) {
    return Array.from(new Set([
        requiredMethod,
        ...(options?.requiredMethods ?? []),
    ]));
}

export async function installWorkspaceExposeProbe(page: Page) {
    await page.evaluate(() => {
        const probeWindow = window as IWorkspaceExposeProbeWindow;
        if (probeWindow.__evbFindWorkspaceExpose && probeWindow.__evbCollectWorkspaceExposeDebug) {
            return;
        }

        const hasRequiredShape = (value: unknown, options: IFindWorkspaceExposeOptions) => {
            if (!value || typeof value !== 'object') {
                return false;
            }
            const record = value as Record<string, unknown>;
            return (options.requiredMethods ?? []).every(methodName => typeof record[methodName] === 'function')
                && (options.requiredProperties ?? []).every(propertyName => propertyName in record);
        };

        const collectStableSurfaces = (options: IFindWorkspaceExposeOptions) => {
            const api = probeWindow.__evbTestApi;
            if (!api) {
                return [];
            }

            const surfaces: unknown[] = [];
            const activeWorkspace = api.getActiveWorkspaceHandle();
            if (activeWorkspace) {
                surfaces.push(activeWorkspace);
            }

            const requestedProperties = options.requiredProperties ?? [];
            if (requestedProperties.length > 0) {
                surfaces.push(api.readActiveWorkspaceStateValues(requestedProperties));
            }

            surfaces.push(api.collectWorkspaceDebugState().activeWorkspaceState);
            return surfaces;
        };

        probeWindow.__evbFindWorkspaceExpose = (options: IFindWorkspaceExposeOptions = {}) => {
            const candidate = collectStableSurfaces(options)
                .find(surface => hasRequiredShape(surface, options));
            return candidate as IWorkspaceExpose | Record<string, unknown> | null ?? null;
        };

        probeWindow.__evbCollectWorkspaceExposeDebug = (options: IFindWorkspaceExposeOptions = {}) => {
            const debug = probeWindow.__evbTestApi?.collectWorkspaceDebugState();
            if (!debug) {
                return {
                    annotationStates: [],
                    componentCount: 0,
                    componentSamples: [],
                    matchingComponentSamples: [],
                    toolbarSnapshots: [],
                };
            }

            const annotationComments = debug.activeWorkspaceState.annotationComments;
            const annotationStates = [{
                annotationCommentsCount: Array.isArray(annotationComments)
                    ? annotationComments.length
                    : null,
                annotationEditorState: null,
            }];
            const componentSamples = debug.workspaces.slice(0, 8).map(workspace => ({
                exposedKeys: workspace.exposedKeys.slice(0, 12),
                setupKeys: workspace.automationStateKeys.slice(0, 12),
                tag: 'workspace-api',
            }));
            const activeMatch = probeWindow.__evbFindWorkspaceExpose?.(options);
            const matchingComponentSamples = activeMatch
                ? componentSamples.slice(0, 1)
                : [];

            return {
                annotationStates,
                componentCount: debug.workspaceCount,
                componentSamples,
                matchingComponentSamples,
                toolbarSnapshots: debug.workspaces
                    .map(workspace => workspace.toolbarSnapshot)
                    .filter(Boolean),
            };
        };
    });
}

export async function getWorkspaceToolbarSnapshot(
    page: Page,
    options: IFindWorkspaceExposeOptions = {},
) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((searchOptions: IFindWorkspaceExposeOptions): IWorkspaceToolbarSnapshot | null => {
        const apiSnapshot = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getActiveToolbarSnapshot() ?? null;
        if (apiSnapshot) {
            return apiSnapshot;
        }

        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.(searchOptions);
        return typeof workspace?.getToolbarSnapshot === 'function'
            ? workspace.getToolbarSnapshot()
            : null;
    }, {
        ...options,
        requiredMethods: collectRequiredMethods(options, 'getToolbarSnapshot'),
    });
}

export async function waitForWorkspaceToolbarSnapshot(
    page: Page,
    requirements: IWorkspaceToolbarSnapshotRequirements = {},
    options: IWaitForWorkspaceToolbarSnapshotOptions = {},
) {
    const {
        timeoutMs = 30_000,
        ...searchOptions
    } = options;

    await installWorkspaceExposeProbe(page);
    await page.waitForFunction((payload: {
        requirements: IWorkspaceToolbarSnapshotRequirements;
        searchOptions: IFindWorkspaceExposeOptions;
    }) => {
        const snapshot = (window as IWorkspaceExposeProbeWindow)
            .__evbTestApi
            ?.getActiveToolbarSnapshot()
            ?? (
                (window as IWorkspaceExposeProbeWindow)
                    .__evbFindWorkspaceExpose?.(payload.searchOptions) as IWorkspaceExpose | null | undefined
            )?.getToolbarSnapshot?.();
        if (!snapshot) {
            return false;
        }

        return (
            (typeof payload.requirements.hasPdf !== 'boolean' || snapshot.hasPdf === payload.requirements.hasPdf)
            && (typeof payload.requirements.currentPage !== 'number' || snapshot.currentPage === payload.requirements.currentPage)
            && (typeof payload.requirements.continuousScroll !== 'boolean' || snapshot.continuousScroll === payload.requirements.continuousScroll)
            && (typeof payload.requirements.minTotalPages !== 'number' || (snapshot.totalPages ?? 0) >= payload.requirements.minTotalPages)
            && (typeof payload.requirements.minEffectiveZoom !== 'number' || (snapshot.effectiveZoom ?? 0) >= payload.requirements.minEffectiveZoom)
        );
    }, { timeout: timeoutMs }, {
        requirements,
        searchOptions: {
            ...searchOptions,
            requiredMethods: collectRequiredMethods(searchOptions, 'getToolbarSnapshot'),
        },
    });
}

export async function waitForWorkspaceToolbarIdle(
    page: Page,
    options: IWaitForWorkspaceToolbarSnapshotOptions = {},
) {
    const {
        timeoutMs = 30_000,
        ...searchOptions
    } = options;

    await installWorkspaceExposeProbe(page);
    await page.waitForFunction((payload: IFindWorkspaceExposeOptions) => {
        const snapshot = (window as IWorkspaceExposeProbeWindow)
            .__evbTestApi
            ?.getActiveToolbarSnapshot()
            ?? (
                (window as IWorkspaceExposeProbeWindow)
                    .__evbFindWorkspaceExpose?.(payload) as IWorkspaceExpose | null | undefined
            )?.getToolbarSnapshot?.();
        return snapshot
            ? !snapshot.isAnySaving && !snapshot.isSaving && !snapshot.isSavingAs
            : false;
    }, { timeout: timeoutMs }, {
        ...searchOptions,
        requiredMethods: collectRequiredMethods(searchOptions, 'getToolbarSnapshot'),
    });
}

export async function waitForAutomationEvent(
    page: Page,
    type: TEvbAutomationEventType,
    options: {
        afterEventId?: number;
        path?: string;
        timeoutMs?: number;
    } = {},
): Promise<IEvbAutomationEvent | null> {
    const afterEventId = options.afterEventId ?? 0;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const normalizedPath = options.path?.replace(/\\/gu, '/').toLowerCase() ?? null;

    await installWorkspaceExposeProbe(page);
    return page.evaluate(async (payload: {
        afterEventId: number;
        normalizedPath: string | null;
        timeoutMs: number;
        type: TEvbAutomationEventType;
    }) => {
        const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
        if (!api?.waitForAutomationEvent) {
            return null;
        }

        return api.waitForAutomationEvent(
            payload.type,
            (event) => {
                if (event.id <= payload.afterEventId) {
                    return false;
                }
                if (!payload.normalizedPath) {
                    return true;
                }
                const path = typeof event.detail.path === 'string'
                    ? event.detail.path.replace(/\\/gu, '/').toLowerCase()
                    : '';
                return path === payload.normalizedPath;
            },
            payload.timeoutMs,
        );
    }, {
        afterEventId,
        normalizedPath,
        timeoutMs,
        type,
    });
}

export async function getLatestAutomationEventId(page: Page) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate(() => {
        const events = (window as IWorkspaceExposeProbeWindow).__evbTestApi?.getAutomationEvents?.() ?? [];
        return events.at(-1)?.id ?? 0;
    });
}

export async function callWorkspaceCommand<TResult = unknown>(
    page: Page,
    commandName: string,
    args: unknown[] = [],
    options: IFindWorkspaceExposeOptions = {},
): Promise<IWorkspaceCommandResult<TResult>> {
    await installWorkspaceExposeProbe(page);
    return page.evaluate(async (payload: {
        args: unknown[];
        commandName: string;
        searchOptions: IFindWorkspaceExposeOptions;
    }): Promise<IWorkspaceCommandResult<TResult>> => {
        const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
        if (api) {
            return api.callActiveWorkspaceCommand<TResult>(payload.commandName, payload.args);
        }

        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.(payload.searchOptions) as Record<string, unknown> | null | undefined;
        const command = workspace?.[payload.commandName];
        if (typeof command !== 'function') {
            return {
                called: false,
                value: null,
            };
        }

        const value = await Promise.resolve((command as (...values: unknown[]) => unknown)(...payload.args));
        return {
            called: true,
            value: (value ?? null) as TResult | null,
        };
    }, {
        args,
        commandName,
        searchOptions: {
            ...options,
            requiredMethods: collectRequiredMethods(options, commandName),
        },
    });
}

export async function readWorkspaceStateValues<TValues extends Record<string, unknown> = Record<string, unknown>>(
    page: Page,
    propertyNames: string[],
    options: IFindWorkspaceExposeOptions = {},
) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((payload: {
        propertyNames: string[];
        searchOptions: IFindWorkspaceExposeOptions;
    }) => {
        const api = (window as IWorkspaceExposeProbeWindow).__evbTestApi;
        if (api) {
            return api.readActiveWorkspaceStateValues<TValues>(payload.propertyNames);
        }

        const workspace = (window as IWorkspaceExposeProbeWindow).__evbFindWorkspaceExpose?.(payload.searchOptions) as Record<string, unknown> | null | undefined;
        const values: Record<string, unknown> = {};
        for (const propertyName of payload.propertyNames) {
            values[propertyName] = workspace?.[propertyName];
        }
        return values as TValues;
    }, {
        propertyNames,
        searchOptions: {
            ...options,
            requiredProperties: options.requiredProperties ?? propertyNames,
        },
    });
}

export async function collectWorkspaceExposeDebugState(
    page: Page,
    options: IFindWorkspaceExposeOptions = {},
) {
    await installWorkspaceExposeProbe(page);
    return page.evaluate((searchOptions: IFindWorkspaceExposeOptions) => (
        (window as IWorkspaceExposeProbeWindow).__evbCollectWorkspaceExposeDebug?.(searchOptions) ?? {
            annotationStates: [],
            componentCount: 0,
            componentSamples: [],
            matchingComponentSamples: [],
            toolbarSnapshots: [],
        }
    ), options);
}
