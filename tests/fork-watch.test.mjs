// Offline test of .github/scripts/fork-watch.js with a mocked Octokit (no network).
// Run: node tests/fork-watch.test.mjs   (also part of `npm run test:tooling`)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forkWatch = require(path.join(ROOT, '.github', 'scripts', 'fork-watch.js'));
const CONFIG = path.join(ROOT, '.github', 'watched-forks.json');

const NOW = new Date('2026-10-26T05:43:00Z');
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString();
const sha = (c) => c.repeat(40).slice(0, 40);
const httpError = (status, message = `HTTP ${status}`, headers = {}) => Object.assign(new Error(message), { status, response: { status, headers } });
const commit = (s, date, message, login = 'dev') => ({ sha: s, html_url: `https://github.com/x/y/commit/${s}`, author: { login }, commit: { message, committer: { date }, author: { name: login, date } } });

// world: { repos: {full: meta|Error}, forks: {full: [meta]|Error}, commits: {"full|path": [commit]|Error}, issues: [], labels: Set }
function mockGithub(world) {
    const calls = [];
    const wrap = (name, fn) => async (params) => {
        calls.push({ name, params });
        const out = await fn(params || {});
        if (out instanceof Error) throw out;
        return out;
    };
    const full = (p) => `${p.owner}/${p.repo}`;
    const github = {
        rest: {
            rateLimit: { get: wrap('rateLimit.get', () => ({ data: { resources: { core: { remaining: world.remaining ?? 4999 } } } })) },
            repos: {
                get: wrap('repos.get', (p) => world.repos[full(p)] instanceof Error ? world.repos[full(p)] : world.repos[full(p)] ? { data: world.repos[full(p)] } : httpError(404, 'Not Found')),
                listForks: wrap('repos.listForks', (p) => {
                    const f = world.forks[full(p)];
                    if (f instanceof Error) return f;
                    return { data: (f || []).slice((p.page - 1) * 100, p.page * 100) };
                }),
                listCommits: wrap('repos.listCommits', (p) => {
                    const c = world.commits[`${full(p)}|${p.path}`];
                    if (c instanceof Error) return c;
                    return { data: (c || []).filter((x) => x.commit.committer.date >= p.since) };
                }),
            },
            issues: {
                listForRepo: wrap('issues.listForRepo', () => ({ data: world.issues })),
                getLabel: wrap('issues.getLabel', (p) => (world.labels.has(p.name) ? { data: { name: p.name } } : httpError(404))),
                createLabel: wrap('issues.createLabel', (p) => {
                    world.labels.add(p.name);
                    return { data: p };
                }),
                create: wrap('issues.create', (p) => ({ data: { number: 7, ...p } })),
                update: wrap('issues.update', (p) => ({ data: p })),
                createComment: wrap('issues.createComment', (p) => ({ data: p })),
            },
        },
    };
    return { github, calls, writes: () => calls.filter((c) => /^issues\.(create|update|createComment|createLabel)$/.test(c.name)) };
}

const core = { info() {}, warning() {}, summary: { addRaw() { return this; }, async write() {} } };
const context = { repo: { owner: '0rpi', repo: 'twitch-adblock-userscript' } };
const run = (github, extra = {}) => forkWatch({ github, context, core, configPath: CONFIG, now: NOW, ...extra });

