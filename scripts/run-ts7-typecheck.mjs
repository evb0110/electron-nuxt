#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

function readTs7Package() {
    const packageJsonPath = require.resolve('typescript7/package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const declaredBin = typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.tsc;

    if (typeof declaredBin !== 'string' || declaredBin.length === 0) {
        throw new Error(`typescript7 does not declare a tsc executable in ${packageJsonPath}.`);
    }

    return {
        packageJsonPath,
        tscPath: path.resolve(path.dirname(packageJsonPath), declaredBin),
    };
}

function resolveTs7Compiler() {
    const {
        packageJsonPath,
        tscPath,
    } = readTs7Package();
    const result = spawnSync(tscPath, ['--version'], {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });

    if (result.error) {
        throw new Error(`Could not execute the typescript7 tsc binary at ${tscPath}.`, {cause: result.error});
    }
    if (result.status !== 0) {
        const detail = `${result.stdout}${result.stderr}`.trim();
        throw new Error(`typescript7 tsc --version failed with exit code ${result.status}${detail === '' ? '' : `: ${detail}`}`);
    }

    const output = `${result.stdout}${result.stderr}`.trim();
    const versionMatch = /\bVersion\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(output);
    const version = versionMatch?.[1];
    if (version === undefined || !version.startsWith('7.')) {
        throw new Error(`Expected typescript7 tsc to report a 7.x version, received ${JSON.stringify(output)} from ${packageJsonPath}.`);
    }

    return {
        tscPath,
        version,
    };
}

function parseProjectArguments(args) {
    const projects = [];
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const project = args[index + 1];
        if (flag !== '-p' || project === undefined) {
            throw new Error('Usage: node scripts/run-ts7-typecheck.mjs -p <tsconfig> [-p <tsconfig> ...]');
        }
        projects.push(project);
    }

    if (projects.length === 0) {
        throw new Error('At least one -p <tsconfig> project argument is required.');
    }

    return projects;
}

function run() {
    const args = process.argv.slice(2);
    const {
        tscPath,
        version,
    } = resolveTs7Compiler();
    console.log(`Using TypeScript ${version} native compiler at ${tscPath}`);

    if (args.length === 1 && args[0] === '--version-check') {
        return;
    }

    for (const project of parseProjectArguments(args)) {
        const result = spawnSync(tscPath, [
            '-p',
            project,
            '--noEmit',
        ], {stdio: 'inherit'});
        if (result.error) {
            throw new Error(`Could not typecheck ${project} with TypeScript ${version}.`, {cause: result.error});
        }
        if (result.status !== 0) {
            process.exit(result.status ?? 1);
        }
    }
}

try {
    run();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
