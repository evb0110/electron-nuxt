import {PDFName} from 'pdf-lib';
import type {
    PDFDocument,
    PDFImage,
    PDFRawStream,
} from 'pdf-lib';

const ICC_PROFILE_MAX_BYTES = 16 * 1024 * 1024;

export function embedPdfImageIccProfile(
    document: PDFDocument,
    image: PDFImage,
    profile: Uint8Array | undefined,
    components = 3,
) {
    if (!profile || profile.byteLength === 0) {
        return;
    }
    if (profile.byteLength > ICC_PROFILE_MAX_BYTES) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_ICC_PROFILE_TOO_LARGE');
    }
    const profileSignature = profile.byteLength >= 20
        ? String.fromCharCode(...profile.subarray(16, 20))
        : '';
    const resolvedComponents = profileSignature === 'GRAY' ? 1 : components;
    const alternate = resolvedComponents === 1 ? PDFName.of('DeviceGray') : PDFName.of('DeviceRGB');
    const profileStream = document.context.flateStream(profile, {
        N: resolvedComponents,
        Alternate: alternate,
    });
    const profileRef = document.context.register(profileStream);
    const imageStream = document.context.lookup(image.ref) as PDFRawStream;
    imageStream.dict.set(
        PDFName.of('ColorSpace'),
        document.context.obj([
            PDFName.of('ICCBased'),
            profileRef,
        ]),
    );
}
