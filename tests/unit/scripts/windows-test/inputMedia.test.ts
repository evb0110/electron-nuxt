import { createHash } from 'node:crypto';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    expect,
    it,
} from 'vitest';
import { buildWindowsTestInputMedia } from '@scripts/windows-test/host/inputMedia';
import type {
    ICommandResult,
    ICommandRunner,
} from '@scripts/windows-test/host/utmctlClient';

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        recursive: true,
        force: true,
    })));
});

function sha256(bytes: string) {
    return createHash('sha256').update(bytes).digest('hex');
}

function result(overrides: Partial<ICommandResult> = {}): ICommandResult {
    return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        signal: null,
        ...overrides,
    };
}

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), 'evb-input-media-test-'));
    roots.push(root);
    const sourcePath = path.join(root, 'candidate with private-looking name.exe');
    const sourceBytes = 'candidate bytes';
    await writeFile(sourcePath, sourceBytes, 'utf8');
    const outputPath = path.join(root, 'input-media.iso');
    const calls: Array<{
        command: string;
        args: string[];
    }> = [];
    const runner: ICommandRunner = {run: async (command, args) => {
        calls.push({
            command,
            args,
        });
        const outputIndex = args.indexOf('-o');
        if (outputIndex >= 0) {
            await writeFile(args[outputIndex + 1]!, 'test iso', 'utf8');
        }
        return result();
    }};
    return {
        root,
        sourcePath,
        sourceBytes,
        outputPath,
        calls,
        runner,
    };
}

it('hash-verifies sources and exposes digest-only media names', async () => {
    const harness = await fixture();
    const expectedSha256 = sha256(harness.sourceBytes);
    const built = await buildWindowsTestInputMedia({
        outputPath: harness.outputPath,
        sources: [{
            hostPath: harness.sourcePath,
            sha256: expectedSha256,
        }],
        runner: harness.runner,
        hashFile: async () => expectedSha256,
    });

    const mediaFile = built.hostPathToMediaFile.get(path.resolve(harness.sourcePath));
    expect(mediaFile).toBe(expectedSha256);
    expect(mediaFile).toHaveLength(64);
    expect(mediaFile).not.toContain('candidate');
    expect(await readFile(harness.sourcePath, 'utf8')).toBe(harness.sourceBytes);
    expect(await readFile(harness.outputPath, 'utf8')).toBe('test iso');
    expect(harness.calls[0]?.args).toEqual([
        'makehybrid',
        '-iso',
        '-joliet',
        '-default-volume-name',
        'EVB_INPUTS',
        '-o',
        path.resolve(harness.outputPath),
        expect.any(String),
    ]);
});

it('rejects a source whose bytes drift from the expected hash before invoking hdiutil', async () => {
    const harness = await fixture();
    const expectedSha256 = sha256('different bytes');
    await expect(buildWindowsTestInputMedia({
        outputPath: harness.outputPath,
        sources: [{
            hostPath: harness.sourcePath,
            sha256: expectedSha256,
        }],
        runner: harness.runner,
    })).rejects.toThrow(`hashes to ${sha256(harness.sourceBytes)}`);
    expect(harness.calls).toEqual([]);
    expect(await readFile(harness.sourcePath, 'utf8')).toBe(harness.sourceBytes);
});

it('rejects symlinked and conflicting sources', async () => {
    const harness = await fixture();
    const linkedPath = path.join(harness.root, 'linked-input.bin');
    const { symlink } = await import('node:fs/promises');
    await symlink(harness.sourcePath, linkedPath);
    const expectedSha256 = sha256(harness.sourceBytes);
    await expect(buildWindowsTestInputMedia({
        outputPath: harness.outputPath,
        sources: [{
            hostPath: linkedPath,
            sha256: expectedSha256,
        }],
        runner: harness.runner,
    })).rejects.toThrow('symbolic link');
    await expect(buildWindowsTestInputMedia({
        outputPath: harness.outputPath,
        sources: [
            {
                hostPath: harness.sourcePath,
                sha256: expectedSha256,
            },
            {
                hostPath: harness.sourcePath,
                sha256: sha256('other bytes'),
            },
        ],
        runner: harness.runner,
    })).rejects.toThrow('conflicting hashes');
    expect(harness.calls).toEqual([]);
});
