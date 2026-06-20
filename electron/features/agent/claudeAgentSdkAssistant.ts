import {constants} from 'node:fs';
import {
    access,
    readFile,
} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import { promisify } from 'node:util';
import {app} from 'electron';
import {
    query,
    type AccountInfo,
    type CanUseTool,
    type Query,
    type SDKAssistantMessage,
    type SDKMessage,
    type SDKPartialAssistantMessage,
    type SDKResultMessage,
    type SDKSystemMessage,
    type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
    IAgentAssistantImageAttachment,
    TAgentAssistantEffort,
} from '@contracts/agent';
import { isRecord } from '@contracts/runtimeGuards';
import {
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CLAUDE_ASSISTANT_MODELS,
} from '@contracts/agentModels';
import {
    ASSISTANT_IMAGE_ONLY_PROMPT,
    ASSISTANT_MCP_TOOLS,
    ASSISTANT_MCP_TOKEN_ENV,
    ASSISTANT_ROLE_PROMPT,
} from '@electron/features/agent/codexAssistantConfig';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('agent-claude-assistant');
const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

type TClaudeImageMimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export const CLAUDE_AGENT_INSTALL_URL = 'https://code.claude.com/docs/en/agent-sdk/overview';
export const CLAUDE_AGENT_DEFAULT_MODEL = CLAUDE_ASSISTANT_DEFAULT_MODEL;
export const CLAUDE_AGENT_MODELS = CLAUDE_ASSISTANT_MODELS;
const CLAUDE_AGENT_MODEL_ALIASES = new Map<string, string>([
    [
        'claude-fable-5',
        'fable',
    ],
    [
        'claude-opus-4-8',
        'opus',
    ],
    [
        'claude-opus-4-7',
        'opus',
    ],
    [
        'claude-opus-4-6',
        'opus',
    ],
    [
        'claude-sonnet-4-6',
        'sonnet',
    ],
    [
        'claude-sonnet-4-5',
        'sonnet',
    ],
    [
        'claude-haiku-4-5',
        'haiku',
    ],
    [
        'claude-haiku-4-5-20251001',
        'haiku',
    ],
] as const);
const CLAUDE_AGENT_MODEL_IDS = new Set<string>(CLAUDE_AGENT_MODELS.map(model => model.id));

interface IClaudeAgentSdkPackageInfo {
    installed: boolean;
    version: string | null;
    executablePath: string | null;
    error?: string;
}

export interface IClaudeAgentAssistantInit {
    sessionId: string | null;
    model: string | null;
    toolCount: number;
    account: AccountInfo | null;
}

export interface IClaudeAgentAssistantCallbacks {
    onInitialized(info: IClaudeAgentAssistantInit): void;
    onTurnStarted(turnId: string): void;
    onAssistantDelta(messageId: string, delta: string): void;
    onAssistantMessage(messageId: string, text: string, pending: boolean): void;
    onTurnCompleted(turnId: string | null): void;
    onError(message: string): void;
}

export interface IClaudeAgentAssistantSessionOptions {
    cwd: string;
    model: string;
    effort: TAgentAssistantEffort;
    mcpServerName: string;
    mcpServerUrl: string;
    mcpToken: string;
    executablePath: string | null;
    callbacks: IClaudeAgentAssistantCallbacks;
}

class ClaudePromptQueue implements AsyncIterable<SDKUserMessage> {
    private readonly items: SDKUserMessage[] = [];
    private readonly resolvers: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
    private closed = false;

    push(message: SDKUserMessage) {
        if (this.closed) {
            throw new Error('Claude assistant session is closed.');
        }

        const resolver = this.resolvers.shift();
        if (resolver) {
            resolver({
                value: message,
                done: false,
            });
            return;
        }

        this.items.push(message);
    }

