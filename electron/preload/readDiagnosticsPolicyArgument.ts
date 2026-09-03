import {
    DIAGNOSTICS_POLICY_ARGUMENT_PREFIX,
    createDiagnosticsStartupPolicy,
    type IDiagnosticsStartupPolicy,
} from '@electron/platform-ipc/coreContract';

const BASE64URL_PATTERN = /^[\w-]+$/u;

export function readDiagnosticsPolicyArgument(
    argv: readonly string[] = process.argv,
): Readonly<IDiagnosticsStartupPolicy> {
    const matchingArguments = argv.filter(argument => argument.startsWith(DIAGNOSTICS_POLICY_ARGUMENT_PREFIX));
    if (matchingArguments.length !== 1) {
        return createDiagnosticsStartupPolicy('unknown');
    }

    const encoded = matchingArguments[0]!.slice(DIAGNOSTICS_POLICY_ARGUMENT_PREFIX.length);
    if (!BASE64URL_PATTERN.test(encoded) || encoded.length % 4 === 1) {
        return createDiagnosticsStartupPolicy('unknown');
    }

    try {
        const decoded = Buffer.from(encoded, 'base64url');
        if (decoded.toString('base64url') !== encoded) {
            return createDiagnosticsStartupPolicy('unknown');
        }
        const parsed: unknown = JSON.parse(decoded.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
            || Reflect.ownKeys(parsed).length !== 1
            || !Object.hasOwn(parsed, 'mode')) {
            return createDiagnosticsStartupPolicy('unknown');
        }
        return createDiagnosticsStartupPolicy((parsed as {mode?: unknown}).mode);
    } catch {
        return createDiagnosticsStartupPolicy('unknown');
    }
}
