export { browserAgentCapability } from '@app/platform/browser-api/browserAgentCapability';
export { browserDjvuCapability } from '@app/platform/browser-api/browserDjvuCapability';
export { browserHostCapability } from '@app/platform/browser-api/browserHostCapability';
export { browserOcrCapability } from '@app/platform/browser-api/browserOcrCapability';
export { browserSettingsCapability } from '@app/platform/browser-api/browserSettingsCapability';
export { browserUpdatesCapability } from '@app/platform/browser-api/browserUpdatesCapability';
export {
    BrowserWorkerClient,
    canUseBrowserWorker,
} from '@app/platform/browser-api/browserWorkerClient';
export { createBrowserDocumentsCapability } from '@app/platform/browser-api/createBrowserDocumentsCapability';
export { createBrowserSearchCapability } from '@app/platform/browser-api/createBrowserSearchCapability';
export { createCombinedPdfFromPaths } from '@app/platform/browser-api/createCombinedPdfFromPaths';
export { createDjvuWorkerFromPath } from '@app/platform/browser-api/createDjvuWorkerFromPath';
export { decodeBrowserImageBlob } from '@app/platform/browser-api/decodeBrowserImageBlob';
export { settleBrowserWorkerResult } from '@app/platform/browser-api/settleBrowserWorkerResult';
export { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
export type { IDjvuPageSize } from '@app/platform/browser-api/djvujsLoader';
export type {
    IPendingBrowserWorkerRequest,
    TBrowserWorkerResult,
} from '@app/platform/browser-api/settleBrowserWorkerResult';
