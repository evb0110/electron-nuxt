import {spawn} from 'node:child_process';

export function runDiagnosticCommand(
    command,
    args,
    {
        allowFailure = false,
        cwd,
        env = process.env,
        onFailure = ({
            command: failedCommand,
            args: failedArgs,
            code,
            stderr,
            stdout,
        }) => new Error([
            `${failedCommand} ${failedArgs.join(' ')} exited with ${String(code)}`,
            stderr.trim(),
            stdout.trim(),
        ].filter(Boolean).join('\n')),
        completionEvent = 'exit',
        resolveCommand = value => value,
    } = {},
) {
    return new Promise((resolveRun, rejectRun) => {
        const child = spawn(resolveCommand(command), args, {
            cwd,
            env,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout += chunk;
        });
        child.stderr.on('data', chunk => {
            stderr += chunk;
        });
        child.once('error', rejectRun);
        child.once(completionEvent, code => {
            if (code !== 0 && !allowFailure) {
                rejectRun(onFailure({
                    args,
                    code,
                    command,
                    stderr,
                    stdout,
                }));
                return;
            }
            resolveRun({
                code,
                stderr,
                stdout,
            });
        });
    });
}
