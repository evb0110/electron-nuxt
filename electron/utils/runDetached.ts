import type { ILogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

export interface IRunDetachedOptions {
    label: string;
    logger: Pick<ILogger, 'error'>;
    onError?: (error: unknown) => void;
}

function reportDetachedFailure(error: unknown, options: IRunDetachedOptions) {
    try {
        options.onError?.(error);
    } catch (onErrorFailure) {
        options.logger.error(
            `Detached task "${options.label}" error handler failed: ${getErrorMessage(onErrorFailure)}`,
        );
    }
    options.logger.error(`Detached task "${options.label}" failed: ${getErrorMessage(error)}`);
}

export function runDetached(
    task: () => unknown,
    options: IRunDetachedOptions,
) {
    try {
        void Promise.resolve(task()).catch((error: unknown) => {
            reportDetachedFailure(error, options);
        });
    } catch (error) {
        reportDetachedFailure(error, options);
    }
}
