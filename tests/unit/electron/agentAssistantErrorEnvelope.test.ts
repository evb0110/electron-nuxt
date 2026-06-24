import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentAssistantErrorEnvelope } from '@contracts/agent';
import {
    classifyAssistantError,
    createAssistantErrorEnvelope,
    withAssistantErrorEnvelope,
} from '@electron/features/agent/assistantErrorEnvelope';

describe('agent assistant error envelope', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([
        [
            'asks the user to sign in',
            'Please sign in to continue.',
            {
                code: 'AUTH_REQUIRED',
                retryable: true,
            },
        ],
        [
            'keeps login cancellation distinct from generic cancellation',
            'Login cancelled by the user.',
            {
                code: 'LOGIN_CANCELLED',
                retryable: true,
            },
        ],
        [
            'detects missing installs',
            'Codex executable was not found.',
            {
                code: 'INSTALL_MISSING',
                retryable: true,
            },
        ],
        [
            'detects user interruptions',
            'Operation cancelled by user.',
            {
                code: 'USER_INTERRUPTED',
                retryable: false,
            },
        ],
        [
            'detects unavailable models',
            'Model gpt-test is unavailable.',
            {
                code: 'MODEL_UNAVAILABLE',
                retryable: true,
            },
        ],
        [
            'detects provider rate limits',
            'Provider returned 429 too many requests.',
            {
                code: 'PROVIDER_RATE_LIMITED',
                retryable: true,
            },
        ],
        [
            'detects unavailable runtimes',
            'Runtime server process exited early.',
            {
                code: 'RUNTIME_UNAVAILABLE',
                retryable: true,
            },
        ],
        [
            'defaults to internal errors',
            'Unexpected failure.',
            {
                code: 'INTERNAL',
                retryable: false,
            },
        ],
    ])('%s', (_label, message, expected) => {
        expect(classifyAssistantError(message)).toEqual(expected);
    });

    it('creates envelopes with the current timestamp', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_234_567);

        expect(createAssistantErrorEnvelope('Model gpt-test is unknown.')).toEqual({
            code: 'MODEL_UNAVAILABLE',
            message: 'Model gpt-test is unknown.',
            retryable: true,
            timestamp: 1_234_567,
        });
    });

    it('leaves values without errors unchanged', () => {
        const value = {
            ok: true,
            data: 'ready',
        };

        expect(withAssistantErrorEnvelope(value)).toBe(value);
    });

    it('leaves values with existing envelopes unchanged', () => {
        const errorEnvelope: IAgentAssistantErrorEnvelope = {
            code: 'INTERNAL',
            message: 'Original error.',
            retryable: false,
            timestamp: 10,
        };
        const value = {
            ok: false,
            error: 'Replacement error.',
            errorEnvelope,
        };

        expect(withAssistantErrorEnvelope(value)).toBe(value);
    });

    it('injects an envelope when an error is present', () => {
        vi.useFakeTimers();
        vi.setSystemTime(9_876);

        expect(withAssistantErrorEnvelope({
            ok: false,
            error: 'Auth token expired.',
        })).toEqual({
            ok: false,
            error: 'Auth token expired.',
            errorEnvelope: {
                code: 'AUTH_REQUIRED',
                message: 'Auth token expired.',
                retryable: true,
                timestamp: 9_876,
            },
        });
    });
});
