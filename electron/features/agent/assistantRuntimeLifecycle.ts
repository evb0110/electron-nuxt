import * as fsPromises from 'fs/promises';
import { join } from 'path';
import * as electron from 'electron';
import type {
    IAgentAssistantChatScope,
    TAgentAssistantEffort,
} from '@contracts/agent';
import { ASSISTANT_DEFAULT_EFFORT } from '@contracts/agentModels';
import {
    getCodexCliInfo,
    type ICodexCliInfo,
} from '@electron/features/agent/codexCli';
import {
    ASSISTANT_MCP_CONTRACT_VERSION,
    ASSISTANT_MCP_SERVER_NAME,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_MODEL_CONFIG_DIR,
    ASSISTANT_ROLE_PROMPT,
    createAssistantCodexConfig,
} from '@electron/features/agent/codexAssistantConfig';
import {
    CodexAppServerClient,
    type ICodexAppServerNotification,
} from '@electron/features/agent/codexAppServerClient';
import {
    normalizeCodexModelListResponse,
    type TCodexAssistantModelOption,
} from '@electron/features/agent/assistantModelCatalog';
import {
    codexDefaultModelId,
    normalizeAssistantEffort,
    normalizeAssistantModel,
    normalizeCodexAssistantModel,
    type IAssistantSelection,
} from '@electron/features/agent/assistantProviderStatus';
import type { IAssistantProviderRuntimeState } from '@electron/features/agent/assistantProviderState';
import {
    refreshCodexAuthState,
    refreshCodexAuthStateAndRuntimeAvailability,
    syncCodexRuntimeStateAfterAuthCheck,
} from '@electron/features/agent/assistantProviderAccounts';
import type {
    IAssistantChatSession,
    TAssistantChatSessionStore,
} from '@electron/features/agent/assistantChatSessionStore';
import { supersedeAssistantTurn } from '@electron/features/agent/assistantTurnLifecycle';
import {
    getEmbeddedMcpServerDescriptor,
    isEmbeddedMcpServerRunning,
    shutdownEmbeddedMcpServer,
    startEmbeddedMcpServer,
} from '@electron/features/agent/mcpServer';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@electron/utils/error';

interface IAssistantRuntime {
    client: CodexAppServerClient;
    codexPath: string;
    codeHome: string;
    cwd: string;
    mcpToken: string;
    mcpServerName: string;
    mcpContractVersion: number;
}

interface IAssistantRuntimeLifecycleLogger {
    info(message: string): void;
    warn(message: string): void;
}

interface IAssistantRuntimeLifecycleOptions {
    providerRuntime: IAssistantProviderRuntimeState;
    sessionStore: TAssistantChatSessionStore;
    getCodexModels: () => readonly TCodexAssistantModelOption[];
    setCodexModels: (models: readonly TCodexAssistantModelOption[]) => void;
    isAssistantFeatureEnabled: () => Promise<boolean>;
    createAssistantDisabledError: () => string;
    shutdownAssistant: () => Promise<void>;
    publishCodexState: (scope?: IAgentAssistantChatScope | null, selection?: IAssistantSelection) => void;
    handleNotification: (notification: ICodexAppServerNotification) => void;
    handleExit: (message: string) => void;
    logger: IAssistantRuntimeLifecycleLogger;
}

function getAssistantBaseDir() {
    return join(electron.app.getPath('userData'), ASSISTANT_MODEL_CONFIG_DIR);
}

function getAssistantCodexHome() {
    return join(getAssistantBaseDir(), 'codex-home');
}

function getAssistantCwd() {
    return join(getAssistantBaseDir(), 'cwd');
}

export async function ensureAssistantCwd() {
    const cwd = getAssistantCwd();
    await fsPromises.mkdir(cwd, { recursive: true });
    return cwd;
}

function ensureSharedEmbeddedMcp() {
    return startEmbeddedMcpServer();
}

async function writeAssistantConfig(codeHome: string, serverUrl: string, reasoningEffort: TAgentAssistantEffort) {
    await fsPromises.mkdir(codeHome, { recursive: true });
    await fsPromises.writeFile(join(codeHome, 'config.toml'), createAssistantCodexConfig(serverUrl, reasoningEffort), 'utf-8');
}

export function createBaseAssistantMcpStatus() {
    const descriptor = getEmbeddedMcpServerDescriptor();
    return {
        serverName: descriptor?.name ?? ASSISTANT_MCP_SERVER_NAME,
        serverUrl: descriptor?.url ?? '',
        serverRunning: isEmbeddedMcpServerRunning(),
        toolCount: 0,
    };
}

function decodeRecordResponse(value: unknown): Record<PropertyKey, unknown> | null {
    return isRecord(value) ? value : null;
}

