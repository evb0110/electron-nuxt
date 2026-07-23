import {
    describe,
    it,
    vi,
} from 'vitest';
import { PLATFORM_FEATURE_REGISTRY } from '@contracts/platformApiDescriptor';
import type { TAnyDefinedPlatformFeature } from '@contracts/platformFeature';
import { registerPlatformFeatureHandlers } from '@electron/platform-ipc/validatedIpcRegistrar';
import { cast } from '@tests/helpers/cast';
import {
    assertValidatedRegistrarCases,
    createFeatureRegistrarCases,
    createValidatedRegistrarHarness,
} from '@tests/unit/electron/helpers/validatedIpcRegistrarHarness';

const mocks = vi.hoisted(() => ({isTrustedIpcInvokeSender: vi.fn(() => true)}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: vi.fn(),
    },
    BrowserWindow: {fromWebContents: vi.fn(() => null)},
    ipcMain: {handle: vi.fn()},
}));
vi.mock('@electron/platform-ipc/trustedIpcSender', () => mocks);

function createServiceDouble() {
    return new Proxy({}, {get(target, property) {
        const record = target as Record<PropertyKey, unknown>;
        record[property] ??= vi.fn(async () => undefined);
        return record[property];
    }});
}

describe('feature validated IPC decoders', () => {
    it('exhaustively validates every generated feature registrar tuple', async () => {
        for (const registeredFeature of PLATFORM_FEATURE_REGISTRY) {
            const feature = cast<TAnyDefinedPlatformFeature>(registeredFeature);
            const handlers = createValidatedRegistrarHarness({
                channels: feature.invokeChannels,
                codecs: feature.ipcCodecs,
                register: (registrar, service) => registerPlatformFeatureHandlers(
                    cast<Parameters<typeof registerPlatformFeatureHandlers>[0]>(registrar),
                    feature,
                    cast<never>(service),
                ),
                service: createServiceDouble(),
            });
            await assertValidatedRegistrarCases({
                cases: createFeatureRegistrarCases(feature),
                channels: feature.invokeChannels,
                handlers,
                setTrusted: trusted => mocks.isTrustedIpcInvokeSender.mockReturnValue(trusted),
            });
        }
    });

    it('keeps sync and direct methods outside the async registrar', () => {
        for (const registeredFeature of PLATFORM_FEATURE_REGISTRY) {
            const feature = cast<TAnyDefinedPlatformFeature>(registeredFeature);
            const registeredChannels = new Set(Object.values(feature.invokeChannels));
            for (const spec of Object.values(feature.methods)) {
                if (spec.kind === 'sync' || 'local' in spec) {
                    const channel = 'channel' in spec ? spec.channel : undefined;
                    if (channel !== undefined) {
                        throw new Error(`Direct method unexpectedly defines an invoke channel: ${channel}`);
                    }
                }
            }
            for (const testCase of createFeatureRegistrarCases(feature)) {
                if (!registeredChannels.has(testCase.channel)) {
                    throw new Error(`Generated registrar case is missing from invoke channels: ${testCase.channel}`);
                }
            }
        }
    });
});
