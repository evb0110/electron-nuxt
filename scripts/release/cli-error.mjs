export function getCliErrorMessage(error) {
    return error instanceof Error
        ? error.message
        : String(error);
}
