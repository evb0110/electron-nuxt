import { spawn } from 'node:child_process';
import {
    mkdirSync,
    rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import {
    dirname,
    resolve,
} from 'node:path';

const require = createRequire(import.meta.url);

// Keep vue-tsc pinned in the workspace so CI and local runs share the same
// typecheck toolchain instead of npm fetching a newer transient version.
require.resolve('vue-tsc/package.json');

const argv = process.argv.slice(2);
const cold = argv.includes('--cold') || process.env.EVB_TYPECHECK_COLD === '1';
const workspaceArg = argv.find(argument => !argument.startsWith('-'));
const workspaceDir = workspaceArg ? resolve(workspaceArg) : process.cwd();
const cacheDir = resolve(workspaceDir, '.devkit', 'cache', 'typecheck');
mkdirSync(cacheDir, {recursive: true});
if (cold) {
    rmSync(resolve(cacheDir, 'nuxt.tsbuildinfo'), {force: true});
}
const env = { ...process.env };

// pnpm injects npm-specific config vars that newer npm versions warn about when
// Nuxt shells out through npm internals during typecheck.
for (const key of Object.keys(env)) {
    if (!key.startsWith('npm_config_')) {
        continue;
    }

    if (key === 'npm_config_user_agent') {
        continue;
    }

    delete env[key];
}

const nuxtPackageJson = require.resolve('nuxt/package.json');
const nuxtBin = resolve(dirname(nuxtPackageJson), 'bin/nuxt.mjs');
const child = spawn(process.execPath, [
    nuxtBin,
    'typecheck',
], {
    cwd: workspaceDir,
    env,
    stdio: 'inherit',
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }

    process.exit(code ?? 1);
});
