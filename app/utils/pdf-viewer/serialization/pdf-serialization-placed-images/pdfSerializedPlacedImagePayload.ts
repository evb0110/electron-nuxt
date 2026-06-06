import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';

export interface IPdfSerializedPlacedImagePayload extends Omit<IPdfPlacedImageFinalizePayload, 'mimeType'> {mimeType: 'image/png' | 'image/jpeg';}
