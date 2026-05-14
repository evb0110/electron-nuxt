import {
    existsSync,
    readdirSync,
} from 'fs';
import { spawn } from 'child_process';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';
import {
    ensureRuntimeTessdataSeeded,
    getRuntimeTessdataDir,
} from '@electron/ocr/languageModels';
import { resolvePlatformArchTag } from '@electron/utils/platformArch';

interface IOcrPaths {
    binary: string;
    tessdata: string;
}

export interface IOcrToolPaths {
    tesseract: string;
    tessdata: string;
    pdftoppm: string;
    pdftotext: string;
    pdfimages?: string;
    popplerDataDir?: string;
    popplerFontConfigDir?: string;
    qpdf: string;
    unpaper?: string;
}

interface IToolValidationResult {
    valid: boolean;
    tools: {
        tesseract: {
            found: boolean;
            path: string;
            version?: string 
        };
        tessdata: {
            found: boolean;
            path: string;
            languages?: string[] 
        };
        pdftoppm: {
            found: boolean;
            path: string 
        };
        pdftotext: {
            found: boolean;
            path: string 
        };
        popplerRuntime: {
            dataDirFound: boolean;
            dataDir?: string;
            fontConfigDirFound: boolean;
            fontConfigDir?: string;
        };
        qpdf: {
            found: boolean;
            path: string 
        };
    };
    errors: string[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPackaged = __dirname.includes('app.asar');

function getResourcesBase(): string {
    if (isPackaged) {
        return process.resourcesPath;
    }
    return join(__dirname, '..', 'resources');
}

function findOnSystemPath(name: string): string {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const fullName = `${name}${ext}`;

    if (process.platform === 'darwin') {
        // macOS apps launched from Finder don't inherit shell PATH,
        // so Homebrew binaries aren't found via bare name lookup.
        // Check common Homebrew locations explicitly.
        const brewPaths = [
            join('/opt/homebrew/bin', fullName),  // Apple Silicon
            join('/usr/local/bin', fullName),      // Intel
        ];
        for (const p of brewPaths) {
            if (existsSync(p)) {
                return p;
            }
        }
    }

    return fullName;
}

function getBinaryPath(dir: string, name: string, optional = false): string {
    const ext = process.platform === 'win32' ? '.exe' : '';
    const binPath = join(dir, 'bin', `${name}${ext}`);

    if (existsSync(binPath)) {
        return binPath;
    }

    if (optional) {
        return '';
    }

    // Packaged app must rely on bundled binaries only.
    if (isPackaged) {
        return binPath;
    }

    return findOnSystemPath(name);
}

function createAwaitablePaths<T extends object>(paths: T): T & PromiseLike<T> {
    const seedPromise = ensureRuntimeTessdataSeeded();
    void seedPromise.catch(() => undefined);

    return Object.defineProperty(paths, 'then', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (
            onfulfilled?: (value: T) => unknown,
            onrejected?: (reason: unknown) => unknown,
        ) => seedPromise.then(() => paths).then(onfulfilled, onrejected),
    }) as T & PromiseLike<T>;
}

async function runProcess(
    command: string,
    args: string[],
    timeoutMs = 5_000,
) {
    return new Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
    }>((resolve) => {
        const proc = spawn(command, args, {
            shell: false,
            windowsHide: true,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        const timeoutHandle = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            proc.kill('SIGKILL');
            resolve({
                exitCode: -1,
                stdout,
                stderr: `${stderr}\nProcess timed out`,
            });
        }, timeoutMs);

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });
        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('error', (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            resolve({
                exitCode: -1,
                stdout,
                stderr: `${stderr}\n${error.message}`,
            });
        });

        proc.on('close', (code) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeoutHandle);
            resolve({
                exitCode: typeof code === 'number' ? code : -1,
                stdout,
                stderr,
            });
        });
    });
}

async function getToolVersion(path: string, versionFlag = '--version'): Promise<string | undefined> {
    if (!path || !existsSync(path)) {
        return undefined;
    }

    const result = await runProcess(path, [versionFlag], 5_000);
    if (result.exitCode !== 0) {
        return undefined;
    }

    const output = `${result.stdout}\n${result.stderr}`;
    const match = output.match(/(\d+\.\d+(?:\.\d+)?)/);
    return match?.[1];
}

