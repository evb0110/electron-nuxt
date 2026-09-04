import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    isSentryDiagnosticsBuild,
    resolveSentryBuildTarget,
} from '../packages/contracts/diagnostics/releaseIdentity.js';

async function loadDesktopStager() {
    return import('./release/stage-desktop-renderer-sourcemaps.mjs');
}

export async function stageDesktopRendererSourcemapsIfEnabled({
    environment = process.env,
    loadStager = loadDesktopStager,
} = {}) {
    if (
        !isSentryDiagnosticsBuild(environment)
        || resolveSentryBuildTarget(environment) !== 'desktop'
    ) {
        return null;
    }

    const {stageDesktopRendererSourcemaps} = await loadStager();
    return stageDesktopRendererSourcemaps({environment});
}

function isDirectInvocation() {
    return process.argv[1]
        && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectInvocation()) {
    await stageDesktopRendererSourcemapsIfEnabled();
}
