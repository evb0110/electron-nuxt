import type { InjectionKey } from 'vue';
import type { IPdfOutlineTreeContext } from '@app/utils/pdf-viewer/pdf-outline-tree-context/pdfOutlineTreeContextTypes';

export const pdfOutlineTreeKey: InjectionKey<IPdfOutlineTreeContext> = Symbol('PdfOutlineTree');
