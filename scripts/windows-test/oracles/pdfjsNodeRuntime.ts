import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isErrnoException } from '@contracts/runtimeGuards';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export const PDFJS_ASSET_DIRECTORIES = [
    'standard_fonts',
    'cmaps',
    'wasm',
    'iccs',
] as const;

/** The oracle could not run at all; the verdict must stay inconclusive. */
export class PdfjsRuntimeUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PdfjsRuntimeUnavailableError';
    }
}

export function isPdfjsRuntimeUnavailable(error: unknown) {
    return error instanceof PdfjsRuntimeUnavailableError
        || (isErrnoException(error) && error.code === 'ERR_MODULE_NOT_FOUND');
}

export function resolvePdfjsAssetRoot(repositoryRoot: string) {
    const candidate = path.join(repositoryRoot, 'public', 'pdf');
    const missing = PDFJS_ASSET_DIRECTORIES.filter(directory => !existsSync(path.join(candidate, directory)));
    if (missing.length > 0) {
        throw new PdfjsRuntimeUnavailableError(`PDF.js asset root is missing under ${candidate}: ${missing.join(', ')}.`);
    }
    return candidate;
}

function toDirectoryUrl(directory: string) {
    const withSeparator = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
    return pathToFileURL(withSeparator).href;
}

export interface IPdfjsNodeOptions {repositoryRoot: string;}

interface IPdfjsDocumentWithDestroy extends Awaited<ReturnType<typeof pdfjs.getDocument>['promise']> {destroy(): Promise<void>;}

interface IPdfjsDocumentLifecycle {destroy?: () => Promise<void>;}

/**
 * Runs PDF.js at the ERRORS verbosity so a missing optional standard-font file
 * cannot write a warning that the unit setup treats as a test failure.
 */
export function createPdfjsNodeOptions({ repositoryRoot }: IPdfjsNodeOptions) {
    const assetRoot = resolvePdfjsAssetRoot(repositoryRoot);
    return {
        verbosity: pdfjs.VerbosityLevel.ERRORS,
        standardFontDataUrl: toDirectoryUrl(path.join(assetRoot, 'standard_fonts')),
        cMapUrl: toDirectoryUrl(path.join(assetRoot, 'cmaps')),
        cMapPacked: true,
        wasmUrl: toDirectoryUrl(path.join(assetRoot, 'wasm')),
        iccUrl: toDirectoryUrl(path.join(assetRoot, 'iccs')),
        useSystemFonts: false,
        useWorkerFetch: false,
    };
}

export async function loadPdfjsDocument(
    bytes: Uint8Array,
    options: IPdfjsNodeOptions,
): Promise<IPdfjsDocumentWithDestroy> {
    const task = pdfjs.getDocument({
        data: new Uint8Array(bytes),
        ...createPdfjsNodeOptions(options),
    });
    const document = await task.promise;
    const nativeDestroy = (document as IPdfjsDocumentLifecycle).destroy?.bind(document);
    if (nativeDestroy) {
        return document;
    }
    Object.defineProperty(document, 'destroy', {
        configurable: true,
        value: async () => {
            try {
                await document.cleanup();
            } finally {
                await task.destroy();
            }
        },
    });
    return document;
}
