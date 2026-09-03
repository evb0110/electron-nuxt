/* eslint-disable @typescript-eslint/naming-convention */

export const DIAGNOSTIC_OPERATIONS = [
    'renderer-error',
    'main-error',
    'console-error',
    'startup-crash',
] as const;

export type DiagnosticOperation = typeof DIAGNOSTIC_OPERATIONS[number];

export const DIAGNOSTIC_GROUPING_POLICIES = ['code-and-top-frame'] as const;

export type DiagnosticGroupingPolicy = typeof DIAGNOSTIC_GROUPING_POLICIES[number];

export const DIAGNOSTIC_STACK_POLICIES = [
    'source',
    'call-site',
] as const;

export type DiagnosticStackPolicy = typeof DIAGNOSTIC_STACK_POLICIES[number];

export type DiagnosticContextFieldDefinition =
    | {
        readonly kind: 'enum';
        readonly values: readonly string[];
    }
    | {readonly kind: 'boolean';}
    | {
        readonly kind: 'integer';
        readonly min: number;
        readonly max: number;
    };

export type DiagnosticContextDefinition = Readonly<Record<
    string,
    DiagnosticContextFieldDefinition
>>;

export interface IDiagnosticDefinition<
    TContext extends DiagnosticContextDefinition = DiagnosticContextDefinition,
> {
    readonly exceptionType: string;
    readonly exceptionValue: string;
    readonly operation: DiagnosticOperation;
    readonly defaultSeverity: 'error' | 'fatal';
    readonly grouping: DiagnosticGroupingPolicy;
    readonly stackPolicy: DiagnosticStackPolicy;
    readonly context: TContext;
}

const MAX_DIAGNOSTIC_ATTEMPT = 100;

const GENERIC_DIAGNOSTIC_CONTEXT = {
    phase: {
        kind: 'enum',
        values: [
            'bootstrap',
            'operation',
            'shutdown',
        ],
    },
    attempt: {
        kind: 'integer',
        min: 0,
        max: MAX_DIAGNOSTIC_ATTEMPT,
    },
    recovered: {kind: 'boolean'},
} as const satisfies DiagnosticContextDefinition;

export const PROCESS_GONE_TYPES = [
    'gpu',
    'utility',
    'renderer',
    'zygote',
    'sandbox-helper',
    'pepper-plugin',
    'pepper-plugin-broker',
    'other',
] as const;

const PROCESS_GONE_TYPE_BY_ELECTRON_TYPE: Readonly<Record<string, typeof PROCESS_GONE_TYPES[number]>> = {
    GPU: 'gpu',
    Utility: 'utility',
    Renderer: 'renderer',
    Zygote: 'zygote',
    'Sandbox helper': 'sandbox-helper',
    'Pepper Plugin': 'pepper-plugin',
    'Pepper Plugin Broker': 'pepper-plugin-broker',
};

export const PROCESS_GONE_REASONS = [
    'clean-exit',
    'abnormal-exit',
    'killed',
    'crashed',
    'oom',
    'launch-failed',
    'integrity-failure',
    'other',
] as const;

export const PROCESS_GONE_EXIT_CODE_MIN = -1;
export const PROCESS_GONE_EXIT_CODE_MAX = 255;
export const MAX_RENDERER_RECOVERY_ATTEMPTS = 3;
export const GPU_SAFE_MODE_CRASH_COUNT_MIN = 2;
export const GPU_SAFE_MODE_CRASH_COUNT_MAX = 100;

const RENDERER_RECOVERY_TRIGGERS = [
    'renderer-gone',
    'unresponsive-automation',
    'unresponsive-dialog-reload',
    'unresponsive-dialog-fallback',
] as const;

const UNRESPONSIVE_RECOVERY_TRIGGERS = [
    'unresponsive-automation',
    'unresponsive-dialog-reload',
    'unresponsive-dialog-fallback',
    'unresponsive-dialog-prompt',
] as const;

const UNHANDLED_REJECTION_SUBSYSTEMS = [
    'agent',
    'djvu',
    'documents',
    'ocr',
    'search',
    'unknown',
] as const;

const CHILD_PROCESS_GONE_CONTEXT = {
    processType: {
        kind: 'enum',
        values: PROCESS_GONE_TYPES,
    },
    reason: {
        kind: 'enum',
        values: PROCESS_GONE_REASONS,
    },
    exitCode: {
        kind: 'integer',
        min: PROCESS_GONE_EXIT_CODE_MIN,
        max: PROCESS_GONE_EXIT_CODE_MAX,
    },
} as const satisfies DiagnosticContextDefinition;

