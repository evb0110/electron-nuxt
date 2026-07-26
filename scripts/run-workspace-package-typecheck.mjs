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

export function getWorkspacePackageTypecheckPlan({
    cold = false,
    projectRoot = process.cwd(),
    projects = [],
} = {}) {
    const args = [
        'scripts/run-ts7-typecheck.mjs',
        ...(cold ? ['--cold'] : []),
        ...projects.flatMap(project => [
            '-p',
            project,
        ]),
    ];
    const skipped = [];

    for (const packageRoot of getWorkspacePackageRoots({ projectRoot })) {
        const tsconfigPath = toPosixPath(path.join(packageRoot, 'tsconfig.json'));
        if (existsSync(path.join(projectRoot, tsconfigPath))) {
            args.push('-p', tsconfigPath);
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
        command: {
            args,
            command: 'node',
        },
        skipped,
    };
}

export function runWorkspacePackageTypecheck({
    cold = false,
    projectRoot = process.cwd(),
    projects = [],
    runCommand = defaultRun,
    stdout = process.stdout,
} = {}) {
    const {
        command,
        skipped,
    } = getWorkspacePackageTypecheckPlan({
        cold,
        projectRoot,
        projects,
    });

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

    runCommand(command.command, command.args, {
        cwd: projectRoot,
        stdio: 'inherit',
    });
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    const args = process.argv.slice(2);
    const cold = args.includes('--cold');
    const projectArgs = args.filter(argument => argument !== '--cold');
    const projects = [];
    for (let index = 0; index < projectArgs.length; index += 2) {
        if (projectArgs[index] !== '-p' || projectArgs[index + 1] === undefined) {
            throw new Error('Usage: node scripts/run-workspace-package-typecheck.mjs [--cold] [-p <tsconfig> ...]');
        }
        projects.push(projectArgs[index + 1]);
    }
    runWorkspacePackageTypecheck({
        cold,
        projects,
    });
}
