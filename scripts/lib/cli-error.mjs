/** @param {unknown} error */
export function getCliErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