const RENDERER_PROCESS_GONE_CONTEXT = {
    reason: {
        kind: 'enum',
        values: PROCESS_GONE_REASONS,
    },
    exitCode: {
        kind: 'integer',
        min: PROCESS_GONE_EXIT_CODE_MIN,
        max: PROCESS_GONE_EXIT_CODE_MAX,
    },
} as const satisfies DiagnosticContextDefinition;

const RENDERER_RECOVERY_CONTEXT = {
    trigger: {
        kind: 'enum',
        values: RENDERER_RECOVERY_TRIGGERS,
    },
    recoveryAttempt: {
        kind: 'integer',
        min: 1,
        max: MAX_RENDERER_RECOVERY_ATTEMPTS,
    },
} as const satisfies DiagnosticContextDefinition;

const UNRESPONSIVE_RENDERER_CONTEXT = {
    automated: {kind: 'boolean'},
    recoveryAttempt: {
        kind: 'integer',
        min: 0,
        max: MAX_RENDERER_RECOVERY_ATTEMPTS,
    },
} as const satisfies DiagnosticContextDefinition;

const UNHANDLED_REJECTION_CONTEXT = {subsystem: {
    kind: 'enum',
    values: UNHANDLED_REJECTION_SUBSYSTEMS,
}} as const satisfies DiagnosticContextDefinition;

const UNRESPONSIVE_RECOVERY_CONTEXT = {
    trigger: {
        kind: 'enum',
        values: UNRESPONSIVE_RECOVERY_TRIGGERS,
    },
    recoveryAttempt: {
        kind: 'integer',
        min: 1,
        max: MAX_RENDERER_RECOVERY_ATTEMPTS,
    },
} as const satisfies DiagnosticContextDefinition;

export function normalizeProcessGoneReason(reason: string) {
    return PROCESS_GONE_REASONS.includes(reason as typeof PROCESS_GONE_REASONS[number])
        ? reason as typeof PROCESS_GONE_REASONS[number]
        : 'other';
}

export function normalizeProcessGoneType(type: string) {
    return PROCESS_GONE_TYPE_BY_ELECTRON_TYPE[type] ?? 'other';
}

export function normalizeProcessGoneExitCode(exitCode: number) {
    return Number.isSafeInteger(exitCode)
        && exitCode >= PROCESS_GONE_EXIT_CODE_MIN
        && exitCode <= PROCESS_GONE_EXIT_CODE_MAX
        ? exitCode
        : undefined;
}

export const DIAGNOSTIC_DEFINITIONS = {
    UNCLASSIFIED_RENDERER_ERROR: {
        exceptionType: 'RendererDiagnosticError',
        exceptionValue: 'Unclassified renderer error',
        operation: 'renderer-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: GENERIC_DIAGNOSTIC_CONTEXT,
    },
    UNCLASSIFIED_MAIN_ERROR: {
        exceptionType: 'MainDiagnosticError',
        exceptionValue: 'Unclassified main error',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: GENERIC_DIAGNOSTIC_CONTEXT,
    },
    UNCLASSIFIED_CONSOLE_ERROR: {
        exceptionType: 'ConsoleDiagnosticError',
        exceptionValue: 'Unclassified console error',
        operation: 'console-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: GENERIC_DIAGNOSTIC_CONTEXT,
    },
    MAIN_STARTUP_CRASH: {
        exceptionType: 'MainStartupCrash',
        exceptionValue: 'Main startup crash',
        operation: 'startup-crash',
        defaultSeverity: 'fatal',
        grouping: 'code-and-top-frame',
        stackPolicy: 'source',
        context: {},
    },
    MAIN_CHILD_PROCESS_GONE: {
        exceptionType: 'MainChildProcessGone',
        exceptionValue: 'Main child process gone',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: CHILD_PROCESS_GONE_CONTEXT,
    },
    MAIN_RENDERER_PROCESS_GONE: {
        exceptionType: 'MainRendererProcessGone',
        exceptionValue: 'Main renderer process gone',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: RENDERER_PROCESS_GONE_CONTEXT,
    },
    MAIN_PRELOAD_ERROR: {
        exceptionType: 'MainPreloadError',
        exceptionValue: 'Main preload error',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {hasStack: {kind: 'boolean'}},
    },
    MAIN_UNRESPONSIVE_RENDERER: {
        exceptionType: 'MainUnresponsiveRenderer',
        exceptionValue: 'Main unresponsive renderer',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UNRESPONSIVE_RENDERER_CONTEXT,
    },
    MAIN_RENDERER_RECOVERY_FAILED: {
        exceptionType: 'MainRendererRecoveryFailed',
        exceptionValue: 'Main renderer recovery failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: RENDERER_RECOVERY_CONTEXT,
    },
    MAIN_UNRESPONSIVE_RECOVERY_FAILED: {
        exceptionType: 'MainUnresponsiveRecoveryFailed',
        exceptionValue: 'Main unresponsive recovery failed',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UNRESPONSIVE_RECOVERY_CONTEXT,
    },
    MAIN_GPU_SAFE_MODE_RECOVERY: {
        exceptionType: 'MainGpuSafeModeRecovery',
        exceptionValue: 'Main GPU safe-mode recovery',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: {
            safeMode: {kind: 'boolean'},
            action: {
                kind: 'enum',
                values: [
                    'relaunch',
                    'failed',
                ],
            },
            crashCount: {
                kind: 'integer',
                min: GPU_SAFE_MODE_CRASH_COUNT_MIN,
                max: GPU_SAFE_MODE_CRASH_COUNT_MAX,
            },
        },
    },
    MAIN_UNHANDLED_REJECTION: {
        exceptionType: 'MainUnhandledRejection',
        exceptionValue: 'Main unhandled promise rejection',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UNHANDLED_REJECTION_CONTEXT,
    },
    MAIN_UNHANDLED_REJECTION_RECOVERY: {
        exceptionType: 'MainUnhandledRejectionRecovery',
        exceptionValue: 'Main unhandled rejection subsystem recovery',
        operation: 'main-error',
        defaultSeverity: 'error',
        grouping: 'code-and-top-frame',
        stackPolicy: 'call-site',
        context: UNHANDLED_REJECTION_CONTEXT,
    },
} as const satisfies Readonly<Record<string, IDiagnosticDefinition>>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_DEFINITIONS;

