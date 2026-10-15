const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    parseStageResult, normalizeCheckpoint, createTeamError, normalizeTeamFailure,
    normalizeOrchestrationFiles, buildStageSchema, FULL_HANDOFF_MANDATE, safeReviewFeedback,
} = require('./evolution-team');

const CONTEXT_LIMIT = 48 * 1024;
const TOOL_LIMIT = 6000;
const CONTROL_FILES = new Set([
    'core/src/services/evolution-main-workflow.js', 'core/src/services/evolution-main-mcp.js',
    'core/scripts/run-evolution-main-mcp.js',
]);
const MAIN_RESULT_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: { decision: { type: 'string', enum: ['approve', 'no_change'] },
        summary: { type: 'string', minLength: 1, maxLength: TOOL_LIMIT } },
    required: ['decision', 'summary'],
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));

function artifactWriter(logDir, dataDir, runId) {
    const root = path.resolve(dataDir);
    const logs = path.resolve(logDir);
    if (!/^[\w-]{1,100}$/.test(runId) || (logs !== root && !logs.startsWith(`${root}${path.sep}`))) {
        throw createTeamError('unsafe_worktree');
    }
    const directory = path.join(logs, `main-${runId}`);
    const check = target => {
        const full = path.resolve(target);
        if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw createTeamError('unsafe_worktree');
        let current = path.parse(full).root;
        for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
            current = path.join(current, part);
            try { if (fs.lstatSync(current).isSymbolicLink()) throw createTeamError('unsafe_worktree'); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return full;
    };
    fs.mkdirSync(check(directory), { recursive: true, mode: 0o700 });
    fs.chmodSync(check(directory), 0o700);
    return (name, text) => {
        if (!/^[\w.-]{1,100}$/.test(name) || name.includes('..')) throw createTeamError('unsafe_worktree');
        const file = check(path.join(directory, name));
        const temporary = check(`${file}.${crypto.randomUUID()}.tmp`);
        try {
            fs.writeFileSync(temporary, String(text), { mode: 0o600, flag: 'wx' });
            fs.renameSync(temporary, file);
        } finally { try { fs.unlinkSync(temporary); } catch {} }
        return file;
    };
}

function mainTools() {
    const strings = { type: 'array', items: { type: 'string' }, maxItems: 30 };
    const empty = { type: 'object', properties: {}, additionalProperties: false };
    const review = buildStageSchema('review').properties;
    return [
        { name: 'status', description: 'Read the trusted current contract, draft, last worker failure and validation identity.', inputSchema: empty },
        { name: 'approve_plan', description: 'Main approves an exact writable scope and executable contract before implementation.', inputSchema: {
            type: 'object', additionalProperties: false,
            properties: { summary: { type: 'string', maxLength: TOOL_LIMIT }, allowedFiles: strings,
                acceptanceChecks: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 1000 } },
                baselineChecks: buildStageSchema('plan').properties.baselineChecks },
            required: ['summary', 'allowedFiles', 'acceptanceChecks', 'baselineChecks'],
        } },
        { name: 'delegate_worker', description: 'Ask the selected implementation tool for one bounded task; failures return here to the same Main.', inputSchema: {
            type: 'object', additionalProperties: false,
            properties: { instruction: { type: 'string', minLength: 1, maxLength: TOOL_LIMIT }, allowedFiles: strings,
                readOnly: { type: 'boolean' } }, required: ['instruction'],
        } },
        { name: 'verify_candidate', description: 'Run the coordinator-owned full verification and registered baseline counterchecks for the actual candidate.', inputSchema: empty },
        { name: 'accept_result', description: 'Main accepts only the currently verified candidate; creates a seal, never commits or publishes.', inputSchema: {
            type: 'object', additionalProperties: false,
            properties: { decision: MAIN_RESULT_SCHEMA.properties.decision, summary: MAIN_RESULT_SCHEMA.properties.summary,
                lessons: review.lessons, feedbackReviewed: { type: 'boolean' }, githubResolutions: review.githubResolutions },
            required: ['decision', 'summary'],
        } },
    ];
}

