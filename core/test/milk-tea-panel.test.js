'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./activity-availability.test');
const { WEB, vue, compileSfcModule, render, makeNode, buttonsOf, textOf, findAll, click, flush, mountActivityPage, apiMock, snapshot } = h;
const path = require('node:path');
const activeRoots = [];
test.after(() => { for (const root of activeRoots) render(null, root); });
function queries() { return Object.fromEntries(['shop','hireList','workshop','work','rank','sales'].map(k => [k, { data: null, loading: false, error: '' }])); }
function mountPanel(activity, query = queries()) {
  const Panel = compileSfcModule(path.join(WEB, 'src/components/activity/MilkTeaActivityPanel.vue'), spec => spec === 'vue' ? vue : undefined);
  const events = []; const root = makeNode('root'); activeRoots.push(root);
  render(vue.h(Panel, { activity, queries: query, onQuery: (...args) => events.push(['query', ...args]), onOperate: (...args) => events.push(['operate', ...args]) }), root);
  return { root, events };
}
const button = (root, label) => buttonsOf(root).find(b => textOf(b).trim() === label);
function setModel(root, label, value) { const node = findAll(root, n => n.props['aria-label'] === label)[0]; assert.ok(node, label); node.props['onUpdate:modelValue'](value); }

test('真实面板渲染全部说明玩法；null/缺省数值均不崩溃、不伪造0', () => {
  for (const value of [null, snapshot(), snapshot({ inventory: { available: false }, growthFund: {}, shareReward: {} })]) {
    const { root } = mountPanel(value);
    for (const section of ['开店、改名与升级','收银台与宣传喇叭','雇佣、特长与班次','工坊、配方与果实加工','我的工作、工资与互动','好友排行与销量日志','活动商城与专属种子','成长基金与快乐值','活动规则与结算']) assert.ok(textOf(root).includes(section));
    assert.match(textOf(root), /待确认/); render(null, root);
  }
});

test('实际页面六个查询按钮到store；挂载/普通刷新无这些请求、无翻页轮询', async () => {
  const api = apiMock(); api.setGet(async () => ({ data: { ok: true, activity: snapshot() } }));
  api.setPost(async (_url, body) => ({ data: { ok: true, kind: body.kind, data: {} } }));
  const page = mountActivityPage(api); activeRoots.push(page.root); await flush(); assert.equal(api.calls.post.length, 0);
  for (const label of ['查询店铺与收银台','查询雇佣候选','查询工坊与果实','查询我的工作','查询指定页排行','查询销量日志']) { click(button(page.root, label)); await flush(); }
  assert.deepEqual(api.calls.post.map(c => c.body.kind), ['shop','hireList','workshop','work','rank','sales']);
  assert.deepEqual(api.calls.post.map(c => c.body.params), [{},{durationId:1},{},{},{page:1},{}]);
  click(button(page.root, '刷新')); await flush(); await flush(); assert.equal(api.calls.post.length, 6); render(null, page.root);
});

test('十四种面板操作均先确认后发出；成员/槽位/配方/班次/费用取当前选择', async () => {
  const q = queries(); q.shop.data = { slots: [{ slotIndex: 0 }] }; q.hireList.data = { durationId: 1, robots: [{ gid:'101',name:'员工',talentName:'服务' }] };
  q.workshop.data = { recipes:[{recipeId:2,name:'甜莓奶茶',unlocked:true}], fruits:[{uid:'23563',name:'森野甜莓',count:7}] };
  q.work.data = { myShift: { shiftId:'3001',interactPreviews:[{interactionType:1}] } };
  const { root, events } = mountPanel(snapshot({ summary:{canUpgrade:true}, growthFund:{unlocked:true}, exchangeShop:{items:[{id:9,name:'种子',costs:[{id:1041,count:'10',name:'奶茶券'}]}]} }), q);
  setModel(root,'店名','奶茶冲鸭'); setModel(root,'雇佣候选','101'); setModel(root,'加工果实','23563'); await vue.nextTick();
  for (const label of ['开店','改名','升级','领取收银台','使用宣传喇叭','雇佣所选员工','暂停被雇佣','加工所选果实','领取工资','执行班次互动','确认兑换 种子','领取成长基金','领取每日快乐值','领取快乐值档位']) {
    const count = events.length; click(button(root,label)); await vue.nextTick(); assert.equal(events.length,count, '写前确认');
    assert.ok(findAll(root,n=>n.props.role==='dialog').length); click(button(root,'确认执行')); await vue.nextTick(); assert.equal(events.length,count+1);
  }
  assert.deepEqual(events.map(e=>e[1]), ['createShop','renameShop','upgrade','claimCashier','boost','hire','hireSetting','craft','claimWages','interact','exchange','fundClaim','shareDaily','shareMilestones']);
  assert.deepEqual(events.find(e=>e[1]==='hire')[2].confirmedCosts,[{itemId:1041,count:'40'}]);
  assert.deepEqual(events.find(e=>e[1]==='craft')[2].fruitUids,['23563']);
  assert.equal(events.find(e=>e[1]==='interact')[2].shiftId,'3001'); render(null,root);
});

