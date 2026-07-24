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
    delimiter,
    dirname,
    join,
} from 'node:path';
import { promisify } from 'node:util';
import {app} from 'electron';
import {
    query,
    type AccountInfo,
    type CanUseTool,
    type EffortLevel,
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
    IAgentAssistantModelOption,
    IAgentAssistantTokenUsage,
    TAgentAssistantEffort,
    TAgentAssistantKnownEffort,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import { ASSISTANT_KNOWN_EFFORTS } from '@contracts/agent';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
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
import {
    extractAssistantToolUses,
    extractClaudeTokenUsage,
    type IClaudeAssistantToolActivity,
} from '@electron/features/agent/claudeAssistantStreamPresentation';

const logger = createLogger('agent-claude-assistant');
const CLAUDE_EFFORT_LEVEL_BY_ASSISTANT_EFFORT = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
} as const satisfies Record<TAgentAssistantKnownEffort, EffortLevel>;
const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const CLAUDE_CLI_DISCOVERY_TIMEOUT_MS = 5_000;

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
        'anthropic.claude-fable-5',
        'fable',
    ],
    [
        'claude-opus-4-8',
        'opus',
    ],
    [
        'anthropic.claude-opus-4-8',
        'opus',
    ],
    [
        'claude-opus-4-7',
        'opus',
    ],
    [
        'anthropic.claude-opus-4-7',
        'opus',
    ],
    [
        'claude-opus-4-6',
        'opus',
    ],
    [
        'anthropic.claude-opus-4-6',
        'opus',
    ],
    [
        'claude-sonnet-4-6',
        'sonnet',
    ],
    [
        'anthropic.claude-sonnet-4-6',
        'sonnet',
    ],
    [
        'claude-sonnet-4-5',
        'sonnet',
    ],
    [
        'anthropic.claude-sonnet-4-5',
        'sonnet',
    ],
    [
        'claude-haiku-4-5',
        'haiku',
    ],
    [
        'anthropic.claude-haiku-4-5',
        'haiku',
    ],
    [
        'claude-haiku-4-5-20251001',
        'haiku',
    ],
    [
        'anthropic.claude-haiku-4-5-20251001',
        'haiku',
    ],
] as const);
const CLAUDE_AGENT_MODEL_IDS = new Set<string>(CLAUDE_AGENT_MODELS.map(model => model.id));
const CLAUDE_AGENT_MODEL_LABELS = new Map<string, string>([
    ...CLAUDE_AGENT_MODELS.map(model => [
        model.id,
        model.label,
    ] as const),
    [
        'claude-fable-5',
        'Claude Fable 5',
    ],
    [
        'claude-opus-4-8',
        'Claude Opus 4.8',
    ],
    [
        'claude-opus-4-7',
        'Claude Opus 4.7',
    ],
    [
        'claude-opus-4-6',
        'Claude Opus 4.6',
    ],
    [
        'claude-sonnet-4-6',
        'Claude Sonnet 4.6',
    ],
    [
        'claude-sonnet-4-5',
        'Claude Sonnet 4.5',
    ],
    [
        'claude-haiku-4-5',
        'Claude Haiku 4.5',
    ],
    [
        'claude-haiku-4-5-20251001',
        'Claude Haiku 4.5',
    ],
] as const);
const CLAUDE_MODEL_ID_PATTERN = /^(?:claude-[a-z0-9][a-z0-9-]*|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*|(?:global|us|eu)\.anthropic\.claude-[a-z0-9][a-z0-9-]*)(?:\[\d+m\])?$/iu;

interface IClaudeAgentSdkPackageInfo {
    installed: boolean;
    version: string | null;
    executablePath: string | null;
    error?: string;
}

interface IClaudeAgentSdkInfoOptions {
    env?: NodeJS.ProcessEnv;
    resolveSdkPackageDir?: () => string | null;
    readSdkVersion?: (sdkDir: string) => Promise<string | null>;
    findBundledClaudeExecutable?: (sdkDir: string) => Promise<string | null>;
    pathIsExecutable?: (path: string | null | undefined) => Promise<boolean>;
    findClaudeOnPath?: (
        env: NodeJS.ProcessEnv,
        pathIsExecutable: (path: string | null | undefined) => Promise<boolean>,
    ) => Promise<string | null>;
}

