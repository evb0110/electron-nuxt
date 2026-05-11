import { spawn } from 'node:child_process';
import path from 'node:path';

const CODESIGN_CHECK_TIMEOUT_MS = 5_000;

export async function checkMacCodeSignature() {
    return new Promise<boolean>((resolve) => {
        const appBundle = path.resolve(process.execPath, '..', '..', '..');
        const child = spawn('codesign', [
            '-d',
            '--verbose=2',
            appBundle,
        ], {
            shell: false,
            windowsHide: true,
            stdio: [
                'ignore',
                'ignore',
                'pipe',
            ],
        });

        let stderr = '';
        let finished = false;
        let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
            timeoutHandle = null;
            if (finished) {
                return;
            }
            finished = true;
            try {
                child.kill('SIGKILL');
            } catch {
                // Ignore kill failures after timeout.
            }
            resolve(false);
        }, CODESIGN_CHECK_TIMEOUT_MS);
        timeoutHandle.unref?.();

        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.once('error', () => {
            if (finished) {
                return;
            }
            finished = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            resolve(false);
        });

        child.once('close', (code) => {
            if (finished) {
                return;
            }
            finished = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            if (code !== 0) {
                resolve(false);
                return;
            }
            resolve(!stderr.includes('Signature=adhoc'));
        });
    });
}
