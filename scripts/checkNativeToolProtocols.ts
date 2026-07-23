import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IGeneratedRustNativeToolProtocol } from '@contracts/nativeToolProtocols';
import { generateNativeToolProtocols } from '@scripts/generateNativeToolProtocols';

export interface ICheckNativeToolProtocolsOptions {
    projectRoot?: string;
    protocols?: readonly IGeneratedRustNativeToolProtocol[];
}

export async function checkNativeToolProtocols(options: ICheckNativeToolProtocolsOptions = {}) {
    await generateNativeToolProtocols({
        check: true,
        ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
        ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
    });
}

const isDirectCliRun = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectCliRun) {
    try {
        await checkNativeToolProtocols();
        console.log('Generated native tool protocol artifacts are current.');
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