export interface IClaudeAgentAssistantInit {
    sessionId: string | null;
    model: string | null;
    toolCount: number;
    account: AccountInfo | null;
    models?: readonly IAgentAssistantModelOption[];
}

export interface IClaudeAgentAssistantCallbacks {
    onInitialized(info: IClaudeAgentAssistantInit): void;
    onTurnStarted(turnId: string): void;
    onAssistantDelta(turnId: string | null, messageId: string, delta: string): void;
    onReasoningDelta(turnId: string | null, delta: string): void;
    onToolActivity(turnId: string | null, activity: IClaudeAssistantToolActivity): void;
    onUsage(turnId: string | null, usage: IAgentAssistantTokenUsage): void;
    onAssistantMessage(turnId: string | null, messageId: string, text: string, pending: boolean): void;
    onTurnCompleted(turnId: string | null): void;
    onError(turnId: string | null, message: string): void;
}

export interface IClaudeAgentAssistantSessionOptions {
    cwd: string;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
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

function uniqueStrings(values: Array<string | null | undefined>) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const candidate = value?.trim();
        if (!candidate || seen.has(candidate)) {
            continue;
        }
        seen.add(candidate);
        result.push(candidate);
    }
    return result;
}

function firstNonBlank(values: Array<string | null | undefined>) {
    for (const value of values) {
        const candidate = value?.trim();
        if (candidate) {
            return candidate;
        }
    }
    return null;
}

function getClaudeExecutableNames() {
    return process.platform === 'win32'
        ? [
            'claude.cmd',
            'claude.exe',
            'claude',
        ]
        : ['claude'];
}

function getClaudeHomeDir(env: NodeJS.ProcessEnv) {
    return firstNonBlank([
        env.HOME,
        env.USERPROFILE,
    ]) ?? homedir();
}

function buildClaudePathCandidates(env: NodeJS.ProcessEnv) {
    const executableNames = getClaudeExecutableNames();
    const pathCandidates = (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .flatMap(entry => executableNames.map(name => join(entry, name)));
    const homeDir = getClaudeHomeDir(env);
    const userBinCandidates = process.platform === 'win32'
        ? [
            env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Claude', 'claude.exe') : undefined,
            env.APPDATA ? join(env.APPDATA, 'npm', 'claude.cmd') : undefined,
        ]
        : executableNames.flatMap(name => [
            join(homeDir, '.local', 'bin', name),
            join(homeDir, '.claude', 'local', name),
            join(homeDir, '.bun', 'bin', name),
            join(homeDir, 'Library', 'pnpm', name),
        ]);
    const systemCandidates = process.platform === 'win32'
        ? []
        : executableNames.flatMap(name => [
            join('/opt/homebrew/bin', name),
            join('/usr/local/bin', name),
            join('/usr/bin', name),
            join('/snap/bin', name),
        ]);

    return uniqueStrings([
        env.CLAUDE_CODE_PATH,
        env.CLAUDE_CLI_PATH,
        ...pathCandidates,
        ...userBinCandidates,
        ...systemCandidates,
    ]);
}

async function findClaudeWithCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    isExecutable: (path: string | null | undefined) => Promise<boolean>,
) {
    try {
        const {stdout} = await execFileAsync(command, args, {
            encoding: 'utf8',
            env: {
                ...process.env,
                ...env,
            },
            timeout: CLAUDE_CLI_DISCOVERY_TIMEOUT_MS,
            windowsHide: true,
        });
        const matches = stdout
            .split(/\r?\n/u)
            .map(line => line.trim())
            .filter(Boolean);
        for (const match of matches) {
            if (await isExecutable(match)) {
                return match;
            }
        }
    } catch {
        return null;
    }
    return null;
}

