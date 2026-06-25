import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getAssistantProviderLabel,
    normalizeAssistantProviderId,
} from '@electron/features/agent/assistantProviderRegistry';
import {
    buildAssistantProviderStatuses,
    createAssistantProviderRuntimeStates,
    getAssistantProviderRuntimeState,
    updateAssistantProviderRuntimeState,
} from '@electron/features/agent/assistantProviderState';

vi.mock('electron', () => ({ app: {
    getPath: () => '/tmp/evb-viewer',
    getVersion: () => 'test',
} }));

vi.mock('@electron/utils/createLogger', () => ({ createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}) }));

describe('agent assistant provider state', () => {
    it('keeps provider ids and labels centralized with Codex-biased normalization', () => {
        expect(normalizeAssistantProviderId('claude')).toBe('claude');
        expect(normalizeAssistantProviderId('codex')).toBe('codex');
        expect(normalizeAssistantProviderId('unknown')).toBe('codex');
        expect(normalizeAssistantProviderId(null)).toBe('codex');
        expect(getAssistantProviderLabel('codex')).toBe('Codex');
        expect(getAssistantProviderLabel('claude')).toBe('Claude');
    });

    it('creates independent mutable runtime records per provider', () => {
        const states = createAssistantProviderRuntimeStates({codex: {
            authState: 'signed-in',
            runtimeState: 'ready',
            lastError: 'Codex warning.',
        }});

        updateAssistantProviderRuntimeState(states, 'codex', {runtimeState: 'busy'});
        updateAssistantProviderRuntimeState(states, 'claude', {
            authState: 'signed-out',
            runtimeState: 'stopped',
            lastError: 'Claude needs login.',
        });

        expect(getAssistantProviderRuntimeState(states, 'codex')).toMatchObject({
            authState: 'signed-in',
            runtimeState: 'busy',
            lastError: 'Codex warning.',
        });
        expect(getAssistantProviderRuntimeState(states, 'claude')).toMatchObject({
            authState: 'signed-out',
            runtimeState: 'stopped',
            lastError: 'Claude needs login.',
        });
    });

    it('builds provider statuses from shared runtime state records', () => {
        const states = createAssistantProviderRuntimeStates({
            codex: {
                authState: 'signed-in',
                runtimeState: 'ready',
                account: {
                    type: 'chatgpt',
                    email: 'reader@example.com',
                },
                lastError: 'Codex warning.',
            },
            claude: {
                authState: 'signed-out',
                runtimeState: 'error',
                lastError: 'Claude needs login.',
            },
        });

        const statuses = buildAssistantProviderStatuses({
            platform: 'darwin',
            states,
            codexInfo: {
                installed: true,
                path: '/bin/codex',
                version: '1.0.0',
                isVersionSupported: true,
                minimumVersion: '0.133.0',
                managedInstallDir: '/tmp/evb-viewer/codex',
            },
            claudeInfo: {
                installed: true,
                version: '0.3.183',
                executablePath: '/bin/claude',
            },
            codexModels: [{
                id: 'gpt-5.5',
                label: 'GPT-5.5',
            }],
            claudeModels: [{
                id: 'opus',
                label: 'Claude Opus',
            }],
            model: 'opus',
            effort: 'max',
            speedMode: 'fast',
        });

        expect(statuses).toHaveLength(2);
        expect(statuses.find(provider => provider.id === 'codex')).toMatchObject({
            label: 'Codex',
            authState: 'signed-in',
            runtimeState: 'ready',
            account: {
                type: 'chatgpt',
                email: 'reader@example.com',
            },
            activeModel: 'gpt-5.5',
            activeEffort: 'low',
            error: 'Codex warning.',
        });
        expect(statuses.find(provider => provider.id === 'claude')).toMatchObject({
            label: 'Claude',
            authState: 'signed-out',
            runtimeState: 'error',
            activeModel: 'opus',
            activeEffort: 'max',
            activeSpeedMode: 'fast',
            error: 'Claude needs login.',
        });
    });
});
