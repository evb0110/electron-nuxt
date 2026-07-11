import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentAssistantState } from '@contracts/agent';
import { AGENT_CHANNELS } from '@electron/features/agent/contract';
import { createAgentPreloadClient } from '@electron/features/agent/createAgentPreloadClient';
import {
    decodeAgentAssistantEvent,
    decodeAgentAssistantInstallResult,
    decodeAgentAssistantLoginResult,
    decodeAgentAssistantSendMessageResult,
    decodeAgentAssistantState,
} from '@electron/preload/agentIpcDecoders';

function createAssistantState(): IAgentAssistantState {
    const provider = {
        id: 'codex',
        label: 'Codex',
        installState: 'installed',
        authState: 'signed-in',
        runtimeState: 'ready',
        models: [{
            id: 'gpt-5',
            label: 'GPT-5',
            reasoningEfforts: [{
                id: 'high',
                label: 'High',
                isDefault: true,
            }],
            defaultReasoningEffort: 'high',
            serviceTiers: [{
                id: 'fast',
                label: 'Fast',
            }],
            defaultServiceTier: 'fast',
        }],
        defaultModel: 'gpt-5',
        activeModel: 'gpt-5',
        modelSwitchMode: 'in-session',
        availableEfforts: ['high'],
        defaultEffort: 'high',
        activeEffort: 'high',
        availableSpeedModes: [
            'fast',
            'standard',
        ],
        defaultSpeedMode: 'fast',
        activeSpeedMode: 'fast',
        path: '/usr/local/bin/codex',
        version: '1.0.0',
        minimumVersion: '0.133.0',
        versionSupported: true,
        installUrl: 'https://example.test/install',
        account: {
            type: 'chatgpt',
            email: 'reader@example.test',
        },
    } as const;
    return {
        scope: null,
        status: {
            supported: true,
            platform: 'darwin',
            provider: 'codex',
            providerLabel: 'Codex',
            providers: [provider],
            model: 'gpt-5',
            modelLabel: 'GPT-5',
            models: provider.models,
            modelSwitchMode: 'in-session',
            effort: 'high',
            availableEfforts: ['high'],
            speedMode: 'fast',
            availableSpeedModes: [
                'fast',
                'standard',
            ],
            installState: 'installed',
            codexInstalled: true,
            codexPath: '/usr/local/bin/codex',
            codexVersion: '1.0.0',
            minimumCodexVersion: '0.133.0',
            codexVersionSupported: true,
            installUrl: 'https://example.test/install',
            installScriptUrl: 'https://example.test/install.sh',
            managedInstallDir: '/tmp/codex',
            authState: 'signed-in',
            account: provider.account,
            runtimeState: 'ready',
            mcp: {
                serverName: 'evb-viewer',
                serverUrl: 'http://127.0.0.1:3000',
                serverRunning: true,
                toolCount: 4,
            },
            turn: {
                id: null,
                phase: 'idle',
                reasoning: '',
                toolActivity: [],
                lastEventAtMs: null,
                usage: null,
            },
            lastCheckedAt: '2026-07-10T00:00:00.000Z',
        },
        messages: [{
            id: 'message-1',
            role: 'assistant',
            text: 'Ready',
            createdAt: '2026-07-10T00:00:00.000Z',
        }],
    };
}

describe('agent assistant IPC decoders', () => {
    it('exhaustively reconstructs assistant state and nested provider data', () => {
        const state = createAssistantState();
        const payload = {
            ...state,
            ignored: true,
            status: {
                ...state.status,
                ignored: true,
                providers: state.status.providers.map(provider => ({
                    ...provider,
                    ignored: true,
                })),
            },
        };

        expect(decodeAgentAssistantState(payload)).toEqual(state);
    });

    it('rejects malformed provider entries in state events and invoke results', async () => {
        const state = createAssistantState();
        const malformedState = {
            ...state,
            status: {
                ...state.status,
                providers: [null],
            },
        };

        expect(decodeAgentAssistantState(malformedState)).toBeNull();
        expect(decodeAgentAssistantEvent({
            type: 'state',
            state: malformedState,
        })).toBeNull();
        expect(decodeAgentAssistantInstallResult({
            ok: true,
            state: malformedState,
        })).toBeNull();
        expect(decodeAgentAssistantLoginResult({
            ok: true,
            state: malformedState,
        })).toBeNull();
        expect(decodeAgentAssistantSendMessageResult({
            ok: true,
            state: malformedState,
        })).toBeNull();

        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                expect(channel).toBe(AGENT_CHANNELS.getAssistantState);
                return malformedState;
            }),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const client = createAgentPreloadClient(ipcRenderer as never);

        await expect(client.getAssistantState()).rejects.toThrow(
            'invalid assistant state IPC result',
        );
    });

    it('reconstructs assistant operation result variants', () => {
        const state = createAssistantState();

        expect(decodeAgentAssistantInstallResult({
            ok: true,
            state,
            ignored: true,
        })).toEqual({
            ok: true,
            state,
        });
        expect(decodeAgentAssistantLoginResult({
            ok: true,
            state,
            loginId: 'login-1',
            authUrl: 'https://example.test/auth',
            ignored: true,
        })).toEqual({
            ok: true,
            state,
            loginId: 'login-1',
            authUrl: 'https://example.test/auth',
        });
        expect(decodeAgentAssistantSendMessageResult({
            ok: false,
            state,
            error: 'Unavailable',
            ignored: true,
        })).toEqual({
            ok: false,
            state,
            error: 'Unavailable',
        });
    });

    it('decodes reasoning, heartbeat, and typed tool activity without accepting malformed phases', () => {
        const binding = {
            scopeFingerprint: 'scope',
            sessionKey: 'codex:scope',
            turnGeneration: 2,
            windowId: 1,
        };
        expect(decodeAgentAssistantEvent({
            type: 'reasoning-delta',
            reasoningDelta: 'Inspecting the page',
            phase: 'thinking',
            lastEventAtMs: 42,
            binding,
        })).toEqual({
            type: 'reasoning-delta',
            reasoningDelta: 'Inspecting the page',
            phase: 'thinking',
            lastEventAtMs: 42,
            binding,
        });
        expect(decodeAgentAssistantEvent({
            type: 'turn-progress',
            phase: 'tool-running',
            toolActivity: {
                toolId: 'tool-1',
                name: 'document.search',
                phase: 'running',
                startedAtMs: 42,
            },
            binding,
        })).not.toBeNull();
        expect(decodeAgentAssistantEvent({
            type: 'heartbeat',
            phase: 'hung',
            binding,
        })).toBeNull();
        expect(decodeAgentAssistantEvent({
            type: 'message-delta',
            delta: 'late',
        })).toBeNull();
    });
});