function baseWorld() {
    return {
        repos: {
            'pixeltris/TwitchAdSolutions': { full_name: 'pixeltris/TwitchAdSolutions', archived: true, pushed_at: '2026-03-05T00:00:00Z' },
            'Wibias/twitch-adblock-userscript': { full_name: 'Wibias/twitch-adblock-userscript', archived: false, pushed_at: daysAgo(1) },
        },
        forks: {
            '0rpi/twitch-adblock-userscript': [
                { full_name: 'alice/twitch-adblock-userscript', pushed_at: daysAgo(2) },
                { full_name: 'bob/twitch-adblock-userscript', pushed_at: daysAgo(40) },
                { full_name: 'gone/twitch-adblock-userscript', pushed_at: daysAgo(3) },
            ],
            'pixeltris/TwitchAdSolutions': [{ full_name: 'carol/TwitchAdSolutions', pushed_at: daysAgo(4) }],
        },
        commits: {
            '0rpi/twitch-adblock-userscript|twitch-adblock.user.js': [commit(sha('0'), daysAgo(2), 'ours: 37.4.0')],
            'Wibias/twitch-adblock-userscript|twitch-adblock.user.js': [
                commit(sha('a'), daysAgo(1), 'Fix worker | timeout\n\nlong body'),
                commit(sha('b'), daysAgo(20), 'too old'),
            ],
            'alice/twitch-adblock-userscript|twitch-adblock.user.js': [commit(sha('0'), daysAgo(2), 'ours: 37.4.0'), commit(sha('c'), daysAgo(2), 'alice <tweak>')],
            'alice/twitch-adblock-userscript|vaft': [],
            'gone/twitch-adblock-userscript|twitch-adblock.user.js': httpError(404, 'Not Found'),
            'carol/TwitchAdSolutions|vaft': [commit(sha('d'), daysAgo(4), 'vaft: new ad signifier, thanks @pixeltris (fixes #12, GH-3)')],
        },
        issues: [],
        labels: new Set(),
    };
}

