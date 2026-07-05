import {
    describe,
    expect,
    it,
} from 'vitest';
import { AGENT_CHANNELS } from '@electron/features/agent/contract';
import { DJVU_CHANNELS } from '@electron/features/djvu/contract';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { IMAGE_EXPORT_CHANNELS } from '@electron/features/image-export/contract';
import { OCR_CHANNELS } from '@electron/features/ocr/contract';
import { SEARCH_CHANNELS } from '@electron/features/search/contract';
import { CORE_IPC_CHANNELS } from '@electron/platform-ipc/coreContract';
import {
    AGENT_IPC_ARGUMENT_VALIDATION_POLICY,
    CORE_IPC_ARGUMENT_VALIDATION_POLICY,
    DJVU_IPC_ARGUMENT_VALIDATION_POLICY,
    DOCUMENTS_IPC_ARGUMENT_VALIDATION_POLICY,
    IMAGE_EXPORT_IPC_ARGUMENT_VALIDATION_POLICY,
    OCR_IPC_ARGUMENT_VALIDATION_POLICY,
    SEARCH_IPC_ARGUMENT_VALIDATION_POLICY,
} from '@electron/platform-ipc/ipcInvokeArgumentValidationPolicy';
import type { IIpcInvokeArgumentValidationPolicy } from '@electron/platform-ipc/validatedIpcRegistrar';

function getPolicyChannels(policy: IIpcInvokeArgumentValidationPolicy) {
    return {
        noArgumentChannels: [...(policy.noArgumentChannels ?? [])],
        validatedChannels: [...(policy.channelsValidatedWithoutRegistrarDecoder ?? [])],
    };
}

function expectPolicyToStayWithinChannelSet(
    policy: IIpcInvokeArgumentValidationPolicy,
    channels: Record<string, string>,
) {
    const allowedChannels = new Set(Object.values(channels));
    const {
        noArgumentChannels,
        validatedChannels,
    } = getPolicyChannels(policy);

    expect(noArgumentChannels.filter(channel => !allowedChannels.has(channel))).toEqual([]);
    expect(validatedChannels.filter(channel => !allowedChannels.has(channel))).toEqual([]);
    expect(noArgumentChannels.filter(channel => validatedChannels.includes(channel))).toEqual([]);
}

describe('IPC invoke argument validation policy', () => {
    it('keeps no-decoder policy channels scoped to their owning channel sets', () => {
        expectPolicyToStayWithinChannelSet(CORE_IPC_ARGUMENT_VALIDATION_POLICY, CORE_IPC_CHANNELS);
        expectPolicyToStayWithinChannelSet(DOCUMENTS_IPC_ARGUMENT_VALIDATION_POLICY, DOCUMENTS_CHANNELS);
        expectPolicyToStayWithinChannelSet(AGENT_IPC_ARGUMENT_VALIDATION_POLICY, AGENT_CHANNELS);
        expectPolicyToStayWithinChannelSet(IMAGE_EXPORT_IPC_ARGUMENT_VALIDATION_POLICY, IMAGE_EXPORT_CHANNELS);
        expectPolicyToStayWithinChannelSet(OCR_IPC_ARGUMENT_VALIDATION_POLICY, OCR_CHANNELS);
        expectPolicyToStayWithinChannelSet(SEARCH_IPC_ARGUMENT_VALIDATION_POLICY, SEARCH_CHANNELS);
        expectPolicyToStayWithinChannelSet(DJVU_IPC_ARGUMENT_VALIDATION_POLICY, DJVU_CHANNELS);
    });
});