/** One Main owns one native tool loop; approvals and validation stay in this process. */
async function runMainOwnedWorkflow({ settings, prompt, baseCommit, task = 'safety', logDir, dataDir, runId,
    roundId = '', taskIdentity, resume = null, inspect, verify, commit, onProgress = async () => {},
    onCheckpoint = async () => {}, runMain, runWorker, handoffDirective = '', signal,
    createBridge, initialFailure = null, initialReviewFeedback = '' }) {
    const initial = await inspect();
    if (initial.head !== baseCommit) throw createTeamError('head_changed');
    const inherited = resume ? normalizeCheckpoint(resume) : null;
    if (resume && !inherited) throw createTeamError('invalid_decision');
    if (initial.dirty && !inherited) throw createTeamError('unsafe_worktree');
    const writeArtifact = artifactWriter(logDir, dataDir, runId);
    const taskFile = writeArtifact('original-task.txt', String(prompt));
    const completed = new Map((inherited?.completed || []).map(item => [item.phase, item]));
    let contract = inherited?.approvedScope?.length ? {
        allowedFiles: [...inherited.approvedScope], acceptanceChecks: [...inherited.acceptanceChecks],
        baselineChecks: inherited.kind === 'post_apply' ? [] : inherited.baselineChecks,
    } : null;
    const originalContract = contract ? copy(contract) : null;
    const authorized = new Set(inherited?.allowedFiles || []);
    const sameRound = !!roundId && inherited?.roundId === roundId;
    let runtimeRecoveryAttempt = sameRound ? inherited.counters.runtimeRecoveryAttempt : 0;
    let reviewRecoveryAttempt = sameRound ? inherited.counters.reviewRecoveryAttempt : 0;
    const planRevision = sameRound ? inherited.counters.planRevision : 0;
    const auditCounters = { runtimeRecoveryAttempt: 0, reviewRecoveryAttempt: 0, planRevision: 0, rounds: 0,
        ...inherited?.auditCounters };
    if (inherited && !sameRound) auditCounters.rounds += 1;
    const requiresApply = inherited?.kind !== 'post_apply' && inherited?.requiresApply === true;
    const initialFiles = { ...(initial.fileFingerprints || {}) };
    const identity = taskIdentity || inherited?.taskIdentity || {
        task, promptDigest: digest(String(prompt)), feedbackThroughAt: 0,
        activityPlanDigest: '', githubBatchDigest: '', quotaDate: '', automatic: false, combinedDaily: false,
    };
    const abort = new AbortController();
    const abortOuter = () => abort.abort(signal?.reason);
    if (signal?.aborted) abortOuter();
    else signal?.addEventListener('abort', abortOuter, { once: true });
    let bridge;
    let busy = '';
    let blocked = inherited?.mainWorkflow?.blocked === 'unsafe_worktree' ? createTeamError('unsafe_worktree') : null;
    let validation = null;
    let seal = null;
    let lastFailure = initialFailure || inherited?.lastFailure || null;
    let lastToolFailure = null;
    let reviewFeedback = inherited ? inherited.reviewFeedback : initialReviewFeedback || '';
    let workerInvocations = sameRound ? inherited?.mainWorkflow?.workerInvocations || 0 : 0;
    let replyNumber = 0;
    const pendingWorkers = new Set();
    const pendingOperations = new Set();
    const summary = () => ({ orchestrationMode: 'main_owned', runtimeRecoveryAttempt, reviewRecoveryAttempt,
        planRevision, recoveryAttempt: runtimeRecoveryAttempt, recoveryLimit: 2, lastFailure, reviewFeedback,
        delegatedAgent: busy === 'delegate_worker' ? settings.subAgent : '' });
    const progress = phase => onProgress(phase, settings.mainAgent, summary());
    const invalidate = () => { validation = null; seal = null; };
    const fail = code => {
        blocked = createTeamError(code);
        invalidate();
        if (code === 'unsafe_worktree') abort.abort();
        throw blocked;
    };
    const current = async ({ allowAbort = false } = {}) => {
        if (blocked) throw blocked;
        if (abort.signal.aborted && !allowAbort) throw createTeamError('cli_exit', { signal: 'SIGTERM' });
        const tree = await inspect();
        if (tree.head !== baseCommit) return fail('head_changed');
        if ((tree.files || []).some(file => !authorized.has(file))) return fail('repair_scope');
        const paths = new Set([...Object.keys(initialFiles), ...Object.keys(tree.fileFingerprints || {})]);
        if ([...paths].some(file => initialFiles[file] !== tree.fileFingerprints?.[file]
            && !(contract?.allowedFiles || []).includes(file))) return fail('repair_scope');
        return tree;
    };
    const contractFile = () => writeArtifact('contract.json', JSON.stringify(contract, null, 2));
    let checkpoint;
    const persist = async tree => {
        const actual = tree || await inspect();
        checkpoint = {
            ...inherited, version: 1, kind: 'in_run', baselineHead: baseCommit, taskIdentity: identity, roundId,
            allowedFiles: [...authorized].sort(), approvedScope: [...(contract?.allowedFiles || [])].sort(),
            acceptanceChecks: contract?.acceptanceChecks || [], baselineChecks: contract?.baselineChecks || [],
            fileFingerprints: Object.fromEntries(Object.entries(actual.fileFingerprints || {}).filter(([file]) => authorized.has(file))),
            worktreeFingerprint: actual.fingerprint,
            verifiedFingerprint: validation?.worktreeFingerprint || '',
            verifiedChecks: validation ? JSON.stringify(contract?.baselineChecks || []) : '',
            validationDigest: validation?.digest || '', requiresApply,
            counters: { runtimeRecoveryAttempt, reviewRecoveryAttempt, planRevision }, auditCounters,
            completed: [...completed.values()], lastFailure, reviewFeedback,
            mainWorkflow: { version: 1, workerInvocations,
                ...(blocked?.code === 'unsafe_worktree' ? { blocked: 'unsafe_worktree' } : {}) },
        };
        await onCheckpoint(checkpoint);
    };
    const result = (value, isError = false) => {
        let text = JSON.stringify(value);
        if (text.length > TOOL_LIMIT) {
            const artifact = writeArtifact(`tool-${++replyNumber}.json`, text);
            text = JSON.stringify({ state: value.state, code: value.code, decision: value.decision,
                summary: String(value.summary || '').slice(0, 1200), artifact });
        }
        return { content: [{ type: 'text', text }], isError };
    };
    const operations = {
        status: async () => {
            const tree = await current();
            return { state: 'ready', mode: 'main_owned', busy, mainAgent: settings.mainAgent, subAgent: settings.subAgent,
                originalTask: taskFile, contractFile: contractFile(), allowedFiles: contract?.allowedFiles || [],
                acceptanceCheckCount: contract?.acceptanceChecks.length || 0, changedFiles: tree.files,
                fingerprint: tree.fingerprint, validation: validation ? { fingerprint: validation.worktreeFingerprint } : null,
                lastFailure, ...summary() };
        },
        approve_plan: async args => {
            await current();
            const approved = parseStageResult(JSON.stringify({ ...args, decision: 'approve' }), 'plan');
            if (approved.allowedFiles.some(file => CONTROL_FILES.has(file))) throw createTeamError('repair_scope');
            const proposal = { allowedFiles: approved.allowedFiles, acceptanceChecks: approved.acceptanceChecks,
                baselineChecks: approved.baselineChecks };
            if (originalContract && (proposal.allowedFiles.length !== originalContract.allowedFiles.length
                || proposal.allowedFiles.some(file => !originalContract.allowedFiles.includes(file))
                || JSON.stringify(proposal.acceptanceChecks) !== JSON.stringify(originalContract.acceptanceChecks)
                || JSON.stringify(proposal.baselineChecks) !== JSON.stringify(originalContract.baselineChecks))) {
                throw createTeamError('repair_scope');
            }
            contract = proposal;
            for (const file of contract.allowedFiles) authorized.add(file);
            completed.set('plan', { phase: 'plan', decision: 'approve', summary: approved.summary.slice(0, TOOL_LIMIT) });
            reviewFeedback = '';
            invalidate();
            contractFile();
            await persist();
            await progress('plan');
            return { state: 'approved', allowedFiles: contract.allowedFiles, contractFile: contractFile() };
        },
        delegate_worker: async (args, context) => {
            const before = await current();
            const readOnly = args.readOnly === true;
            if (!readOnly && !contract) throw createTeamError('repair_scope');
            const files = args.allowedFiles ?? (readOnly ? [] : contract.allowedFiles);
            if (!Array.isArray(files) || files.some(file => typeof file !== 'string'
                || (!readOnly && !contract.allowedFiles.includes(file)))) throw createTeamError('repair_scope');
            parseStageResult(JSON.stringify({ decision: 'repair', summary: 'One delegated file scope', allowedFiles: files }), 'diagnose');
            if (runtimeRecoveryAttempt >= 2 || workerInvocations >= 12) throw createTeamError('recovery_exhausted');
            if (typeof args.instruction !== 'string' || !args.instruction.trim() || args.instruction.length > TOOL_LIMIT) throw createTeamError('invalid_decision');
            const invocationId = `worker-${workerInvocations + 1}`;
            const instructionFile = writeArtifact(`${invocationId}-instruction.txt`, args.instruction);
            const scopeFile = writeArtifact(`${invocationId}-scope.json`, JSON.stringify({ allowedFiles: files, readOnly }));
            const prefix = `你是 ${settings.subAgent} 实施工具。只完成主 Agent 这一个委派；不能调用主控工具、提交、推送、重启或请求游戏。\n${readOnly ? '本次只读，禁止修改任何文件。' : `写范围必须逐条遵守私有文件 ${scopeFile} 的 allowedFiles，不得越权。`}\n合同见 ${contractFile()}；用 rg 定位、分段读相关入口，禁止整份大型源码/历史/日志灌入上下文。只回 JSON decision=implemented/no_change 与简短 summary；失败如实交回主 Agent。\n完整具体指令存于 ${instructionFile}，下方如省略必须按该文件的有界片段补读。\n【指令摘录】\n`;
            const available = TOOL_LIMIT - prefix.length - 64;
            if (available < 0) throw createTeamError('output_limit');
            const workerPrompt = `${prefix}${args.instruction.slice(0, available)}${args.instruction.length > available ? '\n[其余指令未注入，继续读取上方私有指令文件。]' : ''}`;
            if (!readOnly) invalidate();
            workerInvocations += 1;
            await persist(before);
            await progress('implement');
            let response;
            let error;
            const workerAbort = new AbortController();
            const cancel = () => workerAbort.abort();
            abort.signal.addEventListener('abort', cancel, { once: true });
            context.signal?.addEventListener('abort', cancel, { once: true });
            if (abort.signal.aborted || context.signal?.aborted) cancel();
            const work = Promise.resolve().then(() => runWorker({ prompt: workerPrompt, allowedFiles: files,
                invocationId, signal: workerAbort.signal }));
            pendingWorkers.add(work);
            try { response = await work; } catch (failure) { error = failure; }
            finally {
                pendingWorkers.delete(work);
                abort.signal.removeEventListener('abort', cancel);
                context.signal?.removeEventListener('abort', cancel);
            }
            if (error?.code === 'unsafe_worktree') return fail('unsafe_worktree');
            const after = await inspect();
            if (after.head !== baseCommit) return fail('head_changed');
            if (readOnly && before.fingerprint !== after.fingerprint) return fail('readonly_changed');
            await current();
            const changed = new Set([...Object.keys(before.fileFingerprints || {}), ...Object.keys(after.fileFingerprints || {})]);
            if ((readOnly && before.fingerprint !== after.fingerprint)
                || [...changed].some(file => before.fileFingerprints?.[file] !== after.fileFingerprints?.[file] && !files.includes(file))) {
                return fail(readOnly ? 'readonly_changed' : 'repair_scope');
            }
            let parsed;
            if (!error) {
                try { parsed = parseStageResult(JSON.stringify(response), 'implement'); }
                catch (failure) { error = failure; }
            }
            if (!error && parsed.decision === 'no_change' && before.fingerprint !== after.fingerprint) error = createTeamError('invalid_decision');
            const artifact = writeArtifact(`${invocationId}.json`, JSON.stringify(error
                ? { failure: normalizeTeamFailure(error, 'implement', settings.subAgent), changedFiles: after.files,
                    logFile: error.logFile || '' }
                : response));
            if (error) {
                runtimeRecoveryAttempt = Math.min(2, runtimeRecoveryAttempt + 1);
                auditCounters.runtimeRecoveryAttempt += 1;
                lastFailure = normalizeTeamFailure(error, 'implement', settings.subAgent);
                lastToolFailure = lastFailure;
                await persist(after);
                await progress('implement');
                return result({ state: 'worker_failed', failure: lastFailure, changedFiles: after.files,
                    artifact, logFile: error.logFile || '',
                    summary: '实施工具失败，现场已保留；由当前主 Agent 决定缩小委派或直接修正。' }, true);
            }
            completed.set('implement', { phase: 'implement', decision: parsed.decision, summary: parsed.summary.slice(0, 2000) });
            await persist(after);
            return { state: 'worker_completed', decision: parsed.decision, summary: parsed.summary.slice(0, 4000),
                artifact, logFile: response.logFile || '' };
        },
        verify_candidate: async () => {
            const before = await current();
            invalidate();
            if (reviewRecoveryAttempt >= 2) throw createTeamError('recovery_exhausted');
            await progress('verify');
            const evidence = await verify({ reviewedOrchestrationFiles: requiresApply
                ? normalizeOrchestrationFiles(contract?.allowedFiles || []) : [], baselineChecks: contract?.baselineChecks || [], baseCommit, signal: abort.signal });
            const after = await current();
            if (after.fingerprint !== before.fingerprint) throw createTeamError('worktree_changed');
            if (!evidence || typeof evidence !== 'object' || (evidence.state !== undefined && evidence.state !== 'passed')
                || !/^[a-f0-9]{64}$/.test(evidence.fingerprint || '')
                || !(evidence.checkedAt > 0) || !['backend', 'frontend'].every(check => evidence.checks?.includes(check))
                || !['passed', ...(!(contract?.baselineChecks || []).length ? ['not_required'] : [])].includes(evidence.countercheck?.state)) {
                throw createTeamError('verification_failed');
            }
            validation = { worktreeFingerprint: after.fingerprint, digest: digest(evidence), contractDigest: digest(contract), evidence };
            completed.set('verify', { phase: 'verify', decision: 'passed', summary: '父协调器完成真实验证与登记反证；记录绑定当前内容和权限。' });
            await persist(after);
            return { state: 'verified', fingerprint: after.fingerprint, validationDigest: validation.digest,
                logFile: evidence.logFile || '' };
        },
        accept_result: async args => {
            const tree = await current();
            if (!validation || validation.worktreeFingerprint !== tree.fingerprint || validation.contractDigest !== digest(contract)) {
                throw createTeamError('verification_failed');
            }
            if (!['approve', 'no_change'].includes(args.decision) || (args.decision === 'no_change' && tree.dirty)) {
                throw createTeamError('invalid_decision');
            }
            const accepted = parseStageResult(JSON.stringify({ ...args, decision: 'approve' }), requiresApply ? 'patch_review' : 'review');
            if (requiresApply && !normalizeOrchestrationFiles(tree.files || []).length) throw createTeamError('worktree_changed');
            seal = { fingerprint: tree.fingerprint, validationDigest: validation.digest,
                decision: tree.dirty ? 'approve' : 'no_change', accepted };
            completed.set(requiresApply ? 'patch_review' : 'review', {
                phase: requiresApply ? 'patch_review' : 'review', decision: 'approve', summary: accepted.summary.slice(0, TOOL_LIMIT),
            });
            reviewFeedback = '';
            await persist(tree);
            await progress('review');
            return { state: 'sealed', decision: seal.decision, fingerprint: seal.fingerprint,
                summary: '主 Agent 已接受当前真实验证候选；退出后父协调器仍须再次核验才能提交。' };
        },
    };
    const runTool = async (name, args = {}, context = {}) => {
        if (!Object.hasOwn(operations, name)) return result({ code: 'invalid_decision' }, true);
        if (name !== 'status' && busy) return result({ code: 'busy', summary: '已有协调工具在执行，请等待结果。' }, true);
        if (name !== 'status') busy = name;
        try {
            const value = await operations[name](args, context);
            if (name !== 'status' && value?.isError !== true) lastToolFailure = null;
            return value?.content ? value : result(value);
        } catch (error) {
            lastFailure = normalizeTeamFailure(error, name === 'verify_candidate' ? 'verify' : 'implement', settings.mainAgent);
            lastToolFailure = lastFailure;
            if (error.code === 'verification_failed') {
                reviewRecoveryAttempt = Math.min(2, reviewRecoveryAttempt + 1);
                auditCounters.reviewRecoveryAttempt += 1;
            }
            await persist().catch(() => {});
            return result({ state: 'tool_failed', code: lastFailure.code,
                summary: String(error.failureSummary || lastFailure.label).slice(0, 1500), logFile: error.logFile || '' }, true);
        } finally { if (name !== 'status') busy = ''; }
    };
    const handler = (...args) => {
        const operation = runTool(...args);
        pendingOperations.add(operation);
        operation.then(() => pendingOperations.delete(operation), () => pendingOperations.delete(operation));
        return operation;
    };
    try {
        await current();
        await persist(initial);
        contractFile();
        const headings = [...String(prompt).matchAll(/^【[^\n]{1,160}】/gm)].slice(0, 40).map(match => match[0]);
        const mainPrompt = `你是持续主 Agent ${settings.mainAgent}。这一轮只启动你一个主会话；${settings.subAgent} 只是你可调用的实施工具。你决定路线、按需委派、检查结果，并可在已批准范围内直接修正小问题；不得重开独立 plan/implement/review 原生会话。\n完整原任务存于私有文件 ${taskFile}，按标题锚点用 rg 和有界片段阅读，不要整份灌入上下文。标题：${headings.join('；')}\n当前合同（已批准时必须沿用，不能删除旧验收或越权）：${JSON.stringify(contract)}\n当前失败：${JSON.stringify(lastFailure)}\n当前草稿：${JSON.stringify(initial.files || [])}\n${handoffDirective}\n\n本轮权限与执行规则：原任务历史阶段分工文本不覆盖本轮持续主控架构；业务约束、隐私与原合同仍全部有效。无合同先 approve_plan；delegate_worker 每次只给一件具体小任务，总 brief<=6000字。worker 失败留在你这轮处理，不能冒充已验收；你可直接修改 scope 内小问题。每次写入后均须 verify_candidate，真实验证通过后由你检查差异并 accept_result。工具只把结果封存，禁止你或子工具 git commit/push、重启、发送通知或请求游戏来造验收。任何验证后改动必须重验，dirty 草稿不能以 no_change 丢弃。最终仅返回 schema JSON，decision 必须与 accept_result 的封存结果一致。\n\n【任务开头摘录（余文未注入，按上方标题阅读）】\n${String(prompt).replaceAll(FULL_HANDOFF_MANDATE, '当前 HANDOFF 已在上方注入一次。').slice(0, 5000)}`;
        if (mainPrompt.length > CONTEXT_LIMIT) throw createTeamError('output_limit');
        bridge = await (createBridge || require('./evolution-main-mcp').createMainToolBridge)({
            tools: mainTools(), instructions: 'Only the owning Main may approve, delegate, verify and seal this run.', handler,
        });
        await progress('plan');
        const mainResult = await runMain({ prompt: mainPrompt, mcp: bridge.mcp, schema: MAIN_RESULT_SCHEMA, signal: abort.signal });
        if (blocked) throw blocked;
        if (abort.signal.aborted) throw createTeamError('cli_exit', { signal: 'SIGTERM' });
        if (pendingWorkers.size || busy) throw createTeamError('unsafe_worktree');
        let final = await current();
        if (!seal) {
            reviewFeedback = safeReviewFeedback(mainResult?.summary) || '主会话已结束，但尚未封存验收结果';
            const error = createTeamError('review_rejected');
            error.failure = normalizeTeamFailure(error, 'review', settings.mainAgent);
            throw error;
        }
        if (!mainResult || mainResult.decision !== seal.decision || typeof mainResult.summary !== 'string'
            || !mainResult.summary.trim() || mainResult.summary.length > TOOL_LIMIT) throw createTeamError('invalid_decision');
        if (!validation || final.fingerprint !== seal.fingerprint || validation.digest !== seal.validationDigest) {
            throw createTeamError('worktree_changed');
        }
        await bridge.close();
        bridge = null;
        final = await current();
        if (final.fingerprint !== seal.fingerprint) throw createTeamError('worktree_changed');
        let head = baseCommit;
        if (final.dirty) {
            await progress('commit');
            head = await commit(final);
        }
        return { decision: final.dirty ? 'approve' : 'no_change', head, ...summary(), repairOnly: requiresApply,
            mainSummary: seal.accepted.summary.slice(0, TOOL_LIMIT),
            lessons: requiresApply ? [] : seal.accepted.lessons || [],
            feedbackReviewed: !requiresApply && seal.accepted.feedbackReviewed === true,
            githubResolutions: requiresApply ? [] : seal.accepted.githubResolutions || [],
            reviewedOrchestrationFiles: requiresApply ? normalizeOrchestrationFiles(contract?.allowedFiles || []) : [] };
    } catch (error) {
        const failure = blocked || error;
        writeArtifact('main-failure.json', JSON.stringify({
            nativeFailure: normalizeTeamFailure(error, 'plan', settings.mainAgent), lastToolFailure,
        }));
        if (!blocked && !seal && lastToolFailure
            && ['cli_exit', 'review_rejected', 'invalid_decision'].includes(failure.code)) {
            failure.failure = lastToolFailure;
        }
        // Main may die between its own authorized edit and the next tool call. Stop
        // writers first, then preserve the actual partial candidate for strict resume.
        abort.abort();
        await Promise.allSettled([...pendingWorkers]);
        await Promise.allSettled([...pendingOperations]);
        lastFailure = normalizeTeamFailure(failure, 'plan', settings.mainAgent);
        if (!blocked) {
            try {
                const tree = await current({ allowAbort: true });
                invalidate();
                await persist(tree);
            } catch { /* Unsafe candidates never replace the trusted scope snapshot. */ }
        }
        failure.recoveryInfo = summary();
        throw failure;
    } finally {
        abort.abort();
        signal?.removeEventListener('abort', abortOuter);
        await Promise.allSettled([...pendingWorkers]);
        await Promise.allSettled([...pendingOperations]);
        await bridge?.close();
    }
}

module.exports = { runMainOwnedWorkflow, MAIN_RESULT_SCHEMA, mainTools };
