import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync, zipSync} from 'fflate';

const themeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(join(themeRoot, 'package.json'), 'utf8'));
const outputDirectory = join(themeRoot, 'dist');
const outputPath = join(outputDirectory, `${packageJson.name}-${packageJson.version}.zip`);
const forbiddenSegments = new Set(['node_modules', 'scripts', 'tests', 'dist']);
const requiredEntries = ['package.json', 'routes.yaml', 'index.hbs', 'post.hbs'];

const isSafeRootFile = (relativePath) => {
    if (relativePath === 'package.json' || relativePath === 'routes.yaml' || relativePath === 'README.md' || relativePath === 'LICENSE') return true;
    return extname(relativePath) === '.hbs';
};

const shouldInclude = (relativePath) => {
    const parts = relativePath.split('/');
    if (parts.some((part) => forbiddenSegments.has(part))) return false;
    if (parts[0] === 'assets' || parts[0] === 'partials' || parts[0] === 'locales' || parts[0] === 'data') return true;
    return parts.length === 1 && isSafeRootFile(relativePath);
};

const collectFiles = async (directory, prefix = '') => {
    const entries = [];
    const directoryEntries = await readdir(directory, {withFileTypes: true});
    directoryEntries.sort((a, b) => a.name.localeCompare(b.name, 'en'));

    for (const entry of directoryEntries) {
        const relativePath = `${prefix}${entry.name}`;
        if (entry.isDirectory()) {
            if (forbiddenSegments.has(entry.name)) continue;
            entries.push(...await collectFiles(join(directory, entry.name), `${relativePath}/`));
            continue;
        }
        if (entry.isFile() && shouldInclude(relativePath)) entries.push(relativePath);
    }

    return entries;
};

const relativeFiles = (await collectFiles(themeRoot)).sort((a, b) => a.localeCompare(b, 'en'));
const zipEntries = {};
for (const relativePath of relativeFiles) {
    zipEntries[relativePath] = new Uint8Array(await readFile(join(themeRoot, relativePath)));
}

for (const requiredEntry of requiredEntries) {
    if (!zipEntries[requiredEntry]) throw new Error(`ZIP missing required entry: ${requiredEntry}`);
}
if (!Object.keys(zipEntries).some((entry) => entry.startsWith('assets/'))) throw new Error('ZIP missing assets/');

// fflate serializes local Date components into ZIP's DOS timestamp. Use the
// local 1980 boundary so the bytes are identical in UTC, JST and west-of-UTC
// environments (an ISO UTC instant can become 1979 locally or change fields).
const archive = zipSync(zipEntries, {level: 9, mtime: new Date(1980, 0, 1, 0, 0, 0)});
const extracted = unzipSync(archive);
const extractedNames = Object.keys(extracted).sort((a, b) => a.localeCompare(b, 'en'));
const forbiddenArchiveEntry = extractedNames.find((entry) => {
    const firstSegment = entry.split('/')[0];
    return forbiddenSegments.has(firstSegment) || entry.includes('..');
});
if (forbiddenArchiveEntry) throw new Error(`ZIP contains forbidden entry: ${forbiddenArchiveEntry}`);
if (extractedNames.join('\n') !== relativeFiles.join('\n')) throw new Error('ZIP entry manifest is not deterministic or does not match the allowlist');

const gscanPath = join(themeRoot, 'node_modules', 'gscan', 'bin', 'cli.js');
// GScan's current ZIP dependency has a disclosed symlink traversal issue.
// Scan only this repository-controlled source directory; ZIP integrity and its
// strict allowlist are verified above with fflate before the artifact is kept.
const gscan = spawnSync(process.execPath, [gscanPath, themeRoot], {
    cwd: themeRoot,
    encoding: 'utf8',
    stdio: 'inherit'
});
if (gscan.error) throw gscan.error;
if (gscan.status !== 0) throw new Error(`gscan failed for repository-controlled theme source (exit ${gscan.status})`);

// Publish only after every compatibility and archive-integrity check passes;
// a failed GScan must never leave a fresh release-looking ZIP behind.
await mkdir(outputDirectory, {recursive: true});
await writeFile(outputPath, archive);

console.log(`Built deterministic Ghost theme ZIP: ${outputPath}`);
console.log(`ZIP entries: ${extractedNames.length}; excluded: node_modules/, scripts/, tests/, dist/`);