export const DIAGNOSTIC_CODES = Object.freeze(
    Object.keys(DIAGNOSTIC_DEFINITIONS),
) as readonly DiagnosticCode[];

type InferDiagnosticContextField<TField extends DiagnosticContextFieldDefinition> =
    TField extends {
        readonly kind: 'enum';
        readonly values: ReadonlyArray<infer TValue>
    }
        ? Extract<TValue, string>
        : TField extends {readonly kind: 'boolean'}
            ? boolean
            : TField extends {readonly kind: 'integer'}
                ? number
                : never;

type DiagnosticContextForDefinition<
    TDefinition extends IDiagnosticDefinition,
> = {
    [TKey in keyof TDefinition['context']]?: InferDiagnosticContextField<TDefinition['context'][TKey]>;
} & (keyof TDefinition['context'] extends never ? Readonly<Record<string, never>> : unknown);

export type DiagnosticContext<C extends DiagnosticCode> = DiagnosticContextForDefinition<
    (typeof DIAGNOSTIC_DEFINITIONS)[C]
>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function isDiagnosticDefinitionKey(value: unknown): value is DiagnosticCode {
    return typeof value === 'string' && Object.hasOwn(DIAGNOSTIC_DEFINITIONS, value);
}

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
    return isDiagnosticDefinitionKey(value);
}

export function isDiagnosticOperation(value: unknown): value is DiagnosticOperation {
    return typeof value === 'string'
        && DIAGNOSTIC_OPERATIONS.includes(value as DiagnosticOperation);
}

function decodeContextField(
    definition: DiagnosticContextFieldDefinition,
    value: unknown,
): string | boolean | number | null {
    if (definition.kind === 'enum') {
        return typeof value === 'string' && definition.values.includes(value)
            ? value
            : null;
    }
    if (definition.kind === 'boolean') {
        return typeof value === 'boolean' ? value : null;
    }
    if (definition.kind === 'integer') {
        return typeof value === 'number'
            && Number.isSafeInteger(value)
            && value >= definition.min
            && value <= definition.max
            ? value
            : null;
    }
    return null;
}

export function decodeDiagnosticContext<C extends DiagnosticCode>(
    code: C,
    value: unknown,
): DiagnosticContext<C> | null {
    if (!isDiagnosticDefinitionKey(code) || !isPlainRecord(value)) {
        return null;
    }

    try {
        const definition = DIAGNOSTIC_DEFINITIONS[code].context;
        const keys = Reflect.ownKeys(value);
        if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(definition, key))) {
            return null;
        }

        const decoded: Record<string, unknown> = {};
        for (const key of keys) {
            if (typeof key !== 'string') {
                return null;
            }
            const field = (definition as DiagnosticContextDefinition)[key];
            if (field === undefined) {
                return null;
            }
            const decodedField = decodeContextField(field, value[key]);
            if (decodedField === null) {
                return null;
            }
            decoded[key] = decodedField;
        }
        return decoded as DiagnosticContext<C>;
    } catch {
        return null;
    }
}
