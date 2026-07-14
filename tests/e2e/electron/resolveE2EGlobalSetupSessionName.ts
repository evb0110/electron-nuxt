import { assertE2ESessionName } from '@scripts/electron-run/electronRunE2ESessionPrune';
import { getE2ESharedRendererSessionName } from '@scripts/electron-run/electronRunE2ESharedRenderer';

export function resolveE2EGlobalSetupSessionName(env: NodeJS.ProcessEnv = process.env) {
    return assertE2ESessionName(getE2ESharedRendererSessionName(env));
}
