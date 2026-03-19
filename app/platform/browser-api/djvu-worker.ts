import type { TDocumentRef } from '@contracts/platform-api';
import { getPlatformAPI } from '@app/utils/platform';
import { loadDjvuJs } from '@app/platform/browser-api/djvujs-loader';

export async function createDjvuWorkerFromPath(djvuPath: TDocumentRef) {
    const djvuGlobal = await loadDjvuJs();
    const worker = new djvuGlobal.Worker();
    const bytes = await getPlatformAPI().documents.readFile(djvuPath);
    const buffer = Uint8Array.from(bytes).buffer;

    await worker.createDocument(buffer, {});
    return worker;
}