export function getOcrPaths(): IOcrPaths & PromiseLike<IOcrPaths> {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();

    const tesseractDir = join(resourcesBase, 'tesseract');
    const platformDir = join(tesseractDir, platformArch);

    const binary = process.platform === 'win32'
        ? join(platformDir, 'bin', 'tesseract.exe')
        : join(platformDir, 'bin', 'tesseract');

    const tessdata = getRuntimeTessdataDir();

    return createAwaitablePaths({
        binary,
        tessdata,
    });
}

export function getOcrToolPaths(): IOcrToolPaths & PromiseLike<IOcrToolPaths> {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();

    // Tesseract paths
    const tesseractDir = join(resourcesBase, 'tesseract');
    const tesseractPlatformDir = join(tesseractDir, platformArch);
    const tesseract = getBinaryPath(tesseractPlatformDir, 'tesseract');
    const tessdata = getRuntimeTessdataDir();

    // Poppler paths
    const popplerDir = join(resourcesBase, 'poppler', platformArch);
    const pdftoppm = getBinaryPath(popplerDir, 'pdftoppm');
    const pdftotext = getBinaryPath(popplerDir, 'pdftotext');
    const pdfimages = getBinaryPath(popplerDir, 'pdfimages', true) || undefined;
    const popplerDataDirCandidate = join(popplerDir, 'share', 'poppler');
    const popplerFontConfigDirCandidate = join(popplerDir, 'etc', 'fonts');
    const popplerDataDir = existsSync(popplerDataDirCandidate) ? popplerDataDirCandidate : undefined;
    const popplerFontConfigDir = existsSync(popplerFontConfigDirCandidate) ? popplerFontConfigDirCandidate : undefined;

    // qpdf path
    const qpdfDir = join(resourcesBase, 'qpdf', platformArch);
    const qpdf = getBinaryPath(qpdfDir, 'qpdf');

    // unpaper (optional, currently in tesseract dir alongside tesseract)
    const unpaper = getBinaryPath(tesseractPlatformDir, 'unpaper', true) || undefined;

    const paths: IOcrToolPaths = {
        tesseract,
        tessdata,
        pdftoppm,
        pdftotext,
        qpdf,
    };
    if (pdfimages !== undefined) {
        paths.pdfimages = pdfimages;
    }
    if (popplerDataDir !== undefined) {
        paths.popplerDataDir = popplerDataDir;
    }
    if (popplerFontConfigDir !== undefined) {
        paths.popplerFontConfigDir = popplerFontConfigDir;
    }
    if (unpaper !== undefined) {
        paths.unpaper = unpaper;
    }

    return createAwaitablePaths(paths);
}

async function checkToolExists(path: string): Promise<boolean> {
    // If path contains a directory separator, check if file exists
    if (path.includes('/') || path.includes('\\')) {
        return existsSync(path);
    }

    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = await runProcess(cmd, [path], 5_000);
    return result.exitCode === 0;
}

function getAvailableLanguages(tessdataPath: string): string[] {
    if (!existsSync(tessdataPath)) {
        return [];
    }
    try {
        const files = readdirSync(tessdataPath);
        return files
            .filter((f: string) => f.endsWith('.traineddata'))
            .map((f: string) => f.replace('.traineddata', ''));
    } catch {
        return [];
    }
}

async function validateRequiredTool(
    name: string,
    path: string,
    errors: string[],
    notFoundMessage: (path: string) => string,
) {
    const found = await checkToolExists(path);
    if (!found) {
        errors.push(notFoundMessage(path));
    }
    return found;
}

async function validateTesseractTool(path: string, errors: string[]) {
    const found = await validateRequiredTool(
        'Tesseract',
        path,
        errors,
        toolPath => `Tesseract binary not found: ${toolPath}`,
    );
    const version = found ? await getToolVersion(path) : undefined;
    const result: {
        found: boolean;
        version?: string;
    } = {found};
    if (version !== undefined) {
        result.version = version;
    }
    return result;
}