    close() {
        this.closed = true;
        for (const resolver of this.resolvers.splice(0)) {
            resolver({
                value: undefined as never,
                done: true,
            });
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {next: () => {
            const nextItem = this.items.shift();
            if (nextItem) {
                return Promise.resolve({
                    value: nextItem,
                    done: false,
                });
            }
            if (this.closed) {
                return Promise.resolve({
                    value: undefined as never,
                    done: true,
                });
            }
            return new Promise<IteratorResult<SDKUserMessage>>(resolve => this.resolvers.push(resolve));
        }};
    }
}

function executableSuffix() {
    return process.platform === 'win32' ? '.exe' : '';
}

async function pathIsExecutable(path: string | null | undefined) {
    if (!path) {
        return false;
    }

    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

async function findClaudeOnPath() {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('where.exe', ['claude'], { windowsHide: true });
            return stdout.split(/\r?\n/u).map(line => line.trim()).find(Boolean) ?? null;
        }

        const { stdout } = await execFileAsync('/bin/sh', [
            '-lc',
            'command -v claude',
        ], { windowsHide: true });
        return stdout.trim() || null;
    } catch {
        return null;
    }
}

function platformNativePackageNames() {
    if (process.platform === 'darwin') {
        return [`@anthropic-ai/claude-agent-sdk-darwin-${process.arch}`];
    }
    if (process.platform === 'win32') {
        return [`@anthropic-ai/claude-agent-sdk-win32-${process.arch}`];
    }
    if (process.platform === 'linux') {
        return [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
        ];
    }
    return [];
}

function resolveSdkPackageDir() {
    const sdkEntry = requireFromHere.resolve('@anthropic-ai/claude-agent-sdk');
    return dirname(sdkEntry);
}

async function readSdkVersion(sdkDir: string) {
    try {
        const rawPackage = await readFile(join(sdkDir, 'package.json'), 'utf-8');
        const parsed: unknown = JSON.parse(rawPackage);
        return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : null;
    } catch {
        return null;
    }
}

async function findBundledClaudeExecutable(sdkDir: string) {
    const sdkRequire = createRequire(join(sdkDir, 'sdk.mjs'));
    for (const packageName of platformNativePackageNames()) {
        try {
            const packageJsonPath = sdkRequire.resolve(`${packageName}/package.json`);
            const executablePath = join(dirname(packageJsonPath), `claude${executableSuffix()}`);
            if (await pathIsExecutable(executablePath)) {
                return executablePath;
            }
        } catch {
            // Optional native packages are platform-specific; try the next name.
        }
    }
    return null;
}

export async function getClaudeAgentSdkInfo(): Promise<IClaudeAgentSdkPackageInfo> {
    try {
        const sdkDir = resolveSdkPackageDir();
        const [
            version,
            envPath,
            pathExecutable,
            bundledExecutable,
        ] = await Promise.all([
            readSdkVersion(sdkDir),
            Promise.resolve(process.env.CLAUDE_CODE_PATH ?? process.env.CLAUDE_CLI_PATH ?? null),
            findClaudeOnPath(),
            findBundledClaudeExecutable(sdkDir),
        ]);
        const executablePath = await pathIsExecutable(envPath)
            ? envPath
            : await pathIsExecutable(pathExecutable)
                ? pathExecutable
                : bundledExecutable;
        return {
            installed: Boolean(executablePath),
            version,
            executablePath,
            ...(executablePath
                ? {}
                : { error: 'Claude Agent SDK native binary was not found. Install optional dependencies or set CLAUDE_CODE_PATH.' }),
        };
    } catch (error) {
        return {
            installed: false,
            version: null,
            executablePath: null,
            error: getErrorMessage(error),
        };
    }
}

export type TClaudeAuthState = 'signed-in' | 'signed-out' | 'unknown';

const CLAUDE_AUTH_ENV_VARS = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
] as const;

function trimmedEnv(name: string) {
    const value = process.env[name]?.trim();
    if (value) {
        return value;
    }
    return undefined;
}

function resolveClaudeConfigDir() {
    const override = trimmedEnv('CLAUDE_CONFIG_DIR');
    if (override) {
        return override;
    }

    const home = trimmedEnv('HOME')
        ?? (process.platform === 'win32' ? trimmedEnv('USERPROFILE') : undefined)
        ?? homedir();
    return join(home, '.claude');
}

function hasClaudeAuthEnv() {
    return CLAUDE_AUTH_ENV_VARS.some(name => trimmedEnv(name) !== undefined);
}

