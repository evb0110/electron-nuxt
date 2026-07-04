import type {
    IPlatformRuntimeManifest,
    TPlatformBackend,
} from '@contracts/platformManifest';
import { PLATFORM_CONTRACT_VERSION } from '@contracts/platformManifest';
import { isRecord } from '@contracts/runtimeGuards';
import {
    PLATFORM_API_DESCRIPTOR,
    type IPlatformCapabilityDescriptor,
    type IPlatformMethodDescriptor,
} from '@contracts/platformApiDescriptor';

export type TPlatformValidationFailureCode =
    | 'missing-manifest'
    | 'unsupported-contract-version'
    | 'backend-mismatch'
    | 'missing-required-capability'
    | 'malformed-capability-manifest'
    | 'missing-required-method';

export interface IPlatformValidationFailure {
    code: TPlatformValidationFailureCode;
    message: string;
    path?: string;
}

export interface IPlatformValidationResult {
    ok: boolean;
    failures: IPlatformValidationFailure[];
}

export class PlatformContractError extends Error {
    readonly failures: IPlatformValidationFailure[];

    constructor(message: string, failures: IPlatformValidationFailure[]) {
        super(message);
        this.name = 'PlatformContractError';
        this.failures = failures;
    }
}

function createFailure(
    code: TPlatformValidationFailureCode,
    message: string,
    path?: string,
): IPlatformValidationFailure {
    return {
        code,
        message,
        ...(path === undefined ? {} : {path}),
    };
}

function readPath(root: unknown, path: readonly string[]) {
    let value = root;
    for (const segment of path) {
        if (!isRecord(value)) {
            return undefined;
        }
        value = value[segment];
    }
    return value;
}

function formatPath(path: readonly string[]) {
    return path.join('.');
}

function isPlatformRuntimeManifest(value: unknown): value is IPlatformRuntimeManifest {
    return isRecord(value);
}

function validateCapabilityManifest(
    manifest: IPlatformRuntimeManifest,
    failures: IPlatformValidationFailure[],
) {
    if (!isRecord(manifest.capabilities) || !isRecord(manifest.capabilities.documents)) {
        failures.push(createFailure(
            'malformed-capability-manifest',
            'Platform capability manifest is malformed.',
            'manifest.capabilities',
        ));
        return;
    }

    const capabilities: readonly IPlatformCapabilityDescriptor[] = PLATFORM_API_DESCRIPTOR.capabilities;
    for (const descriptor of capabilities) {
        if (descriptor.manifestPath === undefined) {
            continue;
        }
        const manifestPath = [
            'manifest',
            'capabilities',
            ...descriptor.manifestPath,
        ];
        const value = readPath({manifest}, manifestPath);
        if (typeof value !== 'boolean') {
            failures.push(createFailure(
                'malformed-capability-manifest',
                `Platform capability ${formatPath(descriptor.manifestPath)} must be boolean.`,
                formatPath(manifestPath),
            ));
        }
    }
}

function getRequiredPlatformCapabilities(backend: TPlatformBackend) {
    const capabilities: readonly IPlatformCapabilityDescriptor[] = PLATFORM_API_DESCRIPTOR.capabilities;
    return capabilities.filter(descriptor => descriptor.required[backend]);
}

function getRequiredPlatformMethods(backend: TPlatformBackend) {
    const methods: readonly IPlatformMethodDescriptor[] = PLATFORM_API_DESCRIPTOR.methods;
    return methods.filter(descriptor => descriptor.required[backend]);
}

function validateRequiredCapabilities(
    api: unknown,
    manifest: IPlatformRuntimeManifest,
    failures: IPlatformValidationFailure[],
) {
    for (const descriptor of getRequiredPlatformCapabilities(manifest.backend)) {
        const value = descriptor.manifestPath === undefined
            ? readPath(api, descriptor.path)
            : readPath({manifest}, [
                'manifest',
                'capabilities',
                ...descriptor.manifestPath,
            ]);
        const valid = descriptor.manifestPath === undefined
            ? value !== undefined
            : value === true;
        if (!valid) {
            failures.push(createFailure(
                'missing-required-capability',
                `Platform capability ${formatPath(descriptor.path)} is required.`,
                descriptor.manifestPath === undefined
                    ? formatPath(descriptor.path)
                    : formatPath([
                        'manifest',
                        'capabilities',
                        ...descriptor.manifestPath,
                    ]),
            ));
        }
    }
}

function validateMethods(
    api: unknown,
    backend: TPlatformBackend,
    failures: IPlatformValidationFailure[],
) {
    const requiredMethods = new Set(getRequiredPlatformMethods(backend));
    const methods: readonly IPlatformMethodDescriptor[] = PLATFORM_API_DESCRIPTOR.methods;
    for (const descriptor of methods) {
        const value = readPath(api, descriptor.path);
        if (typeof value === 'function') {
            continue;
        }
        if (requiredMethods.has(descriptor) || (value !== undefined && descriptor.optionalWhenImplemented)) {
            failures.push(createFailure(
                'missing-required-method',
                `Platform method ${formatPath(descriptor.path)} is required.`,
                formatPath(descriptor.path),
            ));
        }
    }
}

export function validatePlatformApi(
    api: unknown,
    expectedBackend: TPlatformBackend,
): IPlatformValidationResult {
    const failures: IPlatformValidationFailure[] = [];
    if (!isRecord(api) || !isRecord(api.manifest)) {
        failures.push(createFailure(
            'missing-manifest',
            'Platform API manifest is missing.',
            'manifest',
        ));
        return {
            ok: false,
            failures,
        };
    }

    const manifest = api.manifest;
    if (!isPlatformRuntimeManifest(manifest)) {
        failures.push(createFailure(
            'missing-manifest',
            'Platform API manifest is missing.',
            'manifest',
        ));
        return {
            ok: false,
            failures,
        };
    }
    if (manifest.backend !== expectedBackend) {
        failures.push(createFailure(
            'backend-mismatch',
            `Platform backend ${String(manifest.backend)} does not match expected ${expectedBackend}.`,
            'manifest.backend',
        ));
    }
    if (manifest.contractVersion !== PLATFORM_CONTRACT_VERSION) {
        failures.push(createFailure(
            'unsupported-contract-version',
            `Platform contract version ${String(manifest.contractVersion)} is not supported.`,
            'manifest.contractVersion',
        ));
    }

    validateCapabilityManifest(manifest, failures);
    if (failures.every(failure => failure.code !== 'malformed-capability-manifest')) {
        validateRequiredCapabilities(api, manifest, failures);
    }
    validateMethods(api, manifest.backend, failures);
    return {
        ok: failures.length === 0,
        failures,
    };
}

export function validateElectronPlatformApi(api: unknown) {
    return validatePlatformApi(api, 'electron');
}

export function validateBrowserPlatformApi(api: unknown) {
    return validatePlatformApi(api, 'browser');
}