export function createAssistantRuntimeLifecycle(options: IAssistantRuntimeLifecycleOptions) {
    let codexInfoCache: ICodexCliInfo | null = null;
    let runtime: IAssistantRuntime | null = null;
    let runtimeStartPromise: Promise<IAssistantRuntime> | null = null;
    let mcpToolCount = 0;

    function getRuntime() {
        return runtime;
    }

    function getCodexInfo() {
        return codexInfoCache;
    }

    function setCodexInfo(info: ICodexCliInfo | null) {
        codexInfoCache = info;
    }

    function getMcpToolCount() {
        return mcpToolCount;
    }

    function clearRuntimeForExit() {
        runtime = null;
    }

    async function shutdownCodexRuntime(shutdownOptions: { shutdownMcp?: boolean } = {}) {
        runtimeStartPromise = null;
        await runtime?.client.shutdown();
        runtime = null;
        options.providerRuntime.runtimeState = 'stopped';
        options.sessionStore.clearActiveSessionForProvider('codex');
        for (const session of options.sessionStore.listSessions()) {
            if (session.provider !== 'codex') {
                continue;
            }
            session.providerThreadId = null;
            session.turnOwner = supersedeAssistantTurn(session.turnOwner);
            session.scopeBinding = null;
            options.sessionStore.recordTurnBoundary(session);
        }
        mcpToolCount = 0;
        if (shutdownOptions.shutdownMcp === true) {
            await shutdownEmbeddedMcpServer();
        }
    }

    async function refreshCodexInfo() {
        codexInfoCache = await getCodexCliInfo();
        return codexInfoCache;
    }

    async function refreshAuthState() {
        await refreshCodexAuthState(
            options.providerRuntime,
            runtime?.client ?? null,
            {
                info: (message: string) => options.logger.info(message),
                warn: (message: string) => options.logger.warn(message),
            },
        );
    }

    async function refreshAuthStateAndRuntimeAvailability(refreshOptions: { recoverFromError?: boolean } = {}) {
        await refreshCodexAuthStateAndRuntimeAvailability({
            providerRuntime: options.providerRuntime,
            client: runtime?.client ?? null,
            hasRuntime: Boolean(runtime),
            ...(refreshOptions.recoverFromError === undefined ? {} : { recoverFromError: refreshOptions.recoverFromError }),
            info: (message: string) => options.logger.info(message),
            warn: (message: string) => options.logger.warn(message),
        });
    }

    async function ensureRuntime() {
        if (!(await options.isAssistantFeatureEnabled())) {
            await options.shutdownAssistant();
            throw new Error(options.createAssistantDisabledError());
        }

        if (runtimeStartPromise) {
            return runtimeStartPromise;
        }

        if (runtime) {
            if (
                runtime.mcpServerName === ASSISTANT_MCP_SERVER_NAME
                && runtime.mcpContractVersion === ASSISTANT_MCP_CONTRACT_VERSION
            ) {
                return runtime;
            }
            options.logger.info('Restarting Codex assistant runtime for updated embedded MCP contract.');
            await shutdownCodexRuntime();
        }

        if (runtime) {
            return runtime;
        }

        const startPromise = startRuntime().finally(() => {
            if (runtimeStartPromise === startPromise) {
                runtimeStartPromise = null;
            }
        });
        runtimeStartPromise = startPromise;
        return startPromise;
    }

    async function startRuntime() {
        options.providerRuntime.runtimeState = 'starting';
        delete options.providerRuntime.lastError;
        options.publishCodexState();

        const codexInfo = await refreshCodexInfo();
        if (!codexInfo.installed || !codexInfo.path) {
            options.providerRuntime.runtimeState = 'stopped';
            options.providerRuntime.authState = 'unknown';
            options.publishCodexState();
            throw new Error('Codex is not installed.');
        }
        if (!codexInfo.isVersionSupported) {
            options.providerRuntime.runtimeState = 'error';
            options.providerRuntime.lastError = `Codex ${codexInfo.version ?? ''} is too old. EVB Assistant requires Codex ${codexInfo.minimumVersion} or newer.`;
            options.publishCodexState();
            throw new Error(options.providerRuntime.lastError);
        }

        const codeHome = getAssistantCodexHome();
        const cwd = await ensureAssistantCwd();
        const selection = options.sessionStore.getRememberedSelection();
        const codexModels = options.getCodexModels();
        const codexModel = selection.provider === 'codex'
            ? selection.model
            : codexDefaultModelId(codexModels);
        const codexEffort = normalizeAssistantEffort(
            codexModels,
            'codex',
            codexModel,
            selection.provider === 'codex' ? selection.effort : ASSISTANT_DEFAULT_EFFORT,
        );
        const {
            descriptor,
            token: mcpToken,
        } = await ensureSharedEmbeddedMcp();
        await writeAssistantConfig(codeHome, descriptor.url, codexEffort);

        const client = new CodexAppServerClient(
            codexInfo.path,
            {
                ...process.env,
                CODEX_HOME: codeHome,
                [ASSISTANT_MCP_TOKEN_ENV]: mcpToken,
                NO_COLOR: '1',
            },
            cwd,
            options.handleNotification,
            options.handleExit,
        );
        const nextRuntime = {
            client,
            codexPath: codexInfo.path,
            codeHome,
            cwd,
            mcpToken,
            mcpServerName: ASSISTANT_MCP_SERVER_NAME,
            mcpContractVersion: ASSISTANT_MCP_CONTRACT_VERSION,
        } satisfies IAssistantRuntime;
        runtime = nextRuntime;

        try {
            await client.initialize();
            await refreshAuthState();
            syncCodexRuntimeStateAfterAuthCheck(options.providerRuntime, { hasRuntime: true });
            await refreshCodexModelList();
            await refreshMcpToolCount();
            options.publishCodexState();
            return nextRuntime;
        } catch (error) {
            await client.shutdown();
            runtime = null;
            options.providerRuntime.runtimeState = 'error';
            options.providerRuntime.lastError = getErrorMessage(error);
            options.publishCodexState();
            throw error;
        }
    }

    async function refreshMcpToolCount() {
        if (!runtime) {
            return;
        }

        try {
            const response = await runtime.client.requestDecoded(
                'mcpServerStatus/list',
                {detail: 'toolsAndAuthOnly'},
                decodeRecordResponse,
            );
            if (!Array.isArray(response.data)) {
                return;
            }
            const servers: unknown[] = response.data;
            const server = servers.find(candidate => isRecord(candidate) && candidate.name === ASSISTANT_MCP_SERVER_NAME);
            if (!isRecord(server) || !isRecord(server.tools)) {
                return;
            }
            const descriptor = getEmbeddedMcpServerDescriptor();
            if (!descriptor) {
                return;
            }
            mcpToolCount = Object.keys(server.tools).length;
        } catch (error) {
            options.logger.warn(`Failed to read embedded MCP status: ${getErrorMessage(error)}`);
        }
    }

    async function refreshCodexModelList() {
        if (!runtime) {
            return;
        }

        try {
            const response = await runtime.client.requestDecoded(
                'model/list',
                { includeHidden: false },
                normalizeCodexModelListResponse,
            );
            if (response.length > 0) {
                options.setCodexModels(response);
                const selection = options.sessionStore.getRememberedSelection();
                options.sessionStore.updateRememberedSelection({ model: normalizeAssistantModel(response, selection.provider, selection.model) });
            }
        } catch (error) {
            options.logger.warn(`Failed to read Codex model list: ${getErrorMessage(error)}`);
        }
    }

    async function ensureThread(session: IAssistantChatSession) {
        const currentRuntime = await ensureRuntime();
        if (options.providerRuntime.authState !== 'signed-in') {
            throw new Error('Sign in with ChatGPT before using EVB Assistant.');
        }
        if (session.providerThreadId) {
            return session.providerThreadId;
        }

        const codexModel = normalizeCodexAssistantModel(options.getCodexModels(), session.model);
        const response = await currentRuntime.client.requestDecoded('thread/start', {
            ...(codexModel ? { model: codexModel } : {}),
            cwd: currentRuntime.cwd,
            approvalPolicy: 'never',
            sandbox: 'read-only',
            serviceName: 'EVB Assistant',
            developerInstructions: ASSISTANT_ROLE_PROMPT,
            personality: 'friendly',
            ephemeral: true,
            threadSource: 'user',
        }, decodeRecordResponse);
        if (!isRecord(response.thread) || typeof response.thread.id !== 'string') {
            throw new Error('Codex did not return an assistant thread.');
        }
        session.providerThreadId = response.thread.id;
        session.turnOwner = supersedeAssistantTurn(session.turnOwner);
        session.scopeBinding = null;
        options.sessionStore.setActiveSession(session);
        options.providerRuntime.runtimeState = 'ready';
        options.publishCodexState(session.scope, session);
        return session.providerThreadId;
    }

    return {
        clearRuntimeForExit,
        ensureRuntime,
        ensureThread,
        getCodexInfo,
        getMcpToolCount,
        getRuntime,
        refreshAuthState,
        refreshAuthStateAndRuntimeAvailability,
        refreshCodexInfo,
        setCodexInfo,
        shutdownCodexRuntime,
    };
}