// Cheap env + credentials-file check used on the poll path. No subprocess, no keychain probe.
export async function detectClaudeAuthState(): Promise<TClaudeAuthState> {
    if (hasClaudeAuthEnv()) {
        return 'signed-in';
    }

    try {
        await access(join(resolveClaudeConfigDir(), '.credentials.json'), constants.R_OK);
        return 'signed-in';
    } catch {
        // Credentials file absent; fall through to platform-specific handling.
    }

    // On macOS the OAuth credentials usually live in the login keychain, which is too
    // expensive to probe per poll; treat as inconclusive so a live session can confirm.
    return process.platform === 'darwin' ? 'unknown' : 'signed-out';
}

// Only true authentication failures demote auth state. Billing/rate-limit (quota,
// credit balance) and permission (forbidden, 403) errors are deliberately excluded so
// a signed-in user is not bounced to the sign-in view by an unrelated failure.
const CLAUDE_AUTH_ERROR_MARKERS = [
    'invalid api key',
    'invalid x-api-key',
    'unauthorized',
    '(401)',
    'oauth token',
    'please run /login',
    'please log in',
    'not logged in',
    'no credentials',
    'login required',
    'authentication_error',
] as const;

export function isClaudeAuthErrorMessage(message: string) {
    const normalized = message.toLowerCase();
    return CLAUDE_AUTH_ERROR_MARKERS.some(marker => normalized.includes(marker));
}

export function getClaudeAssistantModelLabel(model: string) {
    return CLAUDE_AGENT_MODELS.find(option => option.id === model)?.label ?? model;
}

export function normalizeClaudeAssistantModel(model: string | null | undefined) {
    const trimmed = model?.trim();
    if (!trimmed) {
        return CLAUDE_AGENT_DEFAULT_MODEL;
    }

    const normalized = CLAUDE_AGENT_MODEL_ALIASES.get(trimmed) ?? trimmed;
    return CLAUDE_AGENT_MODEL_IDS.has(normalized)
        ? normalized
        : CLAUDE_AGENT_DEFAULT_MODEL;
}

function getClaudeSdkModel(model: string) {
    return normalizeClaudeAssistantModel(model);
}

function extractDataUrlBase64(dataUrl: string) {
    const commaIndex = dataUrl.indexOf(',');
    return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : '';
}

function normalizeClaudeImageMimeType(mimeType: string): TClaudeImageMimeType {
    const normalized = mimeType.toLowerCase();
    if (
        normalized === 'image/jpeg'
        || normalized === 'image/png'
        || normalized === 'image/gif'
        || normalized === 'image/webp'
    ) {
        return normalized;
    }

    throw new Error('Claude Assistant accepts PNG, JPEG, GIF, or WebP images.');
}

function buildClaudeUserMessage(
    text: string,
    attachments: IAgentAssistantImageAttachment[],
): SDKUserMessage {
    const content = [
        {
            type: 'text' as const,
            text: text || ASSISTANT_IMAGE_ONLY_PROMPT,
        },
        ...attachments.map(attachment => ({
            type: 'image' as const,
            source: {
                type: 'base64' as const,
                media_type: normalizeClaudeImageMimeType(attachment.mimeType),
                data: extractDataUrlBase64(attachment.dataUrl),
            },
        })),
    ];
    return {
        type: 'user',
        parent_tool_use_id: null,
        message: {
            role: 'user',
            content,
        },
    };
}

function extractAssistantText(message: SDKAssistantMessage) {
    const content = message.message.content;
    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .flatMap((block) => (
            isRecord(block) && block.type === 'text' && typeof block.text === 'string'
                ? [block.text]
                : []
        ))
        .join('\n\n');
}

function extractTextDelta(message: SDKPartialAssistantMessage) {
    const event = message.event;
    if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) {
        return '';
    }
    return event.delta.type === 'text_delta' && typeof event.delta.text === 'string'
        ? event.delta.text
        : '';
}

function getResultErrorsText(message: SDKResultMessage) {
    return 'errors' in message && Array.isArray(message.errors)
        ? message.errors.join(' ').toLowerCase()
        : '';
}

