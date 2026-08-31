export class TiffCombineWorkerStartupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TiffCombineWorkerStartupError';
    }
}
