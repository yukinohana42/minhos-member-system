import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const themeRoot = join(fileURLToPath(new URL('..', import.meta.url)));
const readThemeFile = (relativePath) => readFile(join(themeRoot, relativePath), 'utf8');
const repoRoot = join(themeRoot, '..', '..');
const readRepoFile = (relativePath) => readFile(join(repoRoot, relativePath), 'utf8');

test('routes reserve the root for home and separate public updates from paid lectures', async () => {
    const routes = await readThemeFile('routes.yaml');
    assert.match(routes, /routes:\s*\n\s*\/: home/);
    assert.match(routes, /\/updates\/:/);
    assert.match(routes, /filter: tag:-hash-lecture\+visibility:public/);
    assert.match(routes, /\/lectures\/:[\s\S]*?filter: tag:hash-lecture\+visibility:paid/);
    assert.doesNotMatch(routes, /template:\s+page-/);
    assert.match(routes, /taxonomies:\s*\n\s*tag: \/tag\/\{slug\}\//);
    assert.doesNotMatch(routes, /^\s*author:\s*\/author\//m);
});

test('lecture and welcome bodies are fail-closed', async () => {
    const post = await readThemeFile('post.hbs');
    const lectureGuardStart = post.indexOf('Lecture bodies are fail-closed');
    const lectureTag = post.indexOf('{{#has tag="#lecture"}}', lectureGuardStart);
    const lectureVisibility = post.indexOf('{{#match visibility "paid"}}', lectureTag);
    const lectureAccess = post.indexOf('{{#if access}}', lectureVisibility);
    const lectureContent = post.indexOf('{{content}}', lectureAccess);
    assert.ok(lectureGuardStart >= 0 && lectureTag > lectureGuardStart);
    assert.ok(lectureVisibility > lectureTag);
    assert.ok(lectureAccess > lectureVisibility);
    assert.ok(lectureContent > lectureAccess);
    assert.match(post, /configuration-error/);
    assert.match(post, /match visibility "public"[\s\S]*\{\{content\}\}/);

    const welcome = await readThemeFile('page-welcome.hbs');
    const welcomeVisibility = welcome.indexOf('{{#match visibility "paid"}}');
    const welcomeAccess = welcome.indexOf('{{#if access}}', welcomeVisibility);
    const welcomeContent = welcome.indexOf('{{content}}', welcomeAccess);
    assert.ok(welcomeVisibility >= 0);
    assert.ok(welcomeAccess > welcomeVisibility);
    assert.ok(welcomeContent > welcomeAccess);
});

test('cards and headers only use explicit custom excerpts', async () => {
    const card = await readThemeFile('partials/lecture-card.hbs');
    const post = await readThemeFile('post.hbs');
    assert.match(card, /custom_excerpt/);
    assert.match(card, /lecture-card__excerpt--fallback/);
    assert.doesNotMatch(card, /\{\{excerpt\b/);
    assert.match(post, /custom_excerpt/);
    assert.doesNotMatch(post, /\{\{excerpt\b/);
});

test('speaker identity comes from speaker tags and publishing docs require every routing tag', async () => {
    const card = await readThemeFile('partials/lecture-card.hbs');
    const post = await readThemeFile('post.hbs');
    const author = await readThemeFile('author.hbs');
    for (const template of [card, post]) {
        assert.match(template, /match slug "~\^" "speaker-"/);
        assert.doesNotMatch(template, /講師：\{\{primary_author\.name\}\}/);
    }
    assert.doesNotMatch(author, /講師：|担当した講義/);
    assert.match(await readThemeFile('tag.hbs'), /\{\{#tag\}\}[\s\S]*\{\{name\}\}[\s\S]*\{\{\/tag\}\}/);
    assert.match(author, /投稿者別ページは使用していません/);
    assert.doesNotMatch(author, /\{\{(?:name|bio)\}\}|\{\{#foreach posts/);

    const template = await readRepoFile('docs/templates/lecture-post-template.md');
    const runbook = await readRepoFile('docs/runbooks/content-publish.md');
    for (const document of [template, runbook]) {
        assert.match(document, /#lecture/);
        assert.match(document, /speaker-/);
        assert.match(document, /topic-/);
        assert.match(document, /year-/);
    }
});

test('installation docs require routes upload separate from the theme with backup and rollback', async () => {
    const readme = await readThemeFile('README.md');
    assert.match(readme, /テーマZIPとは別/);
    assert.match(readme, /routes\.yaml/);
    assert.match(readme, /バックアップ/);
    assert.match(readme, /再アップロードして戻/);
});

test('MVP navigation is theme-owned and state-aware CTAs use safe Portal routes', async () => {
    const header = await readThemeFile('partials/site-header.hbs');
    const footer = await readThemeFile('partials/site-footer.hbs');
    const home = await readThemeFile('home.hbs');
    const memberState = await readThemeFile('partials/member-state.hbs');
    const protectedCta = await readThemeFile('partials/protected-cta.hbs');
    const membership = await readThemeFile('page-membership.hbs');
    const readme = await readThemeFile('README.md');

    for (const template of [header, footer]) {
        assert.doesNotMatch(template, /\{\{>?navigation\b/);
    }
    assert.match(readme, /hard-codedリンクを正本/);
    assert.match(readme, /Ghost Adminの \*\*Settings > Site > Navigation\*\* を変更しても本テーマには反映されない/);

    for (const [label, route] of [
        ['活動紹介', '/about/'],
        ['レクチャー', '/lectures/'],
        ['会員案内・料金', '/membership/'],
        ['FAQ', '/faq/']
    ]) {
        assert.match(header, new RegExp(`href="\\{\\{@site\\.url\\}\\}${route}">${label}<\\/a>`));
    }
    assert.match(header, /href="\{\{@site\.url\}\}" aria-label="\{\{@site\.title\}\} トップ"/);
    assert.match(header, /href="#\/search" data-ghost-search>講義を検索<\/a>/);

    for (const [label, route] of [
        ['お問い合わせ', '/contact/'],
        ['利用規約', '/terms/'],
        ['プライバシー', '/privacy/'],
        ['特商法表示', '/legal-commerce/'],
        ['運営者情報', '/about/']
    ]) {
        assert.match(footer, new RegExp(`href="\\{\\{@site\\.url\\}\\}${route}">${label}<\\/a>`));
    }

    assert.match(header, /\{\{else\}\}\s*<li><a[^>]+href="#\/portal\/signup">再入会<\/a><\/li>/);
    assert.doesNotMatch(header, /ライブラリを確認/);
    for (const template of [home, protectedCta, membership]) {
        assert.match(template, /href="#\/portal\/signup">[^<]*再入会<\/a>/);
    }
    for (const template of [header, home, protectedCta]) {
        assert.match(template, /href="#\/portal\/account">アカウント(?:を確認)?<\/a>/);
    }
    assert.equal((memberState.match(/href="#\/portal\/signup">再入会<\/a>/g) ?? []).length, 2);
});

test('subscription state, server-side tag limits and contextual pagination are present', async () => {
    const memberState = await readThemeFile('partials/member-state.hbs');
    assert.match(memberState, /\{\{#foreach @member\.subscriptions\}\}/);
    assert.ok(memberState.indexOf('{{#foreach @member.subscriptions}}') < memberState.indexOf('{{#unless @member.paid}}'));
    assert.match(memberState, /match status "paused"/);
    assert.ok(memberState.indexOf('match status "unpaid"') < memberState.indexOf('{{#if cancel_at_period_end}}'));
    assert.ok(memberState.indexOf('match status "past_due"') < memberState.indexOf('{{#if cancel_at_period_end}}'));

    const packageJson = JSON.parse(await readThemeFile('package.json'));
    assert.equal(packageJson.config.custom.show_related_lectures.default, false);

    const filters = await readThemeFile('partials/lecture-filters.hbs');
    assert.equal((filters.match(/limit="100"/g) ?? []).length, 3);
    assert.doesNotMatch(filters, /limit="all"/);
    assert.match(filters, /filter="slug:~\^'year-'"/);
    assert.match(filters, /filter="slug:~\^'topic-'"/);
    assert.match(filters, /filter="slug:~\^'speaker-'"/);
    assert.doesNotMatch(filters, /slug:(?:year|topic|speaker)-\*/);

    const pagination = await readThemeFile('partials/pagination.hbs');
    assert.match(pagination, /label/);
    assert.match(await readThemeFile('lectures.hbs'), /\{\{> "pagination" label="講義"\s*\}\}/);
    assert.match(await readThemeFile('index.hbs'), /\{\{> "pagination" label="お知らせ"\s*\}\}/);

    const lectures = await readThemeFile('lectures.hbs');
    assert.match(lectures, /\{\{#unless @member\.paid\}\}[\s\S]*protected-cta/);
    assert.doesNotMatch(lectures, /現在のアカウントでは本文を閲覧できません/);
    assert.match(await readThemeFile('tag.hbs'), /\{\{#foreach posts visibility="paid"\}\}/);
    assert.doesNotMatch(await readThemeFile('author.hbs'), /\{\{#foreach posts/);
});

test('responsive embeds and deterministic archive allowlist are guarded', async () => {
    const css = await readThemeFile('assets/css/screen.css');
    const js = await readThemeFile('assets/js/site.js');
    const build = await readThemeFile('scripts/build-theme.mjs');
    assert.match(css, /aspect-ratio:\s*16\s*\/\s*9/);
    assert.doesNotMatch(css, /\.gh-content iframe\s*\{[^}]*min-height/s);
    assert.match(js, /allowfullscreen/);
    assert.match(js, /focusableSelector/);
    assert.match(build, /new Date\(1980, 0, 1, 0, 0, 0\)/);
    assert.doesNotMatch(build, /new Date\('1980-01-01T00:00:00Z'\)/);
    assert.match(build, /node_modules/);
    assert.match(build, /scripts/);
    assert.match(build, /tests/);
    assert.match(build, /requiredEntries/);
    assert.match(build, /\[gscanPath, themeRoot\]/);
    assert.doesNotMatch(build, /\[gscanPath, outputPath, ['"]--zip['"]\]/);
    assert.ok(build.indexOf('if (gscan.status !== 0)') < build.indexOf('await writeFile(outputPath, archive)'));
});

test('fixed ZIP timestamp produces identical bytes across representative time zones', () => {
    const program = [
        "import {createHash} from 'node:crypto';",
        "import {zipSync} from 'fflate';",
        "const bytes = new TextEncoder().encode('same-input');",
        "const zip = zipSync({'fixture.txt': bytes}, {level: 9, mtime: new Date(1980, 0, 1, 0, 0, 0)});",
        "process.stdout.write(createHash('sha256').update(zip).digest('hex'));"
    ].join('\n');
    const digestFor = (timeZone) => execFileSync(process.execPath, ['--input-type=module', '--eval', program], {
        cwd: themeRoot,
        env: {...process.env, TZ: timeZone},
        encoding: 'utf8'
    }).trim();
    const digests = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'].map(digestFor);
    assert.equal(new Set(digests).size, 1, `timezone-dependent ZIP digests: ${digests.join(', ')}`);
});

test('public templates do not contain fixed private media URLs', async () => {
    const forbidden = /https?:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be|dropbox\.com|forms\.gle|docs\.google\.com\/forms)/i;
    const files = ['default.hbs', 'home.hbs', 'index.hbs', 'lectures.hbs', 'post.hbs', 'page-welcome.hbs', 'tag.hbs', 'author.hbs'];
    for (const file of files) assert.doesNotMatch(await readThemeFile(file), forbidden, file);
});