function isInterruptedResult(message: SDKResultMessage) {
    if (message.subtype === 'success') {
        return false;
    }

    const errors = getResultErrorsText(message);
    if (errors.includes('interrupt')) {
        return true;
    }

    return (
        message.subtype === 'error_during_execution'
        && message.is_error === false
        && (
            errors.includes('request was aborted')
            || errors.includes('interrupted by user')
            || errors.includes('aborted')
        )
    );
}

function isInterruptedErrorMessage(text: string) {
    const normalized = text.toLowerCase();
    return (
        normalized.includes('request was aborted')
        || normalized.includes('interrupted by user')
        || normalized.includes('aborted')
        || normalized.includes('aborterror')
    );
}

function getResultErrorMessage(message: SDKResultMessage) {
    if (message.subtype === 'success' && message.is_error === false) {
        return null;
    }

    if (isInterruptedResult(message)) {
        return null;
    }

    const result = 'result' in message && typeof message.result === 'string' ? message.result.trim() : '';
    if (result) {
        return result;
    }

    const apiErrorStatus = 'api_error_status' in message && message.api_error_status
        ? ` (${message.api_error_status})`
        : '';
    return `Claude assistant turn failed${apiErrorStatus}.`;
}

function normalizeClaudeAccount(account: AccountInfo | null): AccountInfo | null {
    if (!account) {
        return null;
    }

    return {
        ...(account.email ? { email: account.email } : {}),
        ...(account.organization ? { organization: account.organization } : {}),
        ...(account.subscriptionType ? { subscriptionType: account.subscriptionType } : {}),
        ...(account.tokenSource ? { tokenSource: account.tokenSource } : {}),
        ...(account.apiKeySource ? { apiKeySource: account.apiKeySource } : {}),
        ...(account.apiProvider ? { apiProvider: account.apiProvider } : {}),
    };
}

export class ClaudeAgentAssistantSession {
    private readonly promptQueue = new ClaudePromptQueue();
    private query: Query | null = null;
    private closing = false;
    private interrupting = false;
    private currentTurnId: string | null = null;
    private currentAssistantMessageId: string | null = null;
    private currentModel: string;
    private readonly currentEffort: TAgentAssistantEffort;
    private sessionId: string | null = null;
    private account: AccountInfo | null = null;

    constructor(private readonly options: IClaudeAgentAssistantSessionOptions) {
        this.currentModel = normalizeClaudeAssistantModel(options.model);
        this.currentEffort = options.effort;
    }

    get model() {
        return this.currentModel;
    }

    get effort() {
        return this.currentEffort;
    }

    get id() {
        return this.sessionId;
    }

    async sendMessage(
        text: string,
        attachments: IAgentAssistantImageAttachment[],
        model: string,
    ) {
        this.ensureStarted();
        await this.setModel(model);
        const turnId = randomUUID();
        this.currentTurnId = turnId;
        this.currentAssistantMessageId = randomUUID();
        this.options.callbacks.onTurnStarted(turnId);
        this.promptQueue.push(buildClaudeUserMessage(text, attachments));
        return turnId;
    }

    async interrupt() {
        if (!this.query || !this.currentTurnId) {
            return;
        }

        this.interrupting = true;
        try {
            await this.query.interrupt();
        } catch (error) {
            logger.warn(`Failed to interrupt Claude assistant turn: ${getErrorMessage(error)}`);
        } finally {
            this.completeTurn();
            this.interrupting = false;
        }
    }

    close(): Promise<void> {
        this.closing = true;
        this.promptQueue.close();
        try {
            this.query?.close();
        } catch (error) {
            logger.warn(`Failed to close Claude assistant session: ${getErrorMessage(error)}`);
        }
        return Promise.resolve();
    }

