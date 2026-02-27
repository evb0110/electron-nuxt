import {createOcrService} from '@electron/features/ocr/service';
import type {
    IIpcMainRegistrar,
    IOcrService,
} from '@electron/features/ocr/ports';

export function registerOcrIpcAdapter(
    registrar: IIpcMainRegistrar,
    service: IOcrService = createOcrService(),
) {
    service.registerHandlers(registrar);
}
