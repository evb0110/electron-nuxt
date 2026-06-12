export function createEpochGuard() {
    let epoch = 0;

    return {
        begin() {
            epoch += 1;
            return epoch;
        },
        current() {
            return epoch;
        },
        invalidate() {
            epoch += 1;
        },
        isCurrent(token: number) {
            return token === epoch;
        },
    };
}
