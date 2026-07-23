import { sanitizeAllowedExternalUrl } from '@contracts/externalUrl';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';

type TVoidResult = ReturnType<() => void>;

const externalUrl = s.fromParser(sanitizeAllowedExternalUrl, () => 'https://example.test/');
const voidResult = s.declared<TVoidResult>()(s.undefined());

export const SHELL_PLATFORM_FEATURE = definePlatformFeature({
    path: ['shell'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {openExternal: {
        kind: 'async',
        channel: 'shell:openExternal',
        ipc: {
            args: s.tuple([externalUrl]),
            result: voidResult,
        },
        main: {
            method: 'openExternal',
            context: 'sender',
        },
        browser: {method: 'openExternal'},
        lazy: 'forwarded',
    }},
    events: {},
});

export type IShellCapability = TFeatureCapability<typeof SHELL_PLATFORM_FEATURE>;
export type IShellInvokeMap = TFeatureInvokeMap<typeof SHELL_PLATFORM_FEATURE>;
