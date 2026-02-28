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
    ensureRuntimeTessdataSeededSync,
    getRuntimeTessdataDir,
} from '@electron/ocr/language-models';
import { resolvePlatformArchTag } from '@electron/utils/platform-arch';

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
        popplerRuntime?: {
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

export function getOcrPaths(): IOcrPaths {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();

    const tesseractDir = join(resourcesBase, 'tesseract');
    const platformDir = join(tesseractDir, platformArch);

    const binary = process.platform === 'win32'
        ? join(platformDir, 'bin', 'tesseract.exe')
        : join(platformDir, 'bin', 'tesseract');

    ensureRuntimeTessdataSeededSync();
    const tessdata = getRuntimeTessdataDir();

    return {
        binary,
        tessdata,
    };
}

export function getOcrToolPaths(): IOcrToolPaths {
    const platformArch = resolvePlatformArchTag();
    const resourcesBase = getResourcesBase();

    // Tesseract paths
    const tesseractDir = join(resourcesBase, 'tesseract');
    const tesseractPlatformDir = join(tesseractDir, platformArch);
    const tesseract = getBinaryPath(tesseractPlatformDir, 'tesseract');
    ensureRuntimeTessdataSeededSync();
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

    return {
        tesseract,
        tessdata,
        pdftoppm,
        pdftotext,
        pdfimages,
        popplerDataDir,
        popplerFontConfigDir,
        qpdf,
        unpaper,
    };
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

export async function validateOcrTools(): Promise<IToolValidationResult> {
    const paths = getOcrToolPaths();
    const errors: string[] = [];

    // Check tesseract
    const tesseractFound = await checkToolExists(paths.tesseract);
    const tesseractVersion = tesseractFound ? await getToolVersion(paths.tesseract) : undefined;
    if (!tesseractFound) {
        errors.push(`Tesseract binary not found: ${paths.tesseract}`);
    }

    // Check tessdata
    const tessdataFound = existsSync(paths.tessdata);
    const languages = tessdataFound ? getAvailableLanguages(paths.tessdata) : undefined;
    if (!tessdataFound) {
        errors.push(`Tessdata directory not found: ${paths.tessdata}`);
    } else if (languages && languages.length === 0) {
        errors.push(`No language models found in tessdata: ${paths.tessdata}`);
    }

    // Check pdftoppm
    const pdftoppmFound = await checkToolExists(paths.pdftoppm);
    if (!pdftoppmFound) {
        errors.push(`pdftoppm not found: ${paths.pdftoppm} (install Poppler or bundle it)`);
    }

    // Check pdftotext
    const pdftotextFound = await checkToolExists(paths.pdftotext);
    if (!pdftotextFound) {
        errors.push(`pdftotext not found: ${paths.pdftotext} (install Poppler or bundle it)`);
    }

    const popplerDataDirFound = !!paths.popplerDataDir && existsSync(paths.popplerDataDir);
    const popplerFontConfigDirFound = !!paths.popplerFontConfigDir && existsSync(paths.popplerFontConfigDir);
    if (process.platform === 'win32') {
        if (!popplerDataDirFound) {
            errors.push(`Poppler data directory not found: ${paths.popplerDataDir || '(unset)'} (expected <resources>/poppler/<platform>/share/poppler)`);
        }
    }

    // Check qpdf
    const qpdfFound = await checkToolExists(paths.qpdf);
    if (!qpdfFound) {
        errors.push(`qpdf not found: ${paths.qpdf} (install qpdf or bundle it)`);
    }

    const popplerRuntimeValid = process.platform !== 'win32' || popplerDataDirFound;
    const valid = tesseractFound && tessdataFound && pdftoppmFound && qpdfFound && popplerRuntimeValid;

    return {
        valid,
        tools: {
            tesseract: {
                found: tesseractFound,
                path: paths.tesseract,
                version: tesseractVersion,
            },
            tessdata: {
                found: tessdataFound,
                path: paths.tessdata,
                languages,
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
                dataDirFound: popplerDataDirFound,
                dataDir: paths.popplerDataDir,
                fontConfigDirFound: popplerFontConfigDirFound,
                fontConfigDir: paths.popplerFontConfigDir,
            },
            qpdf: {
                found: qpdfFound,
                path: paths.qpdf,
            },
        },
        errors,
    };
}
