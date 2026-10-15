const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, after } = require('node:test');
const tempRoot = path.resolve(os.tmpdir());
const prefix = path.resolve(tempRoot, 'farm-main-workflow-');
assert.ok(prefix.startsWith(tempRoot + path.sep));
const root = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = root;
const { runMainOwnedWorkflow } = require('../src/services/evolution-main-workflow');
const { createTeamError } = require('../src/services/evolution-team');
const sourceFiles = [__filename, '../src/services/evolution-main-workflow.js', '../scripts/run-evolution-team.js',
    '../src/services/evolution-team.js'].map(file => path.resolve(__dirname, file));
const fingerprint = () => sourceFiles.map(file => ({ file, mode: fs.statSync(file).mode & 0o777,
    hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = fingerprint();
after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); }
    finally { assert.deepEqual(fingerprint(), before); }
});
const HEAD = 'a'.repeat(40);
const FILE = 'core/src/example.js';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
let number = 0;
function fixture() {
    const directory = path.resolve(root, `case-${++number}`);
    assert.ok(directory.startsWith(root + path.sep));
    fs.mkdirSync(directory);
    const files = new Map([[FILE, 'original']]);
    const original = new Map(files);
    let head = HEAD;
    let handler;
    let closed = 0;
    let commits = 0;
    let verifies = 0;
    const checkpoints = [];
    const progress = [];
    const f = {
        directory, files, checkpoints, progress,
        plan: { summary: 'Change one exact caller', allowedFiles: [FILE], acceptanceChecks: ['caller behavior'], baselineChecks: [] },
        call: (name, args = {}) => handler(name, args, {}),
        edit: (file, text) => files.set(file, text),
        get closed() { return closed; }, get commits() { return commits; }, get verifies() { return verifies; },
        moveHead: () => { head = 'c'.repeat(40); },
    };
    f.options = {
        settings: { mainAgent: 'codex', subAgent: 'claude' }, prompt: 'task', baseCommit: HEAD,
        task: 'activity', dataDir: directory, logDir: path.join(directory, 'logs'), runId: 'fixture', roundId: 'round',
        inspect: async () => {
            const changed = [...new Set([...files.keys(), ...original.keys()])].filter(file => files.get(file) !== original.get(file));
            return { head, files: changed, dirty: !!changed.length, fingerprint: sha(JSON.stringify([...files])),
                fileFingerprints: Object.fromEntries(changed.map(file => [file, sha(files.get(file) || '')])) };
        },
        verify: async () => { verifies += 1; return { fingerprint: 'd'.repeat(64), checkedAt: 1,
            checks: ['backend', 'frontend'], countercheck: { state: 'not_required', checks: [] } }; },
        commit: async () => { commits += 1; return 'b'.repeat(40); },
        onCheckpoint: async value => checkpoints.push(JSON.parse(JSON.stringify(value))),
        onProgress: async (phase, agent, details) => progress.push({ phase, agent, ...details }),
        createBridge: async options => { handler = options.handler; return {
            mcp: { command: 'fixture', args: [] }, close: async () => { closed += 1; },
        }; },
        runWorker: async () => ({ decision: 'no_change', summary: 'Nothing changed' }),
        runMain: async () => { throw new Error('assign a Main test'); },
    };
    return f;
}
async function accept(f, decision = 'approve') {
    assert.equal((await f.call('verify_candidate')).isError, false);
    const seal = await f.call('accept_result', { decision, summary: 'Main checked actual results', lessons: [], feedbackReviewed: false, githubResolutions: [] });
    assert.equal(seal.isError, false);
    return { decision: JSON.parse(seal.content[0].text).decision, summary: 'Main finished' };
}

test('one Main receives a worker CLI failure, repairs its scope directly, validates and accepts', async () => {
    const f = fixture();
    let mainCalls = 0;
    f.options.runWorker = async () => { f.edit(FILE, 'partial'); throw createTeamError('cli_exit', { exitCode: 1 }); };
    f.options.runMain = async () => {
        mainCalls += 1;
        assert.equal((await f.call('approve_plan', f.plan)).isError, false);
        assert.equal((await f.call('delegate_worker', { instruction: 'Fix the caller', allowedFiles: [FILE] })).isError, true);
        assert.equal(f.files.get(FILE), 'partial');
        f.edit(FILE, 'Main repaired');
        return accept(f);
    };
    const result = await runMainOwnedWorkflow(f.options);
    assert.equal(result.decision, 'approve');
    assert.equal(mainCalls, 1); assert.equal(f.commits, 1); assert.equal(f.verifies, 1); assert.equal(f.closed, 1);
    assert.ok(f.progress.every(item => item.agent === 'codex'), 'Main remains the only active owner');
    assert.equal(f.progress.some(item => item.phase === 'repair' || item.phase === 'diagnose'), false);
});

