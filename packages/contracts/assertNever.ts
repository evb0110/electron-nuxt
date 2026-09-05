function describeUnexpectedValue(value: never) {
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(value);
    } catch {
        serialized = undefined;
    }
    if (serialized !== undefined) {
        return serialized;
    }

    try {
        return String(value);
    } catch {
        return '<unserializable>';
    }
}

export function assertNever(value: never, message?: string): never {
    throw new Error(`${message ?? 'Unexpected value'}: ${describeUnexpectedValue(value)}`);
}