async function findClaudeInLoginShell(
    env: NodeJS.ProcessEnv,
    isExecutable: (path: string | null | undefined) => Promise<boolean>,
) {
    if (process.platform === 'win32') {
        return null;
    }

    const shellPath = firstNonBlank([env.SHELL]) ?? '/bin/zsh';
    if (!(await isExecutable(shellPath))) {
        return null;
    }
    return findClaudeWithCommand(shellPath, [
        '-lc',
        'command -v claude',
    ], env, isExecutable);
}

async function findClaudeOnPath(
    env: NodeJS.ProcessEnv = process.env,
    isExecutable: (path: string | null | undefined) => Promise<boolean> = pathIsExecutable,
) {
    for (const candidate of buildClaudePathCandidates(env)) {
        if (await isExecutable(candidate)) {
            return candidate;
        }
    }

    if (process.platform === 'win32') {
        return findClaudeWithCommand('where.exe', ['claude'], env, isExecutable);
    }

    const shCandidate = await findClaudeWithCommand('/bin/sh', [
        '-lc',
        'command -v claude',
    ], env, isExecutable);
    if (shCandidate) {
        return shCandidate;
    }
    return findClaudeInLoginShell(env, isExecutable);
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

function resolveOptionalSdkPackageDir(resolvePackageDir: () => string | null) {
    try {
        return resolvePackageDir();
    } catch (error) {
        const message = `Claude Agent SDK package metadata is unavailable: ${getErrorMessage(error)}`;
        if (app.isPackaged) {
            logger.info(message);
        } else {
            logger.warn(message);
        }
        return null;
    }
}

export async function getClaudeAgentSdkInfo(options: IClaudeAgentSdkInfoOptions = {}): Promise<IClaudeAgentSdkPackageInfo> {
    const env = options.env ?? process.env;
    const resolvePackageDir = options.resolveSdkPackageDir ?? resolveSdkPackageDir;
    const readVersion = options.readSdkVersion ?? readSdkVersion;
    const findBundledExecutable = options.findBundledClaudeExecutable ?? findBundledClaudeExecutable;
    const findPathExecutable = options.findClaudeOnPath ?? findClaudeOnPath;
    const isExecutable = options.pathIsExecutable ?? pathIsExecutable;
    const envPath = env.CLAUDE_CODE_PATH ?? env.CLAUDE_CLI_PATH ?? null;
    const sdkDir = resolveOptionalSdkPackageDir(resolvePackageDir);

    try {
        const [
            version,
            pathExecutable,
            bundledExecutable,
        ] = await Promise.all([
            sdkDir ? readVersion(sdkDir) : Promise.resolve(null),
            findPathExecutable(env, isExecutable),
            sdkDir ? findBundledExecutable(sdkDir) : Promise.resolve(null),
        ]);
        const executablePath = await isExecutable(envPath)
            ? envPath
            : await isExecutable(pathExecutable)
                ? pathExecutable
                : bundledExecutable;
        return {
            installed: Boolean(executablePath),
            version,
            executablePath,
            ...(executablePath
                ? {}
                : { error: sdkDir
                    ? 'Claude Agent SDK native binary was not found. Install Claude Code, reinstall optional dependencies, or set CLAUDE_CODE_PATH to a local claude executable.'
                    : 'Claude Code executable was not found. Install Claude Code or set CLAUDE_CODE_PATH to a local claude executable.' }),
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
    return CLAUDE_AGENT_MODEL_LABELS.get(model) ?? model;
}

export function normalizeClaudeAssistantModel(model: string | null | undefined) {
    const trimmed = model?.trim();
    if (!trimmed) {
        return CLAUDE_AGENT_DEFAULT_MODEL;
    }

    if (CLAUDE_AGENT_MODEL_IDS.has(trimmed) || CLAUDE_MODEL_ID_PATTERN.test(trimmed)) {
        return trimmed;
    }

    const normalized = CLAUDE_AGENT_MODEL_ALIASES.get(trimmed) ?? trimmed;
    return CLAUDE_AGENT_MODEL_IDS.has(normalized)
        ? normalized
        : CLAUDE_AGENT_DEFAULT_MODEL;
}

function isClaudeAssistantFastModeModel(model: string) {
    const normalized = normalizeClaudeAssistantModel(model).toLowerCase();
    return normalized === 'opus'
        || normalized.startsWith('opus[')
        || normalized.includes('claude-opus-')
        || normalized.includes('/opus-')
        || normalized.includes('.opus-');
}

export function shouldUseClaudeAssistantFastMode(
    model: string,
    speedMode: TAgentAssistantSpeedMode,
) {
    return speedMode === 'fast' && isClaudeAssistantFastModeModel(model);
}

function getClaudeSdkModel(model: string) {
    return normalizeClaudeAssistantModel(model);
}

function normalizeClaudeSdkModelInfo(rawModel: unknown): IAgentAssistantModelOption | null {
    if (!isRecord(rawModel)) {
        return null;
    }

    const id = typeof rawModel.value === 'string' ? rawModel.value.trim() : '';
    if (!id) {
        return null;
    }

    const label = typeof rawModel.displayName === 'string' && rawModel.displayName.trim()
        ? rawModel.displayName.trim()
        : getClaudeAssistantModelLabel(id);
    return {
        id,
        label,
    };
}

export function normalizeClaudeSdkModelList(rawModels: unknown): IAgentAssistantModelOption[] {
    if (!Array.isArray(rawModels)) {
        return [];
    }

    const seen = new Set<string>();
    const models: IAgentAssistantModelOption[] = [];
    for (const rawModel of rawModels) {
        const model = normalizeClaudeSdkModelInfo(rawModel);
        if (!model || seen.has(model.id)) {
            continue;
        }
        seen.add(model.id);
        models.push(model);
    }
    return models;
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

function extractThinkingDelta(message: SDKPartialAssistantMessage) {
    const event = message.event;
    if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) {
        return '';
    }
    return event.delta.type === 'thinking_delta' && typeof event.delta.thinking === 'string'
        ? event.delta.thinking
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

function toClaudeEffortLevel(effort: TAgentAssistantEffort): EffortLevel {
    return isOneOf(ASSISTANT_KNOWN_EFFORTS, effort)
        ? CLAUDE_EFFORT_LEVEL_BY_ASSISTANT_EFFORT[effort]
        : 'low';
}

export class ClaudeAgentAssistantSession {
    private readonly promptQueue = new ClaudePromptQueue();
    private query: Query | null = null;
    private consumeStreamPromise: Promise<void> | null = null;
    private closing = false;
    private interrupting = false;
    private currentTurnId: string | null = null;
    private currentAssistantMessageId: string | null = null;
    private currentModel: string;
    private readonly currentEffort: EffortLevel;
    private readonly currentSpeedMode: TAgentAssistantSpeedMode;
    private readonly queryFastMode: boolean;
    private sessionId: string | null = null;
    private account: AccountInfo | null = null;
    private modelOptions: readonly IAgentAssistantModelOption[] | null = null;
    private toolCount = 0;
    private readonly activeToolNames = new Map<string, string>();

    constructor(private readonly options: IClaudeAgentAssistantSessionOptions) {
        this.currentModel = normalizeClaudeAssistantModel(options.model);
        this.currentEffort = toClaudeEffortLevel(options.effort);
        this.currentSpeedMode = options.speedMode;
        this.queryFastMode = shouldUseClaudeAssistantFastMode(this.currentModel, this.currentSpeedMode);
    }

    // fallow-ignore-next-line unused-class-member
    get model() {
        return this.currentModel;
    }

    // Fallow cannot trace access through the assistant session's shared state type.
    // fallow-ignore-next-line unused-class-member
    get effort() {
        return this.currentEffort;
    }

    // fallow-ignore-next-line unused-class-member
    get speedMode() {
        return this.currentSpeedMode;
    }

    // Fallow cannot trace access through the assistant session's shared state type.
    // fallow-ignore-next-line unused-class-member
    get fastMode() {
        return this.queryFastMode;
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

    // Fallow cannot trace calls through the assistant session's shared state type.
    // fallow-ignore-next-line unused-class-member
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
        return this.consumeStreamPromise ?? Promise.resolve();
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
                ...(this.queryFastMode ? { settings: { fastMode: true } } : {}),
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
        this.consumeStreamPromise = this.consumeStream().finally(() => {
            this.consumeStreamPromise = null;
        });
        void this.refreshAccountInfo();
        void this.refreshModelInfo();
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
            this.publishInitialized();
        } catch (error) {
            logger.warn(`Failed to read Claude account info: ${getErrorMessage(error)}`);
        }
    }

    private async refreshModelInfo() {
        if (!this.query) {
            return;
        }

        try {
            const models = normalizeClaudeSdkModelList(await this.query.supportedModels());
            if (models.length > 0) {
                this.modelOptions = models;
                this.publishInitialized();
            }
        } catch (error) {
            logger.warn(`Failed to read Claude model list: ${getErrorMessage(error)}`);
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
                this.options.callbacks.onError(this.currentTurnId, 'Claude assistant session ended.');
            }
        } catch (error) {
            if (this.closing || this.interrupting || isInterruptedErrorMessage(getErrorMessage(error))) {
                this.completeTurn();
                return;
            }
            this.options.callbacks.onError(this.currentTurnId, getErrorMessage(error));
        }
    }

    private handleMessage(message: SDKMessage) {
        if (message.type === 'system' && message.subtype === 'init') {
            this.handleInitMessage(message);
            return;
        }

        if (message.type === 'stream_event') {
            const thinkingDelta = extractThinkingDelta(message);
            if (thinkingDelta) {
                this.options.callbacks.onReasoningDelta(this.currentTurnId, thinkingDelta);
            }
            const delta = extractTextDelta(message);
            if (delta && this.currentAssistantMessageId) {
                this.options.callbacks.onAssistantDelta(this.currentTurnId, this.currentAssistantMessageId, delta);
            }
            return;
        }

        if (message.type === 'tool_progress') {
            this.activeToolNames.set(message.tool_use_id, message.tool_name);
            this.options.callbacks.onToolActivity(this.currentTurnId, {
                toolId: message.tool_use_id,
                name: message.tool_name,
                phase: 'running',
            });
            return;
        }

        if (message.type === 'tool_use_summary') {
            for (const toolId of message.preceding_tool_use_ids) {
                this.options.callbacks.onToolActivity(this.currentTurnId, {
                    toolId,
                    name: this.activeToolNames.get(toolId) ?? 'tool',
                    phase: 'completed',
                });
                this.activeToolNames.delete(toolId);
            }
            return;
        }

        if (message.type === 'assistant') {
            for (const activity of extractAssistantToolUses(message)) {
                this.activeToolNames.set(activity.toolId, activity.name);
                this.options.callbacks.onToolActivity(this.currentTurnId, activity);
            }
            const text = extractAssistantText(message);
            if (text && this.currentAssistantMessageId) {
                this.options.callbacks.onAssistantMessage(this.currentTurnId, this.currentAssistantMessageId, text, true);
            }
            return;
        }

        if (message.type === 'result') {
            const failed = getResultErrorMessage(message) !== null;
            for (const [
                toolId,
                name,
            ] of this.activeToolNames) {
                this.options.callbacks.onToolActivity(this.currentTurnId, {
                    toolId,
                    name,
                    phase: failed ? 'failed' : 'completed',
                });
            }
            this.activeToolNames.clear();
            this.options.callbacks.onUsage(this.currentTurnId, extractClaudeTokenUsage(message));
            const error = getResultErrorMessage(message);
            if (error) {
                this.options.callbacks.onError(this.currentTurnId, error);
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
        this.toolCount = message.tools.filter(tool => tool.startsWith(`mcp__${this.options.mcpServerName}__`)).length;
        this.publishInitialized();
    }

    private publishInitialized() {
        this.options.callbacks.onInitialized({
            sessionId: this.sessionId,
            model: this.currentModel,
            toolCount: this.toolCount,
            account: this.account,
            ...(this.modelOptions ? {models: this.modelOptions} : {}),
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
