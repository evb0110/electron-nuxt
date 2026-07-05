import type {
    BrowserWindow,
    WebContents,
} from 'electron';
import type { IOcrCapability } from '@contracts/electronApiOcr';

type TOcrApi = IOcrCapability;
type TOcrPreprocessing = TOcrApi['preprocessing'];
type TPromiseOrValue<T> = T | Promise<T>;

export interface IOcrOperationContext {
    sender: WebContents;
    senderId: number;
    parentWindow: BrowserWindow | null;
}

export interface IOcrService {
    recognize: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrApi['recognize']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrApi['recognize']>>>;
    recognizeBatch: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrApi['recognizeBatch']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrApi['recognizeBatch']>>>;
    createSearchablePdf: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrApi['createSearchablePdf']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrApi['createSearchablePdf']>>>;
    cancel: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrApi['cancel']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrApi['cancel']>>>;
    acknowledgeResultFile: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrApi['acknowledgeResultFile']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrApi['acknowledgeResultFile']>>>;
    getLanguages: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrApi['getLanguages']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrApi['getLanguages']>>>;
    validateTools: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrApi['validateTools']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrApi['validateTools']>>>;
    preprocessingValidate: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrPreprocessing['validate']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrPreprocessing['validate']>>>;
    preprocessPage: (
        context: IOcrOperationContext,
        ...args: Parameters<TOcrPreprocessing['preprocessPage']>
    ) => TPromiseOrValue<Awaited<ReturnType<TOcrPreprocessing['preprocessPage']>>>;
    subscribeProgress: (context: IOcrOperationContext) => void;
}
