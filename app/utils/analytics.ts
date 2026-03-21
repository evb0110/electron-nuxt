const FILE_SIZE_MB = 1024 * 1024;

export function bucketFileSize(sizeInBytes: number | null | undefined): string | null {
    if (typeof sizeInBytes !== 'number' || !Number.isFinite(sizeInBytes) || sizeInBytes < 0) {
        return null;
    }

    if (sizeInBytes < FILE_SIZE_MB) {
        return 'under_1mb';
    }
    if (sizeInBytes < 10 * FILE_SIZE_MB) {
        return '1mb_to_10mb';
    }
    if (sizeInBytes < 50 * FILE_SIZE_MB) {
        return '10mb_to_50mb';
    }
    if (sizeInBytes < 200 * FILE_SIZE_MB) {
        return '50mb_to_200mb';
    }
    return '200mb_plus';
}

export function bucketPageCount(pageCount: number | null | undefined): string | null {
    if (!Number.isInteger(pageCount) || pageCount === null || pageCount === undefined || pageCount <= 0) {
        return null;
    }

    if (pageCount === 1) {
        return '1';
    }
    if (pageCount <= 5) {
        return '2_to_5';
    }
    if (pageCount <= 20) {
        return '6_to_20';
    }
    if (pageCount <= 100) {
        return '21_to_100';
    }
    return '101_plus';
}

export function bucketQueryLength(length: number): string {
    if (length <= 1) {
        return '1_or_less';
    }
    if (length <= 3) {
        return '2_to_3';
    }
    if (length <= 7) {
        return '4_to_7';
    }
    if (length <= 15) {
        return '8_to_15';
    }
    return '16_plus';
}

export function getLowercaseExtension(fileName: string | null | undefined): string | null {
    if (!fileName) {
        return null;
    }

    const normalized = fileName.trim();
    const lastDotIndex = normalized.lastIndexOf('.');
    if (lastDotIndex < 0 || lastDotIndex === normalized.length - 1) {
        return null;
    }

    return normalized.slice(lastDotIndex + 1).toLowerCase();
}