test('missing approval cannot delegate writes; Main may verify a real clean no_change', async () => {
    const f = fixture();
    f.options.runWorker = async () => { assert.fail('unapproved worker must not start'); };
    f.options.runMain = async () => {
        assert.equal((await f.call('delegate_worker', { instruction: 'write' })).isError, true);
        return accept(f, 'no_change');
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'no_change');
    assert.equal(f.commits, 0);
});

test('any edit after verification/seal prevents commit and leaves the draft', async () => {
    const f = fixture();
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        f.edit(FILE, 'first candidate');
        const final = await accept(f);
        f.edit(FILE, 'late candidate');
        return final;
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'worktree_changed' });
    assert.equal(f.commits, 0); assert.equal(f.files.get(FILE), 'late candidate'); assert.equal(f.closed, 1);
});

test('context and worker replies are bounded while the full original task stays private', async () => {
    const f = fixture();
    const wholeTask = `【真实原任务】\n${'large private task evidence\n'.repeat(5000)}`;
    f.options.prompt = wholeTask;
    f.options.handoffDirective = 'CURRENT HANDOFF ONCE';
    f.options.runWorker = async ({ prompt }) => {
        assert.ok(prompt.length <= 6000);
        return { decision: 'implemented', summary: 'evidence '.repeat(2500) };
    };
    f.options.runMain = async ({ prompt }) => {
        assert.ok(prompt.length <= 48 * 1024);
        assert.equal(prompt.split('CURRENT HANDOFF ONCE').length - 1, 1);
        const status = JSON.parse((await f.call('status')).content[0].text);
        assert.equal(fs.readFileSync(status.originalTask, 'utf8'), wholeTask);
        assert.equal(fs.statSync(status.originalTask).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(status.originalTask)).mode & 0o777, 0o700);
        await f.call('approve_plan', f.plan);
        const worker = await f.call('delegate_worker', { instruction: 'i'.repeat(6000), allowedFiles: [FILE] });
        assert.equal(worker.isError, false);
        assert.ok(worker.content[0].text.length <= 6000);
        const full = JSON.parse(fs.readFileSync(JSON.parse(worker.content[0].text).artifact, 'utf8'));
        assert.ok(full.summary.length > 6000);
        assert.equal(fs.readFileSync(path.join(f.directory, 'logs/main-fixture/worker-1-instruction.txt'), 'utf8').length, 6000);
        return accept(f, 'no_change');
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'no_change');
});

test('Main inherits all 29 files and 20 checks and preserves a partial direct edit across a crash', async () => {
    const f = fixture();
    f.plan.allowedFiles = [FILE, ...Array.from({ length: 28 }, (_, index) => `core/src/approved-${index}.js`)];
    f.plan.acceptanceChecks = Array.from({ length: 20 }, (_, index) => `Original contract check ${index}`);
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        f.edit(FILE, 'partial direct edit');
        throw createTeamError('cli_exit', { exitCode: 1 });
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'cli_exit' });
    const checkpoint = f.checkpoints.at(-1);
    assert.deepEqual(checkpoint.approvedScope, [...f.plan.allowedFiles].sort());
    assert.deepEqual(checkpoint.acceptanceChecks, f.plan.acceptanceChecks);
    assert.equal(checkpoint.fileFingerprints[FILE], sha('partial direct edit'));
    assert.equal(checkpoint.verifiedFingerprint, '');
    f.options.resume = checkpoint;
    f.options.runWorker = async () => { assert.fail('existing contract does not require another worker/research stage'); };
    f.options.runMain = async ({ prompt }) => {
        assert.ok(prompt.includes('Original contract check 19') && prompt.includes('approved-27.js'));
        const weakened = { ...f.plan, acceptanceChecks: ['weakened'] };
        assert.equal((await f.call('approve_plan', weakened)).isError, true);
        assert.equal((await f.call('approve_plan', { ...f.plan, allowedFiles: [FILE] })).isError, true, 'a prior draft scope cannot be silently narrowed');
        f.edit(FILE, 'complete direct edit');
        return accept(f);
    };
    const result = await runMainOwnedWorkflow(f.options);
    assert.equal(result.decision, 'approve');
    assert.deepEqual(f.checkpoints.at(-1).taskIdentity, checkpoint.taskIdentity);
    assert.deepEqual(f.checkpoints.at(-1).acceptanceChecks, checkpoint.acceptanceChecks);
    assert.equal(f.commits, 1);
});

