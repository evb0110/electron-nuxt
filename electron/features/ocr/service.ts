import { registerOcrHandlers } from '@electron/ocr/ipc';
import type {
    IIpcMainRegistrar,
    IOcrService,
} from '@electron/features/ocr/ports';

export function createOcrService(): IOcrService {
    return {registerHandlers: (_registrar: IIpcMainRegistrar) => {
        registerOcrHandlers();
    }};
}
