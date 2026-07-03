import type {
    IPlatformCapabilityManifest,
    IPlatformRuntimeManifest,
    TPlatformBackend,
} from '@contracts/platformManifest';
import { PLATFORM_CONTRACT_VERSION } from '@contracts/platformManifest';
import { isRecord } from '@contracts/runtimeGuards';

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

const DOCUMENT_CAPABILITY_KEYS = [
    'picker',
    'folderPicker',
    'nativePaths',
    'browserDocumentRefs',
    'nativePrint',
    'nativeOpenInDefaultApp',
    'recentFiles',
    'menuEvents',
    'structuredSaveResult',
] as const satisfies ReadonlyArray<keyof IPlatformCapabilityManifest['documents']>;

const TOP_LEVEL_CAPABILITY_KEYS = [
    'windowTabs',
    'agent',
    'updates',
] as const satisfies ReadonlyArray<keyof Omit<IPlatformCapabilityManifest, 'documents'>>;

const REQUIRED_METHOD_PATHS = [
    'documents.openDocumentDialog',
    'documents.openDocumentDirect',
    'documents.readFile',
    'documents.saveFile',
    'documents.recentFiles.get',
    'pageOps.delete',
    'imageExport.exportPdfToImages',
    'ocr.recognize',
    'search.run',
    'djvu.openForViewing',
    'settings.get',
    'system.getMemoryInfo',
    'updates.getState',
    'windowTabs.transfer',
    'shell.openExternal',
    'host.getEnvironment',
    'agent.onWorkspaceSnapshotRequest',
] as const;

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

function readPath(root: unknown, path: string) {
    let value = root;
    for (const segment of path.split('.')) {
        if (!isRecord(value)) {
            return undefined;
        }
        value = value[segment];
    }
    return value;
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

    for (const key of DOCUMENT_CAPABILITY_KEYS) {
        if (typeof manifest.capabilities.documents[key] !== 'boolean') {
            failures.push(createFailure(
                'malformed-capability-manifest',
                `Platform document capability ${key} must be boolean.`,
                `manifest.capabilities.documents.${key}`,
            ));
        }
    }

    for (const key of TOP_LEVEL_CAPABILITY_KEYS) {
        if (typeof manifest.capabilities[key] !== 'boolean') {
            failures.push(createFailure(
                'malformed-capability-manifest',
                `Platform capability ${key} must be boolean.`,
                `manifest.capabilities.${key}`,
            ));
        }
    }
}

function validateRequiredCapabilities(
    manifest: IPlatformRuntimeManifest,
    failures: IPlatformValidationFailure[],
) {
    const { documents } = manifest.capabilities;
    const requiredDocumentCapabilities: Array<keyof IPlatformCapabilityManifest['documents']> = [
        'picker',
        'recentFiles',
        'structuredSaveResult',
    ];
    if (manifest.backend === 'electron') {
        requiredDocumentCapabilities.push(
            'folderPicker',
            'nativePaths',
            'nativePrint',
            'nativeOpenInDefaultApp',
            'menuEvents',
        );
    } else {
        requiredDocumentCapabilities.push('browserDocumentRefs');
    }

    for (const key of requiredDocumentCapabilities) {
        if (documents[key] !== true) {
            failures.push(createFailure(
                'missing-required-capability',
                `Platform document capability ${key} is required.`,
                `manifest.capabilities.documents.${key}`,
            ));
        }
    }

    for (const key of [
        'windowTabs',
        'agent',
    ] as const) {
        if (manifest.capabilities[key] !== true) {
            failures.push(createFailure(
                'missing-required-capability',
                `Platform capability ${key} is required.`,
                `manifest.capabilities.${key}`,
            ));
        }
    }
}

function validateRequiredMethods(api: unknown, failures: IPlatformValidationFailure[]) {
    for (const path of REQUIRED_METHOD_PATHS) {
        if (typeof readPath(api, path) !== 'function') {
            failures.push(createFailure(
                'missing-required-method',
                `Platform method ${path} is required.`,
                path,
            ));
        }
    }
}

function validateCapabilityBackedMethods(
    api: unknown,
    manifest: IPlatformRuntimeManifest,
    failures: IPlatformValidationFailure[],
) {
    if (
        manifest.capabilities.documents.structuredSaveResult
        && typeof readPath(api, 'documents.saveFileStructured') !== 'function'
    ) {
        failures.push(createFailure(
            'missing-required-method',
            'Platform method documents.saveFileStructured is required when structured save results are advertised.',
            'documents.saveFileStructured',
        ));
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
        validateRequiredCapabilities(manifest, failures);
    }
    validateRequiredMethods(api, failures);
    validateCapabilityBackedMethods(api, manifest, failures);

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