test('read-only worker mutations and unapproved files remain blocked without rolling back drafts', async () => {
    for (const readOnly of [false, true]) {
        const f = fixture();
        f.options.runWorker = async () => {
            f.edit(readOnly ? FILE : 'core/src/other.js', 'must remain visible');
            return { decision: 'implemented', summary: 'claimed change' };
        };
        f.options.runMain = async () => {
            if (!readOnly) await f.call('approve_plan', f.plan);
            const worker = await f.call('delegate_worker', { instruction: 'one task', readOnly, allowedFiles: readOnly ? [] : [FILE] });
            assert.equal(worker.isError, true);
            return { decision: 'no_change', summary: 'not a valid approval' };
        };
        await assert.rejects(runMainOwnedWorkflow(f.options), { code: readOnly ? 'readonly_changed' : 'repair_scope' });
        assert.equal(f.commits, 0);
        assert.equal(f.files.get(readOnly ? FILE : 'core/src/other.js'), 'must remain visible');
    }
});

test('mutating tools exclude concurrency; a Main failure aborts and waits for its worker before closing', async () => {
    const f = fixture();
    let workerExited = false;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    f.options.runWorker = ({ signal }) => new Promise((_, reject) => {
        started();
        signal.addEventListener('abort', () => { workerExited = true; reject(createTeamError('cli_exit')); }, { once: true });
    });
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        void f.call('delegate_worker', { instruction: 'wait for cancellation', allowedFiles: [FILE] });
        await ready;
        const competing = await f.call('verify_candidate');
        assert.equal(JSON.parse(competing.content[0].text).code, 'busy');
        throw createTeamError('cli_exit', { exitCode: 1 });
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'cli_exit' });
    assert.equal(workerExited, true);
    assert.equal(f.closed, 1);
    assert.equal(f.commits, 0);
});

test('dirty no_change and incomplete coordinator evidence never create a seal', async () => {
    for (const badEvidence of [false, true]) {
        const f = fixture();
        if (badEvidence) f.options.verify = async () => ({ countercheck: { state: 'not_required' } });
        f.options.runMain = async () => {
            await f.call('approve_plan', f.plan);
            f.edit(FILE, 'real draft');
            const verified = await f.call('verify_candidate');
            if (badEvidence) assert.equal(verified.isError, true);
            const rejected = await f.call('accept_result', { decision: 'no_change', summary: 'ignore a draft' });
            assert.equal(rejected.isError, true);
            return { decision: 'no_change', summary: 'cannot approve' };
        };
        await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'review_rejected' });
        assert.equal(f.commits, 0); assert.equal(f.files.get(FILE), 'real draft');
    }
});

test('same-round checkpoint keeps the bounded worker invocation limit without blocking Main repair', async () => {
    const f = fixture();
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        for (let i = 0; i < 12; i += 1) assert.equal((await f.call('delegate_worker', { instruction: 'Read one caller', readOnly: true })).isError, false);
        throw createTeamError('cli_exit');
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'cli_exit' });
    const checkpoint = f.checkpoints.at(-1);
    const { normalizeCheckpoint } = require('../src/services/evolution-team');
    assert.equal(normalizeCheckpoint(checkpoint).mainWorkflow.workerInvocations, 12);
    f.options.resume = checkpoint;
    f.options.runMain = async () => {
        const refused = await f.call('delegate_worker', { instruction: 'Cannot refresh the same-round limit' });
        assert.equal(JSON.parse(refused.content[0].text).code, 'recovery_exhausted');
        f.edit(FILE, 'Main still owns its small authorized repair');
        return accept(f);
    };
    assert.equal((await runMainOwnedWorkflow(f.options)).decision, 'approve');
});

test('unproven child cleanup blocks the whole Main and remains blocked after normalization', async () => {
    const f = fixture();
    f.options.runWorker = async () => { throw createTeamError('unsafe_worktree'); };
    f.options.runMain = async () => {
        await f.call('approve_plan', f.plan);
        assert.equal((await f.call('delegate_worker', { instruction: 'Unsafe cleanup must stop this run' })).isError, true);
        return { decision: 'approve', summary: 'Cannot override unsafe child ownership' };
    };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'unsafe_worktree' });
    const { normalizeCheckpoint } = require('../src/services/evolution-team');
    const checkpoint = normalizeCheckpoint(f.checkpoints.at(-1));
    assert.equal(checkpoint.mainWorkflow.blocked, 'unsafe_worktree');
    f.options.resume = checkpoint;
    f.options.runMain = async () => { assert.fail('an unproven writer cannot be bypassed by a fresh Main'); };
    await assert.rejects(runMainOwnedWorkflow(f.options), { code: 'unsafe_worktree' });
    assert.equal(f.commits, 0);
});
