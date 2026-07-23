import {
    HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX,
    decodeHostResourceProfileSnapshot,
} from '@contracts/hostResourceProfile';

const BASE64URL_PATTERN = /^[\w-]+$/u;

export function readHostResourceProfileArgument(
    argv: readonly string[] = process.argv,
) {
    const matchingArguments = argv.filter(argument =>
        argument.startsWith(HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX),
    );
    if (matchingArguments.length !== 1) {
        return null;
    }

    const encodedSnapshot = matchingArguments[0]!.slice(
        HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX.length,
    );
    if (
        !BASE64URL_PATTERN.test(encodedSnapshot)
        || encodedSnapshot.length % 4 === 1
    ) {
        return null;
    }

    try {
        const decodedBuffer = Buffer.from(encodedSnapshot, 'base64url');
        if (decodedBuffer.toString('base64url') !== encodedSnapshot) {
            return null;
        }
        const parsed: unknown = JSON.parse(decodedBuffer.toString('utf8'));
        return decodeHostResourceProfileSnapshot(parsed);
    } catch {
        return null;
    }
}
