import {readdir, readFile} from 'node:fs/promises';
import {extname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skippedDirectories = new Set(['node_modules', 'scripts', 'tests', 'dist']);
const artifactDirectories = new Set(['assets', 'partials', 'locales', 'data']);
const artifactRootFiles = new Set(['README.md', 'LICENSE', 'package.json', 'routes.yaml']);
const textExtensions = new Set(['.hbs', '.css', '.js', '.yaml', '.yml', '.json', '.md', '.txt', '.xml', '.svg', '.html', '.htm']);
const binaryExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.eot']);
const forbidden = [
    /https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com/i,
    /https?:\/\/(?:www\.)?youtu\.be/i,
    /https?:\/\/(?:www\.)?dropbox\.com/i,
    /https?:\/\/forms\.gle/i,
    /https?:\/\/docs\.google\.com\/forms/i,
    /(?:sk_live_|sk_test_|ghp_|github_pat_|AIza[0-9A-Za-z_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/
];

const failures = [];
const sourceFiles = [];

const isArtifactFile = (repositoryRelativePath) => {
    const parts = repositoryRelativePath.split('/');
    if (parts.length === 1) return artifactRootFiles.has(repositoryRelativePath) || extname(repositoryRelativePath) === '.hbs';
    return artifactDirectories.has(parts[0]);
};

const collectSourceFiles = async (directory) => {
    const entries = await readdir(directory, {withFileTypes: true});
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!skippedDirectories.has(entry.name)) await collectSourceFiles(join(directory, entry.name));
            continue;
        }
        if (entry.isFile()) {
            const file = join(directory, entry.name);
            const repositoryRelativePath = relative(root, file).replaceAll('\\', '/');
            if (!isArtifactFile(repositoryRelativePath)) continue;
            const extension = extname(entry.name).toLowerCase();
            if (binaryExtensions.has(extension)) continue;
            if (artifactRootFiles.has(repositoryRelativePath) || textExtensions.has(extension)) {
                sourceFiles.push(file);
            } else {
                failures.push(`${repositoryRelativePath}: unclassified artifact file cannot bypass the public URL scan`);
            }
        }
    }
};

await collectSourceFiles(root);
for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) {
        if (pattern.test(source)) failures.push(`${relative(root, file)}: forbidden private URL or secret-like value matches ${pattern}`);
    }
}

const post = await readFile(join(root, 'post.hbs'), 'utf8');
const lectureGuardStart = post.indexOf('Lecture bodies are fail-closed');
const lectureTag = post.indexOf('{{#has tag="#lecture"}}', lectureGuardStart);
const lectureVisibility = post.indexOf('{{#match visibility "paid"}}', lectureTag);
const lectureAccess = post.indexOf('{{#if access}}', lectureVisibility);
const lectureContent = post.indexOf('{{content}}', lectureAccess);
if (lectureGuardStart < 0 || lectureTag < 0 || lectureVisibility < 0 || lectureAccess < 0 || lectureContent < 0 || !(lectureTag < lectureVisibility && lectureVisibility < lectureAccess && lectureAccess < lectureContent)) {
    failures.push('post.hbs: #lecture content must be nested under tag, visibility=paid and access guards');
}
if (!post.includes('{{> "configuration-error"}}')) failures.push('post.hbs: misconfigured lecture must render configuration-error without content');
if (/\{\{excerpt\b/.test(post)) failures.push('post.hbs: automatic excerpt is not allowed; use custom_excerpt');

const welcome = await readFile(join(root, 'page-welcome.hbs'), 'utf8');
const welcomeVisibility = welcome.indexOf('{{#match visibility "paid"}}');
const welcomeAccess = welcome.indexOf('{{#if access}}', welcomeVisibility);
const welcomeContent = welcome.indexOf('{{content}}', welcomeAccess);
if (welcomeVisibility < 0 || welcomeAccess < 0 || welcomeContent < 0 || !(welcomeVisibility < welcomeAccess && welcomeAccess < welcomeContent)) {
    failures.push('page-welcome.hbs: {{content}} must remain under visibility=paid and access guards');
}
if (!welcome.includes('{{> "configuration-error"}}')) failures.push('page-welcome.hbs: wrong visibility must render configuration-error');

const card = await readFile(join(root, 'partials', 'lecture-card.hbs'), 'utf8');
if (!card.includes('custom_excerpt') || /\{\{excerpt\b/.test(card)) failures.push('partials/lecture-card.hbs: only custom_excerpt may be displayed');
if (!card.includes('match slug "~^" "speaker-"') || /講師：\{\{primary_author\.name\}\}/.test(card)) {
    failures.push('partials/lecture-card.hbs: speaker identity must come from speaker-* tags, not the staff author');
}

const routes = await readFile(join(root, 'routes.yaml'), 'utf8');
for (const required of [
    /routes:\s*\n\s*\/: home/,
    /\/updates\/:/,
    /filter: tag:-hash-lecture\+visibility:public/,
    /\/lectures\/:/,
    /filter: tag:hash-lecture\+visibility:paid/,
    /tag: \/tag\/{slug}\//
]) {
    if (!required.test(routes)) failures.push(`routes.yaml: missing ${required}`);
}
if (/^\s*author:\s*\/author\//m.test(routes)) failures.push('routes.yaml: staff author taxonomy must remain disabled; speakers use speaker-* tags');
if (/template:\s+page-/.test(routes)) failures.push('routes.yaml: normal page custom routes must be omitted');

const defaultTemplate = await readFile(join(root, 'default.hbs'), 'utf8');
if (!defaultTemplate.includes('{{ghost_head}}')) failures.push('default.hbs: ghost_head is required for CMS meta, OGP and ActivityPub integrations');
const css = await readFile(join(root, 'assets', 'css', 'screen.css'), 'utf8');
if (/\.gh-content iframe\s*\{[^}]*min-height/s.test(css)) failures.push('screen.css: iframe min-height must not override the 16:9 ratio');
const js = await readFile(join(root, 'assets', 'js', 'site.js'), 'utf8');
if (!js.includes("setAttribute('allowfullscreen'")) failures.push('site.js: iframe allowfullscreen fallback is required');

const readme = await readFile(join(root, 'README.md'), 'utf8');
for (const required of ['custom_excerpt', 'CMS', 'meta', 'OGP', 'ActivityPub', '実地検査']) {
    if (!readme.includes(required)) failures.push(`README.md: runtime inspection guidance missing ${required}`);
}

if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
} else {
    console.log(`Public URL guard passed (${sourceFiles.length} source files, paid content guards, CMS meta/OGP/ActivityPub checklist, routes.yaml).`);
}