test('实际页面确认到store；切号往返/卸载后迟到写成功、普通失败和异常无提示无刷新', async () => {
  for (const mode of ['success','ordinary','exception']) {
    const api = apiMock(); api.setGet(async()=>({data:{ok:true,activity:snapshot()}}));
    const page = mountActivityPage(api); activeRoots.push(page.root); await flush(); const gate=h.deferred(); api.setPost(()=>gate.promise);
    click(button(page.root,'领取每日快乐值')); await vue.nextTick(); click(button(page.root,'确认执行')); await flush(); assert.equal(api.calls.post[0].body.action,'shareDaily');
    page.accountRef.value='acc-2'; await flush(); page.accountRef.value='acc-1'; await flush(); const reads=api.calls.get.length;
    if(mode==='exception') gate.reject(new Error('late')); else gate.resolve({data:{ok:mode==='success'}});
    await flush(); assert.equal(page.toastLog.length,0); assert.equal(api.calls.get.length,reads); render(null,page.root);
  }
});

test('管理面板真实渲染奶茶说明的已适配与占地/图标/自动样本待证边界', async () => {
  let loads = 0;
  const useEvolutionStore = h.pinia.defineStore('evolution-panel', () => ({ evolve: vue.ref(null), startPolling() {}, stopPolling() {}, loadStatus: async () => (loads++, { ok: true, report: { scannedAt: 1, status: 'up-to-date', warnings: [], unknownActivityIds: [], detectedActivityIds: [], candidateCount: 0, caches: [], incompleteCandidates: [], online: { available: true, activities: [], unknownActivityIds: [], groups: [{ id: 2026110100, title: '奶茶热销中', payload: { tips: { txt: ['开店营业，升级小店，收银台','种植加工，奶茶工坊','雇佣好友，每班互动','宣传加速，宣传喇叭，排行榜，销量日志','成长基金，累计快乐值，人气装饰','48小时结算期，停止自动营业，未领收益通过邮件补发'] } } }] } } }) }));
  h.pinia.setActivePinia(h.pinia.createPinia());
  const Panel = compileSfcModule(path.join(WEB,'src/components/admin/AdminActivityUpdatePanel.vue'), spec => {
    if(spec==='vue')return vue; if(spec==='vue-router')return require(path.join(WEB,'node_modules/vue-router')); if(spec==='pinia')return h.pinia;
    if(spec==='@/stores/evolution')return {useEvolutionStore};
    if(spec==='@/stores/toast')return {useToastStore:()=>({success(){},error(){}})};
    if(spec==='@/api')return {__esModule:true,default:{}};
  });
  const root=makeNode('root');activeRoots.push(root);render(vue.h(Panel),root);await flush(); await vue.nextTick(); assert.equal(loads, 1, '真实mounted读取状态');
  assert.match(textOf(root),/奶茶工坊与果实加工/);assert.match(textOf(root),/森野黄金芽四格映射和本期种子、果实专属图已核验/);assert.match(textOf(root),/自然成功样本/);render(null,root);
});