function validateTessdata(path: string, errors: string[]) {
    const found = existsSync(path);
    const languages = found ? getAvailableLanguages(path) : undefined;
    if (!found) {
        errors.push(`Tessdata directory not found: ${path}`);
    } else if (languages && languages.length === 0) {
        errors.push(`No language models found in tessdata: ${path}`);
    }
    const result: {
        found: boolean;
        languages?: string[];
    } = {found};
    if (languages !== undefined) {
        result.languages = languages;
    }
    return result;
}

function validatePopplerRuntime(paths: IOcrToolPaths, errors: string[]) {
    const dataDirFound = !!paths.popplerDataDir && existsSync(paths.popplerDataDir);
    const fontConfigDirFound = !!paths.popplerFontConfigDir && existsSync(paths.popplerFontConfigDir);
    if (process.platform === 'win32' && !dataDirFound) {
        errors.push(`Poppler data directory not found: ${paths.popplerDataDir || '(unset)'} (expected <resources>/poppler/<platform>/share/poppler)`);
    }
    const result: {
        dataDirFound: boolean;
        dataDir?: string;
        fontConfigDirFound: boolean;
        fontConfigDir?: string;
        valid: boolean;
    } = {
        dataDirFound,
        fontConfigDirFound,
        valid: process.platform !== 'win32' || dataDirFound,
    };
    if (paths.popplerDataDir !== undefined) {
        result.dataDir = paths.popplerDataDir;
    }
    if (paths.popplerFontConfigDir !== undefined) {
        result.fontConfigDir = paths.popplerFontConfigDir;
    }
    return result;
}

export async function validateOcrTools(): Promise<IToolValidationResult> {
    const paths = await getOcrToolPaths();
    const errors: string[] = [];

    const tesseract = await validateTesseractTool(paths.tesseract, errors);
    const tessdata = validateTessdata(paths.tessdata, errors);
    const pdftoppmFound = await validateRequiredTool(
        'pdftoppm',
        paths.pdftoppm,
        errors,
        path => `pdftoppm not found: ${path} (install Poppler or bundle it)`,
    );
    const pdftotextFound = await validateRequiredTool(
        'pdftotext',
        paths.pdftotext,
        errors,
        path => `pdftotext not found: ${path} (install Poppler or bundle it)`,
    );
    const popplerRuntime = validatePopplerRuntime(paths, errors);
    const qpdfFound = await validateRequiredTool(
        'qpdf',
        paths.qpdf,
        errors,
        path => `qpdf not found: ${path} (install qpdf or bundle it)`,
    );
    const valid = tesseract.found && tessdata.found && pdftoppmFound && qpdfFound && popplerRuntime.valid;
    const tools: IToolValidationResult['tools'] = {
        tesseract: {
            found: tesseract.found,
            path: paths.tesseract,
        },
        tessdata: {
            found: tessdata.found,
            path: paths.tessdata,
        },
        pdftoppm: {
            found: pdftoppmFound,
            path: paths.pdftoppm,
        },
        pdftotext: {
            found: pdftotextFound,
            path: paths.pdftotext,
        },
        popplerRuntime: {
            dataDirFound: popplerRuntime.dataDirFound,
            fontConfigDirFound: popplerRuntime.fontConfigDirFound,
        },
        qpdf: {
            found: qpdfFound,
            path: paths.qpdf,
        },
    };
    if (tesseract.version !== undefined) {
        tools.tesseract.version = tesseract.version;
    }
    if (tessdata.languages !== undefined) {
        tools.tessdata.languages = tessdata.languages;
    }
    if (popplerRuntime.dataDir !== undefined) {
        tools.popplerRuntime.dataDir = popplerRuntime.dataDir;
    }
    if (popplerRuntime.fontConfigDir !== undefined) {
        tools.popplerRuntime.fontConfigDir = popplerRuntime.fontConfigDir;
    }

    return {
        valid,
        tools,
        errors,
    };
}
