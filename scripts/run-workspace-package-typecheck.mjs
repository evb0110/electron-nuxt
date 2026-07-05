#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspacePackageRoots } from './workspace-roots.mjs';

export const TYPECHECK_EXEMPT_WORKSPACE_PACKAGES = {'packages/electron-worker-bundles': 'JavaScript-only worker bundle manifest package with checked-in type declarations.'};

function defaultRun(command, args, options = {}) {
    execFileSync(command, args, {
        cwd: process.cwd(),
        stdio: 'inherit',
        ...options,
    });
}

function toPosixPath(filePath) {
    return filePath.split(path.sep).join('/');
}

export function getWorkspacePackageTypecheckPlan({projectRoot = process.cwd()} = {}) {
    const commands = [];
    const skipped = [];

    for (const packageRoot of getWorkspacePackageRoots({ projectRoot })) {
        const tsconfigPath = toPosixPath(path.join(packageRoot, 'tsconfig.json'));
        if (existsSync(path.join(projectRoot, tsconfigPath))) {
            commands.push({
                args: [
                    'exec',
                    'tsc',
                    '-p',
                    tsconfigPath,
                ],
                command: 'pnpm',
            });
            continue;
        }

        const reason = TYPECHECK_EXEMPT_WORKSPACE_PACKAGES[packageRoot];
        if (reason) {
            skipped.push({
                packageRoot,
                reason,
            });
            continue;
        }

        throw new Error(
            `Workspace package ${packageRoot} is missing tsconfig.json and has no typecheck exemption.`,
        );
    }

    return {
        commands,
        skipped,
    };
}

export function runWorkspacePackageTypecheck({
    projectRoot = process.cwd(),
    runCommand = defaultRun,
    stdout = process.stdout,
} = {}) {
    const {
        commands,
        skipped,
    } = getWorkspacePackageTypecheckPlan({ projectRoot });

    if (skipped.length > 0) {
        stdout.write(
            `${skipped.map(({
                packageRoot,
                reason,
            }) => (
                `Skipping workspace package typecheck for ${packageRoot}: ${reason}`
            )).join('\n')}\n`,
        );
    }

    for (const command of commands) {
        runCommand(command.command, command.args, {
            cwd: projectRoot,
            stdio: 'inherit',
        });
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    runWorkspacePackageTypecheck();
}
