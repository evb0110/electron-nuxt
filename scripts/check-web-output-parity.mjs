import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    REQUIRED_WEB_DEPLOY_ASSETS,
    REQUIRED_WEB_OUTPUT_CONTRACTS,
} from './web-deploy-asset-manifest.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function assertFile(root, relativePath, label) {
    const filePath = path.join(root, relativePath);
    let fileStat;
    try {
        fileStat = await stat(filePath);
    } catch (error) {
        throw new Error(`Missing ${label}: ${relativePath}`, {cause: error});
    }
    if (!fileStat.isFile() || fileStat.size <= 0) {
        throw new Error(`${label} is empty or not a file: ${relativePath}`);
    }
}

export async function validateWebOutputParity({
    root = projectRoot,
    desktopRoot = 'nuxt-output/public',
    vercelRoot = '.vercel/output/static',
} = {}) {
    const requiredPaths = [
        ...REQUIRED_WEB_OUTPUT_CONTRACTS,
        ...REQUIRED_WEB_DEPLOY_ASSETS.map(asset => asset.relativePath),
    ];

    for (const relativePath of requiredPaths) {
        await assertFile(path.join(root, desktopRoot), relativePath, `desktop-static output ${desktopRoot}`);
        await assertFile(path.join(root, vercelRoot), relativePath, `Vercel output ${vercelRoot}`);
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        await validateWebOutputParity();
        console.log('Desktop-static and Vercel web output contracts match.');
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