    private ensureStarted() {
        if (this.query) {
            return;
        }

        const allowedMcpTools = ASSISTANT_MCP_TOOLS.map(tool => `mcp__${this.options.mcpServerName}__${tool}`);
        const canUseTool = ((toolName) => {
            if (allowedMcpTools.includes(toolName)) {
                return Promise.resolve({ behavior: 'allow' });
            }
            return Promise.resolve({
                behavior: 'deny',
                message: 'EVB Assistant may only use EVB Viewer MCP tools.',
            });
        }) satisfies CanUseTool;
        const sdkModel = getClaudeSdkModel(this.currentModel);
        this.query = query({
            prompt: this.promptQueue,
            options: {
                cwd: this.options.cwd,
                ...(sdkModel ? { model: sdkModel } : {}),
                effort: this.currentEffort,
                ...(this.options.executablePath ? { pathToClaudeCodeExecutable: this.options.executablePath } : {}),
                env: {
                    ...process.env,
                    CLAUDE_AGENT_SDK_CLIENT_APP: `evb-viewer/${app.getVersion()}`,
                    [ASSISTANT_MCP_TOKEN_ENV]: this.options.mcpToken,
                    NO_COLOR: '1',
                },
                tools: [],
                allowedTools: [`mcp__${this.options.mcpServerName}__*`],
                mcpServers: {[this.options.mcpServerName]: {
                    type: 'http',
                    url: this.options.mcpServerUrl,
                    headers: { Authorization: `Bearer ${this.options.mcpToken}` },
                }},
                permissionMode: 'dontAsk',
                systemPrompt: {
                    type: 'preset',
                    preset: 'claude_code',
                    append: ASSISTANT_ROLE_PROMPT,
                },
                settingSources: [],
                includePartialMessages: true,
                persistSession: false,
                strictMcpConfig: true,
                canUseTool,
                stderr: message => logger.info(`[sdk] ${message.trim()}`),
            },
        });
        void this.consumeStream();
        void this.refreshAccountInfo();
    }

    private async setModel(model: string) {
        const normalized = normalizeClaudeAssistantModel(model);
        if (normalized === this.currentModel) {
            return;
        }

        if (this.query) {
            await this.query.setModel(getClaudeSdkModel(normalized));
        }
        this.currentModel = normalized;
    }

    private async refreshAccountInfo() {
        if (!this.query) {
            return;
        }

        try {
            this.account = normalizeClaudeAccount(await this.query.accountInfo());
            this.publishInitialized(0);
        } catch (error) {
            logger.warn(`Failed to read Claude account info: ${getErrorMessage(error)}`);
        }
    }

    private async consumeStream() {
        try {
            if (!this.query) {
                return;
            }

            for await (const message of this.query) {
                this.handleMessage(message);
            }

            if (!this.closing && !this.interrupting) {
                this.options.callbacks.onError('Claude assistant session ended.');
            }
        } catch (error) {
            if (this.closing || this.interrupting || isInterruptedErrorMessage(getErrorMessage(error))) {
                this.completeTurn();
                return;
            }
            this.options.callbacks.onError(getErrorMessage(error));
        }
    }

    private handleMessage(message: SDKMessage) {
        if (message.type === 'system' && message.subtype === 'init') {
            this.handleInitMessage(message);
            return;
        }

        if (message.type === 'stream_event') {
            const delta = extractTextDelta(message);
            if (delta && this.currentAssistantMessageId) {
                this.options.callbacks.onAssistantDelta(this.currentAssistantMessageId, delta);
            }
            return;
        }

        if (message.type === 'assistant') {
            const text = extractAssistantText(message);
            if (text && this.currentAssistantMessageId) {
                this.options.callbacks.onAssistantMessage(this.currentAssistantMessageId, text, true);
            }
            return;
        }

        if (message.type === 'result') {
            const error = getResultErrorMessage(message);
            if (error) {
                this.options.callbacks.onError(error);
                return;
            }
            this.completeTurn();
        }
    }

    private handleInitMessage(message: SDKSystemMessage) {
        this.sessionId = message.session_id;
        if (message.model) {
            this.currentModel = normalizeClaudeAssistantModel(message.model);
        }
        const toolCount = message.tools.filter(tool => tool.startsWith(`mcp__${this.options.mcpServerName}__`)).length;
        this.publishInitialized(toolCount);
    }

    private publishInitialized(toolCount: number) {
        this.options.callbacks.onInitialized({
            sessionId: this.sessionId,
            model: this.currentModel,
            toolCount,
            account: this.account,
        });
    }

    private completeTurn() {
        if (!this.currentTurnId) {
            return;
        }

        const turnId = this.currentTurnId;
        this.currentTurnId = null;
        this.currentAssistantMessageId = null;
        this.options.callbacks.onTurnCompleted(turnId);
    }
}
