import { spawn } from 'child_process';
import { describeProcessExitCode } from '@electron/utils/process-exit';

type TRunCommandResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

export async function runCommand(
    command: string,
    args: string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
        allowedExitCodes?: number[];
        signal?: AbortSignal;
    } = {},
): Promise<TRunCommandResult> {
    const {
        cwd,
        env,
        timeoutMs,
        allowedExitCodes = [0],
        signal,
    } = options;

    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(createAbortError());
            return;
        }

        const proc = spawn(command, args, {
            cwd,
            env,
            shell: false,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        let timeoutId: NodeJS.Timeout | null = null;
        let settled = false;
        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }
        };
        const resolveOnce = (value: TRunCommandResult) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(value);
        };
        const rejectOnce = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };

        const abortHandler = signal
            ? () => {
                proc.kill('SIGKILL');
                rejectOnce(createAbortError());
            }
            : null;
        if (signal && abortHandler) {
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                proc.kill('SIGKILL');
                rejectOnce(new Error(`${command} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        proc.on('error', (err) => {
            rejectOnce(err);
        });

        proc.on('close', (code) => {
            const exitCode = typeof code === 'number' ? code : -1;
            if (!allowedExitCodes.includes(exitCode)) {
                rejectOnce(new Error(`${command} failed with exit code ${
                    describeProcessExitCode(exitCode)
                }: ${stderr || stdout}`));
                return;
            }

            resolveOnce({
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}