// 1) First run: issue + label created, own/old commits excluded, 404 noted, archived skipped.
{
    const world = baseWorld();
    const { github, calls, writes } = mockGithub(world);
    const res = await run(github);
    assert.deepEqual(res.findings.map((f) => f.sha[0]).sort(), ['a', 'c', 'd']);
    assert.equal(res.newFindings.length, 3);
    const created = calls.find((c) => c.name === 'issues.create');
    assert.ok(created, 'issue created');
    assert.deepEqual(created.params.labels, ['upstream-watch']);
    assert.match(created.params.body, new RegExp(`/commit/${sha('a')}`));
    assert.ok(!created.params.body.includes(sha('0')), 'own commit excluded');
    assert.ok(!created.params.body.includes(sha('b')), 'commit outside window excluded');
    assert.match(created.params.body, /Fix worker \\\| timeout/, 'pipes escaped, first line only');
    assert.ok(!created.params.body.includes('long body'));
    assert.match(created.params.body, /alice &lt;tweak>/, 'html escaped');
    assert.ok(!/@pixeltris|#12|GH-3/.test(created.params.body), 'mentions / issue refs neutralized');
    assert.ok(created.params.body.includes('@\u200bpixeltris'));
    assert.match(created.params.body, /gone\/twitch-adblock-userscript \(twitch-adblock\.user\.js\): not found/);
    assert.match(created.params.body, /pixeltris\/TwitchAdSolutions: no push since 2026-03-05 \(archived\)/);
    assert.ok(calls.some((c) => c.name === 'issues.createLabel'), 'label created');
    assert.ok(!calls.some((c) => c.name === 'repos.listCommits' && c.params.owner === 'bob'), 'stale fork not queried');
    assert.equal(writes().filter((c) => c.name === 'issues.createComment').length, 0);
}

// 2) Next run with the issue open: body refreshed, comment lists only new commits.
{
    const world = baseWorld();
    world.labels.add('upstream-watch');
    world.issues = [{ number: 3, body: `old report https://github.com/x/y/commit/${sha('a')}` }, { number: 4, pull_request: {} }];
    const { github, calls } = mockGithub(world);
    const res = await run(github);
    assert.equal(res.issueNumber, 3);
    assert.deepEqual(res.newFindings.map((f) => f.sha[0]).sort(), ['c', 'd']);
    const update = calls.find((c) => c.name === 'issues.update');
    assert.equal(update.params.issue_number, 3);
    const comment = calls.find((c) => c.name === 'issues.createComment');
    assert.ok(comment && !comment.params.body.includes(sha('a')) && comment.params.body.includes(sha('d').slice(0, 7)));
    assert.ok(!calls.some((c) => c.name === 'issues.create' || c.name === 'issues.createLabel'));
}

// 3) Nothing in the window: no issue writes at all.
{
    const world = baseWorld();
    world.commits = {};
    const { github, writes } = mockGithub(world);
    const res = await run(github);
    assert.equal(res.findings.length, 0);
    assert.equal(writes().length, 0);
}

// 4) Rate limited mid-run: partial result, no crash, no further commit reads.
{
    const world = baseWorld();
    world.forks['0rpi/twitch-adblock-userscript'] = httpError(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' });
    const { github, calls } = mockGithub(world);
    const res = await run(github, { dryRun: true });
    assert.ok(res.notes.some((n) => /rate limited/.test(n)));
    assert.ok(!calls.some((c) => c.name === 'repos.listCommits'), 'no reads after rate limit');
}

// 4b) Rate limited mid-run, not a dry run, issue #3 open: no duplicate issue, #3 not overwritten with partial results.
{
    const world = baseWorld();
    world.labels.add('upstream-watch');
    world.issues = [{ number: 3, body: `old report https://github.com/x/y/commit/${sha('a')}` }];
    world.commits['alice/twitch-adblock-userscript|twitch-adblock.user.js'] = httpError(403, 'You have exceeded a secondary rate limit');
    const { github, calls, writes } = mockGithub(world);
    const res = await run(github);
    assert.ok(res.findings.length > 0, 'something was found before the limit');
    assert.ok(calls.some((c) => c.name === 'issues.listForRepo'), 'open issue still looked up');
    assert.equal(res.issueNumber, 3);
    assert.equal(res.issueSkipped, true);
    assert.deepEqual(writes(), [], 'no issue/label/comment writes');
    assert.ok(!calls.some((c) => c.name === 'issues.getLabel'));
}

// 4c) Issue lookup fails (transient 502): no duplicate issue.
{
    const world = baseWorld();
    const { github, writes } = mockGithub(world);
    github.rest.issues.listForRepo = async () => { throw httpError(502, 'Bad Gateway'); };
    const res = await run(github);
    assert.ok(res.findings.length > 0);
    assert.equal(res.issueSkipped, true);
    assert.ok(res.notes.some((n) => /open upstream-watch issue: error 502/.test(n)));
    assert.deepEqual(writes(), []);
}

// 4d) Primary quota runs out at the label check: partial, no crash.
{
    const world = baseWorld();
    const { github, writes } = mockGithub(world);
    github.rest.issues.getLabel = async () => { throw httpError(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }); };
    const res = await run(github);
    assert.equal(res.issueSkipped, true);
    assert.ok(res.notes.some((n) => /rate limited while writing the issue/.test(n)));
    assert.deepEqual(writes(), []);
}

// 5) Low quota up front: skip the run cleanly. Dry run never writes.
{
    const world = baseWorld();
    world.remaining = 5;
    const low = mockGithub(world);
    assert.equal((await run(low.github)).skipped, true);
    const dry = mockGithub(baseWorld());
    const res = await run(dry.github, { dryRun: true });
    assert.equal(res.findings.length, 3);
    assert.equal(dry.writes().length, 0);
}

// 6) Watched repo deleted / renamed: noted, other repos still checked.
{
    const world = baseWorld();
    delete world.repos['Wibias/twitch-adblock-userscript'];
    const { github } = mockGithub(world);
    const res = await run(github, { dryRun: true });
    assert.ok(res.notes.some((n) => /Wibias\/twitch-adblock-userscript: not found/.test(n)));
    assert.deepEqual(res.findings.map((f) => f.sha[0]).sort(), ['c', 'd']);
}

console.log('fork-watch: OK');
