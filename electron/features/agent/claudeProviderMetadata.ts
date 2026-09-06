import type { IAgentAssistantModelOption } from '@contracts/agent';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import {
    delimiter,
    join,
} from 'node:path';
import {
    CLAUDE_ASSISTANT_DEFAULT_MODEL,
    CLAUDE_ASSISTANT_MODELS,
} from '@contracts/agentModels';

export const CLAUDE_AGENT_INSTALL_URL = 'https://code.claude.com/docs/en/agent-sdk/overview';
export const CLAUDE_AGENT_DEFAULT_MODEL = CLAUDE_ASSISTANT_DEFAULT_MODEL;
export const CLAUDE_AGENT_MODELS = CLAUDE_ASSISTANT_MODELS;

export interface IClaudeProviderInfo {
    installed: boolean;
    version: string | null;
    executablePath: string | null;
    error?: string;
}

async function executable(path: string | undefined) {
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

export async function getClaudeProviderInfo(env: NodeJS.ProcessEnv = process.env): Promise<IClaudeProviderInfo> {
    const names = process.platform === 'win32' ? [
        'claude.exe',
        'claude.cmd',
    ] : ['claude'];
    const candidates = [
        env.CLAUDE_CODE_PATH,
        env.CLAUDE_CLI_PATH,
        ...(env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(entry => names.map(name => join(entry, name))),
        join(env.HOME ?? homedir(), '.local', 'bin', 'claude'),
        join(env.HOME ?? homedir(), '.claude', 'local', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
    ];
    for (const candidate of candidates) {
        if (await executable(candidate)) {
            return {
                installed: true,
                version: null,
                executablePath: candidate ?? null,
            };
        }
    }
    return {
        installed: false,
        version: null,
        executablePath: null,
        error: 'Claude Code executable was not found. Install Claude Code or set CLAUDE_CODE_PATH to a local claude executable.',
    };
}

export type TClaudeProviderAuthState = 'signed-in' | 'signed-out' | 'unknown';

export async function detectClaudeProviderAuthState(env: NodeJS.ProcessEnv = process.env): Promise<TClaudeProviderAuthState> {
    if (env.ANTHROPIC_API_KEY?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim()) {
        return 'signed-in';
    }
    try {
        await access(join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), '.credentials.json'), constants.R_OK);
        return 'signed-in';
    } catch {
        return process.platform === 'darwin' ? 'unknown' : 'signed-out';
    }
}

const CLAUDE_AGENT_MODEL_ALIASES = new Map<string, string>(Object.entries({
    'fable-5.1': 'fable',
    'claude-fable-5.1': 'fable',
    'claude-fable-5-1': 'fable',
    'claude-opus-5': 'opus',
    'claude-opus-5.0': 'opus',
    'claude-opus-5-0': 'opus',
    'claude-sonnet-5': 'sonnet',
    'claude-sonnet-5.0': 'sonnet',
    'claude-sonnet-5-0': 'sonnet',
}));
const CLAUDE_AGENT_MODEL_IDS = new Set<string>(CLAUDE_AGENT_MODELS.map(model => model.id));
const CLAUDE_AGENT_MODEL_LABELS = new Map<string, string>(CLAUDE_AGENT_MODELS.map(model => [
    model.id,
    model.label,
]));
const CLAUDE_MODEL_ID_PATTERN = /^(?:claude-[a-z0-9][a-z0-9-]*|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*|(?:global|us|eu)\.anthropic\.claude-[a-z0-9][a-z0-9-]*)(?:\[\d+m\])?$/iu;

export function getClaudeAssistantModelLabel(model: string) {
    const canonicalModel = CLAUDE_AGENT_MODEL_ALIASES.get(model);
    return CLAUDE_AGENT_MODEL_LABELS.get(model)
        ?? (canonicalModel ? CLAUDE_AGENT_MODEL_LABELS.get(canonicalModel) : undefined)
        ?? model;
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
    return CLAUDE_AGENT_MODEL_IDS.has(normalized) ? normalized : CLAUDE_AGENT_DEFAULT_MODEL;
}

export function shouldUseClaudeAssistantFastMode(
    model: string | null | undefined,
    speedMode: 'standard' | 'fast',
) {
    if (speedMode !== 'fast') {
        return false;
    }
    const normalized = normalizeClaudeAssistantModel(model).toLowerCase();
    return normalized === 'opus'
        || normalized.startsWith('opus[')
        || normalized.includes('claude-opus-')
        || normalized.includes('/opus-')
        || normalized.includes('.opus-');
}

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

export type { IAgentAssistantModelOption };
