'use strict';

/* ============================================================
   AI 工作台 v3（Sprint 003）— People First 架構
   Workspace → Project → Work → Flow → AI Team → Asset Library → Publish Center
   不接任何 AI API、不接 GAS、不接 Google 帳號，資料保存在這台裝置（localStorage）
   ============================================================ */

const STORAGE_KEY = 'ai_workspace_v3';

// ── 角色（8 個，AI 可換）──────────────────────────────────────
const ROLE_LIST = ['規劃師', '研究員', '寫作師', '潤稿師', '設計師', '工程師', '審查員', '發布助手'];
const ROLE_ICON = { '規劃師': '🧭', '研究員': '🔎', '寫作師': '✍️', '潤稿師': '🌿', '設計師': '🎨', '工程師': '🛠️', '審查員': '🔍', '發布助手': '📮' };
const ROLE_AI_DEFAULT = {
  '規劃師': 'ChatGPT', '研究員': 'Gemini', '寫作師': 'Claude', '潤稿師': 'Claude',
  '設計師': 'ChatGPT', '工程師': 'Claude Code', '審查員': '自己', '發布助手': '自己'
};
const AI_OPTIONS = ['ChatGPT', 'Claude', 'Gemini', 'Claude Code', 'Codex', '自己', '其他'];

// ═════════════════════════════════════════════════════════════
// AI Tool Ecosystem（我的工具 + 官方合作模板）
// 官方工具清單／合作模板都是外部資料檔（tools-catalog.json／collaboration-templates.json），
// 不寫死在程式裡——明年出現新工具，只要更新資料檔，不用改這裡的程式碼。
// Flow 本身只描述「角色」，不綁死任何 AI 名稱；實際要用哪個工具，一律交給這裡判斷。
// ═════════════════════════════════════════════════════════════

let TOOLS_CATALOG = [];
let COLLAB_TEMPLATES = {};

// 就算資料檔載入失敗（離線／檔案遺失），也要有最小可用的防呆內容，不能讓整個 App 掛掉
const TOOLS_CATALOG_FALLBACK = [
  { id: 'chatgpt', name: 'ChatGPT', category: 'AI', emoji: '🤖' },
  { id: 'claude', name: 'Claude', category: 'AI', emoji: '🧠' },
  { id: 'gemini', name: 'Gemini', category: 'AI', emoji: '✨' }
];

async function loadToolData() {
  try {
    const [catalogRes, templatesRes] = await Promise.all([
      fetch('./tools-catalog.json'), fetch('./collaboration-templates.json')
    ]);
    const catalog = await catalogRes.json();
    const templates = await templatesRes.json();
    TOOLS_CATALOG = catalog.tools || TOOLS_CATALOG_FALLBACK;
    COLLAB_TEMPLATES = templates.templates || {};
  } catch (e) {
    TOOLS_CATALOG = TOOLS_CATALOG_FALLBACK;
    COLLAB_TEMPLATES = {};
  }
}

// 使用者的工具清單：從官方目錄起步（預設全部啟用，讓使用者一開始就能順利使用），
// 之後可以在「我的工具」畫面新增／停用／刪除／新增自訂工具
function buildDefaultMyTools() {
  return TOOLS_CATALOG.map(function (t) {
    return { id: t.id, name: t.name, category: t.category, emoji: t.emoji, enabled: true, isCustom: false };
  });
}

function getMyToolById(id) { return state.myTools.find(function (t) { return t.id === id; }); }
function isToolEnabledByName(name) {
  if (!name) return false;
  return state.myTools.some(function (t) { return t.enabled && t.name === name; });
}

// 找官方合作模板裡，這個流程＋角色（可選：精準比對步驟名稱）的建議工具鏈
function getRecommendChain(flowId, role, stepName) {
  const tpl = COLLAB_TEMPLATES[flowId];
  if (!tpl) return [];
  const steps = tpl.steps.filter(function (s) { return s.role === role; });
  const exact = steps.find(function (s) { return s.stepName === stepName; });
  if (exact) return exact.recommend || [];
  const generic = steps.find(function (s) { return !s.stepName; });
  return generic ? (generic.recommend || []) : (steps[0] ? steps[0].recommend || [] : []);
}

// 建議工具清單（教育性質，介紹「這一步適合用什麼工具製作」，例如 Suno／Udio／Runway，
// 跟 getRecommendChain（挑一個 AI 協助寫指令）是兩件不同的事，兩者互不取代）
function getRecommendedToolsChain(flowId, role, stepName) {
  const tpl = COLLAB_TEMPLATES[flowId];
  if (!tpl) return [];
  const step = tpl.steps.find(function (s) { return s.role === role && s.stepName === stepName; });
  return (step && step.recommendedTools) || [];
}

// 核心推薦引擎：依序嘗試 → 使用者手動指定（AI團隊，且該工具目前仍啟用）→ 官方建議鏈中使用者有的工具
// → 使用者任何一個啟用中的工具 → 通用防呆文字。任何情況都會回傳可用結果，不會中斷、不會報錯
function suggestedToolForStep(flowId, role, stepName) {
  const manual = state.roleAiMap[role];
  // roleAiMap 預設就會對 8 個角色都填好初始值（ROLE_AI_DEFAULT），這不代表使用者「手動選過」，
  // 只有跟預設值不一樣，才代表使用者真的在 AI 團隊畫面自己改過，這種情況才優先於官方建議
  const isExplicitOverride = manual && manual !== ROLE_AI_DEFAULT[role];
  if (isExplicitOverride && isToolEnabledByName(manual)) return { name: manual, reason: null };

  const chain = getRecommendChain(flowId, role, stepName);
  for (var i = 0; i < chain.length; i++) {
    const tool = getMyToolById(chain[i].toolId);
    if (tool && tool.enabled) return { name: tool.name, reason: chain[i].reason || null };
  }

  // 官方模板沒有建議、或建議的工具使用者都沒有 → 退回目前設定值（如果還啟用中）
  if (manual && isToolEnabledByName(manual)) return { name: manual, reason: null };

  const anyEnabled = state.myTools.find(function (t) { return t.enabled; });
  if (anyEnabled) return { name: anyEnabled.name, reason: '目前可用的工具' };

  return { name: manual || ROLE_AI_DEFAULT[role] || '你習慣使用的 AI', reason: null };
}

// 「我的工具」CRUD
function toggleMyTool(id) {
  const t = getMyToolById(id);
  if (!t) return;
  t.enabled = !t.enabled;
  saveState();
  renderMyTools();
}
function openAddCustomTool() { showScreen('screen-add-tool'); }
function confirmAddCustomTool() {
  const nameInput = document.getElementById('new-tool-name-input');
  const name = (nameInput.value || '').trim();
  if (!name) { showToast('請先幫工具取個名字'); return; }
  const category = document.getElementById('new-tool-category-select').value || '其他';
  state.myTools.push({ id: 'custom_' + Date.now(), name: name, category: category, emoji: '🔧', enabled: true, isCustom: true });
  saveState();
  nameInput.value = '';
  showToast('已新增「' + name + '」');
  showScreen('screen-my-tools');
}
function deleteCustomTool(id) {
  const t = getMyToolById(id);
  if (!t) return;
  if (!confirm('確定要刪除「' + t.name + '」嗎？')) return;
  state.myTools = state.myTools.filter(function (x) { return x.id !== id; });
  saveState();
  renderMyTools();
}

// ── Flow（流程範本）───────────────────────────────────────────
const FLOWS = {
  material: {
    id: 'material', name: '教材出版流程',
    steps: [
      { name: '教材規劃', role: '規劃師', category: '教材' },
      { name: '資料蒐集', role: '研究員', category: '教材' },
      { name: '教材撰寫', role: '寫作師', category: '教材' },
      { name: '潤稿', role: '潤稿師', category: '教材' },
      { name: 'Review', role: '審查員', category: '教材' },
      { name: '作品打磨', role: '審查員', category: '教材' },
      { name: '發布素材', role: '發布助手', category: '教材' }
    ]
  },
  video: {
    id: 'video', name: '短影音流程',
    steps: [
      { name: '主題', role: '規劃師', category: '影片' },
      { name: '腳本', role: '寫作師', category: '腳本' },
      { name: '開場 Hook', role: '寫作師', category: '影片' },
      { name: '分鏡', role: '設計師', category: '影片' },
      { name: '字幕', role: '潤稿師', category: '影片' },
      { name: '發布文案', role: '發布助手', category: '影片' },
      { name: '作品打磨', role: '審查員', category: '影片' }
    ]
  },
  product: {
    id: 'product', name: '商品行銷流程',
    steps: [
      { name: '商品整理', role: '規劃師', category: '商品' },
      { name: '賣點分析', role: '研究員', category: '商品' },
      { name: '文案', role: '寫作師', category: '商品' },
      { name: '圖片', role: '設計師', category: '圖片' },
      { name: '社群貼文', role: '發布助手', category: '社群貼文' },
      { name: '客戶回覆', role: '審查員', category: '商品' },
      { name: '成效回填', role: '研究員', category: '商品' }
    ]
  },
  social: {
    id: 'social', name: '每日社群流程',
    steps: [
      { name: '主題發想', role: '規劃師', category: '社群貼文' },
      { name: '文案撰寫', role: '寫作師', category: '社群貼文' },
      { name: '配圖建議', role: '設計師', category: '圖片' },
      { name: '發布', role: '發布助手', category: '社群貼文' }
    ]
  },
  course: {
    id: 'course', name: '課程流程',
    steps: [
      { name: '大綱', role: '規劃師', category: '課程' },
      { name: '內容撰寫', role: '寫作師', category: '課程' },
      { name: '潤稿', role: '潤稿師', category: '課程' },
      { name: '定稿', role: '發布助手', category: '課程' }
    ]
  },
  website: {
    id: 'website', name: '建立網站流程',
    steps: [
      { name: '規劃', role: '規劃師', category: '其他' },
      { name: '內容整理', role: '寫作師', category: '文章' },
      { name: '頁面設計', role: '設計師', category: '圖片' },
      { name: '網站建置', role: '工程師', category: '其他' },
      { name: '複核', role: '審查員', category: '其他' },
      { name: '上線', role: '發布助手', category: '其他' }
    ]
  },
  ebook: {
    id: 'ebook', name: '電子書流程',
    steps: [
      { name: '大綱', role: '規劃師', category: '電子書' },
      { name: '資料蒐集', role: '研究員', category: '電子書' },
      { name: '撰寫', role: '寫作師', category: '電子書' },
      { name: '潤稿', role: '潤稿師', category: '電子書' },
      { name: '排版設計', role: '設計師', category: '電子書' },
      { name: '發布', role: '發布助手', category: '電子書' }
    ]
  },
  customer_reply: {
    id: 'customer_reply', name: '客戶回覆流程',
    steps: [
      { name: '了解問題', role: '研究員', category: '其他' },
      { name: '草擬回覆', role: '寫作師', category: '其他' },
      { name: '潤飾語氣', role: '潤稿師', category: '其他' },
      { name: '送出', role: '發布助手', category: '其他' }
    ]
  },
  // Mission：歌曲創作 Flow 優化（依 CEO 實測調整，2026-07-09）
  // 原本 8 步、要到第 3 步才有歌詞，改成第 2 步就拿到可直接用的歌詞，第 3 步拿到可直接用的風格描述，
  // 盡快產出第一個可用成果（Time to First Result），而不是一直停留在規劃
  song: {
    id: 'song', name: '歌曲創作流程',
    steps: [
      { name: '主題', role: '規劃師', category: '歌曲' },
      { name: '歌詞創作', role: '寫作師', category: '歌曲' },
      { name: '音樂風格', role: '工程師', category: '歌曲' },
      { name: '封面構想', role: '設計師', category: '圖片' },
      { name: 'MV 畫面構想', role: '設計師', category: '歌曲' },
      { name: '發布文案', role: '發布助手', category: '歌曲' }
    ]
  },
  research: {
    id: 'research', name: '研究與論文寫作流程',
    steps: [
      { name: '研究題目', role: '規劃師', category: '研究' },
      { name: '研究問題', role: '研究員', category: '研究' },
      { name: '文獻蒐集', role: '研究員', category: '文獻整理' },
      { name: '文獻整理', role: '研究員', category: '文獻整理' },
      { name: '研究架構', role: '規劃師', category: '研究' },
      { name: '論文大綱', role: '寫作師', category: '論文' },
      { name: '初稿撰寫', role: '寫作師', category: '論文' },
      { name: '引用與參考資料', role: '審查員', category: '論文' },
      { name: '摘要與關鍵字', role: '寫作師', category: '論文' },
      { name: '審查與修改', role: '審查員', category: '論文' },
      { name: '作品打磨', role: '審查員', category: '論文' },
      { name: '成果保存', role: '發布助手', category: '論文' }
    ]
  },
  custom: {
    id: 'custom', name: '自訂流程',
    steps: [{ name: '完成這件事', role: '規劃師', category: '其他' }]
  }
};

// ── Flow Marketplace 介紹文字（點進 Flow 時，先說明「這套流程會完成什麼」）──
const FLOW_INTRO = {
  song: { emoji: '🎵', label: '歌曲創作', produces: ['歌曲主題', '歌詞（可直接貼 Suno Lyrics）', '音樂風格（可直接貼 Suno Style）', '封面構想', 'MV 畫面構想', '發布文案'] },
  video: { emoji: '🎬', label: '短影音', produces: ['主題', '腳本', '開場 Hook', '分鏡', '字幕', '發布文案', '打磨過的最終版'] },
  material: { emoji: '📚', label: '教材出版', produces: ['教材規劃', '蒐集資料', '教材內文', '潤稿後定稿', '打磨過的最終版'] },
  ebook: { emoji: '📖', label: '電子書', produces: ['大綱', '蒐集資料', '內文', '排版設計'] },
  product: { emoji: '🛍️', label: '商品行銷', produces: ['商品整理', '賣點分析', '文案', '商品圖'] },
  website: { emoji: '🌐', label: '建立網站', produces: ['網站規劃', '內容文字', '頁面設計', '網站建置'] },
  course: { emoji: '🎤', label: '課程設計', produces: ['課程大綱', '課程內容', '潤稿後定稿'] },
  social: { emoji: '📱', label: '社群貼文', produces: ['主題發想', '貼文文案', '配圖建議'] },
  research: { emoji: '🧪', label: '研究與論文寫作', produces: ['研究題目與問題', '文獻蒐集與整理', '研究架構', '論文大綱', '初稿', '引用與參考資料', '摘要與關鍵字', '打磨過的最終版'] },
  custom: { emoji: '✍️', label: '自訂流程', produces: ['依你的需求自由發揮'] }
};
const MARKET_FLOW_IDS = ['song', 'video', 'material', 'ebook', 'product', 'website', 'course', 'social', 'research', 'custom'];

// ── Project 類型（首頁「今天想完成什麼？」入口）───────────────
const PROJECT_TYPES = {
  material: { emoji: '📚', label: '做教材', name: '我的教材', flowId: 'material' },
  video: { emoji: '🎬', label: '做影片', name: '我的影片', flowId: 'video' },
  product: { emoji: '🛍️', label: '商品行銷', name: '商品行銷', flowId: 'product' },
  website: { emoji: '🌐', label: '建立網站', name: '我的網站', flowId: 'website' },
  ebook: { emoji: '📖', label: '做電子書', name: '我的電子書', flowId: 'ebook' },
  course: { emoji: '🎤', label: '做課程', name: '我的課程', flowId: 'course' },
  social: { emoji: '📢', label: '社群貼文', name: '社群貼文', flowId: 'social' },
  song: { emoji: '🎵', label: '歌曲創作', name: '我的歌曲', flowId: 'song' },
  research: { emoji: '🧪', label: '研究與論文寫作', name: '我的研究', flowId: 'research' },
  custom: { emoji: '➕', label: '自訂專案', name: null, flowId: 'custom' }
};

// 新增工作時，「換一個流程」的完整選單（含不在首頁入口裡的流程）
const ALL_FLOW_IDS = ['material', 'video', 'product', 'social', 'course', 'website', 'ebook', 'song', 'research', 'customer_reply', 'custom'];

const CATEGORY_LIST = ['教材', '影片', '文章', '商品', '社群貼文', '圖片', '腳本', '電子書', '課程', '歌曲', '研究', '論文', '文獻整理', '其他'];

// 發布助手：各通路文案模板（純樣板文字，不串接任何平台、不自動發布）
const PUBLISH_CHANNELS = ['YouTube', 'Facebook', 'IG', 'Threads', 'LINE'];

// ── 作品打磨：修改方向 ─────────────────────────────────────────
const GENERIC_DIRECTIONS = ['更清楚', '更簡短', '更有溫度', '更專業', '更幽默', '更有畫面', '更有記憶點', '更適合發布'];
const FLOW_DIRECTIONS = {
  song: ['副歌更洗腦', '情緒更飽滿', '句子更好唱', '更適合 Suno', '更有台灣味'],
  material: ['更適合初學者', '多一點例子', '步驟更清楚', '練習題更實用', '老師講解更自然'],
  video: ['開頭更吸引人', '節奏更快', '更短影音感', '更有爆點', '字幕更好切']
};
// 特定步驟的專屬打磨方向：改善「目前這一版」，不是重新寫一份，比流程層級的方向更精準
// （Mission：歌曲創作體驗優化，2026-07-09，依 CEO 實測回饋新增歌詞專屬打磨方向）
const STEP_DIRECTIONS = {
  '歌詞創作': ['更口語', '更押韻', '更有畫面', '更洗腦', '更有台灣味', '更療癒', '更感人', '更簡潔']
};
function directionsFor(flowId, stepName) {
  const stepSpecific = stepName && STEP_DIRECTIONS[stepName];
  if (stepSpecific) return stepSpecific;
  return GENERIC_DIRECTIONS.concat(FLOW_DIRECTIONS[flowId] || []);
}

// ═════════════════════════════════════════════════════════════
// 指令母模中心（Prompt Template Library，UI 顯示為「AI 指令庫」）
// 所有「複製給 AI」與「修正指令」的內容，都必須從這裡的模板產生
// ═════════════════════════════════════════════════════════════

const PROMPT_TEMPLATE_TYPE_LABEL = {
  global_role: '全域角色模板',
  flow_specific: '流程專屬模板',
  polish: '作品打磨模板',
  handoff: '交接模板'
};

function buildDefaultPromptTemplates() {
  var now = new Date().toISOString();
  var id = 1;
  function tpl(type, role, flowType, stepName, name, content) {
    return { id: id++, name: name, type: type, role: role || null, flowType: flowType || null, stepName: stepName || null, version: 1, content: content, isDefault: true, updatedAt: now };
  }

  var list = [];

  // ── 1. Global Role Templates（8 個角色各一份）──
  list.push(tpl('global_role', '規劃師', null, null, '規劃師・全域模板',
    '你是本工作的規劃師。\n\n請根據以下工作背景，協助完成本步驟的規劃。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 這一步的規劃重點\n2. 建議的方向與範圍\n3. 需要注意的限制或風險\n4. 建議下一步'));

  list.push(tpl('global_role', '研究員', null, null, '研究員・全域模板',
    '你是本工作的研究員。\n\n請根據以下工作背景，協助完成本步驟。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n本次任務：\n請完成本步驟需要的資料整理、案例蒐集與重點分析。\n\n請輸出：\n1. 重點整理\n2. 可用資料或案例\n3. 不確定或需要查證之處\n4. 建議下一步'));

  list.push(tpl('global_role', '寫作師', null, null, '寫作師・全域模板',
    '你是本工作的寫作師。\n\n請根據以下內容，協助完成本步驟的文字創作。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 完整文字草稿\n2. 標題建議\n3. 可延伸版本\n4. 下一步建議'));

  list.push(tpl('global_role', '潤稿師', null, null, '潤稿師・全域模板',
    '你是本工作的潤稿師。\n\n請根據以下內容，協助潤飾本步驟的文字。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 潤稿後的完整版本\n2. 主要調整了哪些地方\n3. 語氣是否一致\n4. 下一步建議'));

  list.push(tpl('global_role', '設計師', null, null, '設計師・全域模板',
    '你是本工作的設計師。\n\n請根據以下內容，協助完成本步驟需要的視覺或畫面構想。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 視覺／畫面構想說明\n2. 具體的 Prompt 或描述文字\n3. 風格建議\n4. 下一步建議'));

  list.push(tpl('global_role', '工程師', null, null, '工程師・全域模板',
    '你是本工作的工程師。\n\n請根據以下內容，協助完成本步驟需要的技術規格或建置說明。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 技術規格或設定內容\n2. 需要注意的限制\n3. 可用的工具或格式建議\n4. 下一步建議'));

  list.push(tpl('global_role', '審查員', null, null, '審查員・全域模板',
    '你是本工作的審查員。\n\n請根據以下內容，協助檢查本步驟的成果是否完整、正確。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 檢查結果（是否有明顯問題）\n2. 建議修正之處\n3. 可以放心通過的部分\n4. 下一步建議'));

  list.push(tpl('global_role', '發布助手', null, null, '發布助手・全域模板',
    '你是本工作的發布助手。\n\n請根據以下內容，協助整理成可發布的格式。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 可直接發布的版本\n2. 建議標題或摘要\n3. 適合的發布時機或說明\n4. 下一步建議'));

  // ── 2. Flow-Specific Templates（覆蓋 Global Role，依 flowType + role + stepName 精準比對）──
  list.push(tpl('flow_specific', '規劃師', 'song', '主題', '歌曲創作／主題發想',
    '你是歌曲創作流程中的主題發想夥伴。\n\n請根據使用者這次想寫的歌，快速幫忙定調，不要過度規劃——這一步的目的是快速抓到方向，馬上進入歌詞創作，不是寫企劃書。\n\n歌曲／工作名稱：{{work_name}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 這首歌的核心主題（1-2句話講清楚就好）\n2. 適合的情緒基調\n3. 一個可能的故事情境或畫面（簡短即可，不用寫完整故事）\n\n請注意：\n- 整體輸出不要超過150字\n- 目標是盡快進入下一步（歌詞創作），不是把主題想到完美'));

  list.push(tpl('flow_specific', '寫作師', 'song', '歌詞創作', '歌曲創作／作詞師',
    '你是歌曲創作流程中的作詞師。\n\n請根據以下歌曲主題，直接創作完整歌詞，讓使用者可以馬上貼到 Suno 的 Lyrics 欄位使用。\n\n歌曲／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n歌曲主題：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 完整歌詞（含 [Verse]、[Pre-Chorus]、[Chorus]、[Bridge]、[Outro] 等段落標記，這是 Suno 慣用的段落標記方式）\n2. 歌名建議（另外列出，不要混在歌詞正文裡）\n\n請注意：\n- 只寫歌詞本身，不要在這裡描述音樂風格，風格會在下一步單獨處理\n- 歌詞要好唱、自然、有畫面，不要過度文青、不要太抽象\n- 完整歌詞盡量控制在 3000 字（約 40-60 行）以內，這是 Suno 目前建議的實際甜蜜點，太長容易被系統壓縮或搶拍'));

  list.push(tpl('flow_specific', '工程師', 'song', '音樂風格', '歌曲創作／音樂風格設計師',
    '你是歌曲創作流程中的音樂風格設計師。\n\n請根據以下歌曲主題與歌詞，設計一段可以直接貼到 Suno「Style of Music」欄位的風格描述。\n\n歌曲／工作名稱：{{work_name}}\n歌曲主題：{{goal}}\n\n已有成果（含歌詞）：\n{{previous_results}}\n\n請輸出一段精簡的風格描述，依序涵蓋（這是 Suno 目前公認效果最好的排列順序）：\n1. 曲風與次曲風（例如：city pop, indie folk）\n2. 節奏／BPM（例如：mid-tempo, 90 BPM）\n3. 情緒與能量（例如：nostalgic, uplifting）\n4. 主要樂器與製作質感（例如：acoustic guitar, warm analog production）\n5. 唱腔特色（例如：female airy vocals, raspy male vocals）\n\n請注意：\n- 請用英文或 Suno 慣用的風格關鍵字寫，這是目前 Suno 辨識度較高的寫法\n- 每個標籤盡量精簡（1-3個字最好），整體抓 4-7 個重點標籤即可，不要塞太多，太多反而會讓 Suno 抓不到重點\n- 請把最重要的關鍵字放在最前面，Suno 對開頭的標籤權重較高\n- 嚴格控制在 200 字以內（這是舊版 Suno 模型的上限，新版模型雖然可以到 1000 字，但控制在 200 字內可以確保任何版本都能直接使用），不要寫成一整段小作文'));

  list.push(tpl('flow_specific', '寫作師', 'material', '教材撰寫', '教材出版／教材作者',
    '你是教材出版流程中的教材作者。\n\n請根據以下教材規劃與前一步成果，協助完成教材內文撰寫。\n\n教材／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n教材目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 完整教材內文\n2. 適合初學者的舉例\n3. 練習題或反思問題建議\n4. 需要再潤稿的地方\n\n請注意：\n用詞要白話、避免術語堆疊，讓沒有背景的讀者也看得懂。'));

  list.push(tpl('flow_specific', '寫作師', 'product', '文案', '商品行銷／文案師',
    '你是商品行銷流程中的文案師。\n\n請根據以下商品資訊與賣點分析，協助完成商品文案。\n\n商品／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n行銷目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 主打文案（1-2句）\n2. 完整商品描述\n3. 適合社群發布的短版本\n4. 需要再打磨的地方\n\n請注意：\n文案要真誠、有畫面，不要浮誇或誇大不實。'));

  list.push(tpl('flow_specific', '寫作師', 'video', '腳本', '短影音／腳本師',
    '你是短影音流程中的腳本師。\n\n請根據以下主題，協助完成短影音腳本。\n\n影片／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n影片目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 完整腳本（含開場、中段、結尾）\n2. 建議的節奏與長度\n3. 適合的字幕重點\n4. 需要再打磨的地方\n\n請注意：\n開場前3秒要抓住注意力，節奏要適合短影音平台。'));

  list.push(tpl('flow_specific', '研究員', 'research', '文獻蒐集', '研究員／文獻蒐集',
    '你是研究與論文寫作流程中的研究員，這一步是文獻蒐集。\n\n請根據以下研究背景，協助蒐集與主題相關的文獻、研究方向、核心概念與重要關鍵字。\n\n研究／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n研究目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 相關文獻方向與核心概念\n2. 重要關鍵字\n3. 可能的研究缺口\n4. 建議下一步\n\n請注意：\n- 請標註資料來源\n- 不確定的地方請直接標記「需要查證」，不要捏造文獻、作者、年份或 DOI\n- 可以標註延伸研究方向'));

  list.push(tpl('flow_specific', '研究員', 'research', '文獻整理', '研究員／文獻整理',
    '你是研究與論文寫作流程中的研究員，這一步是文獻整理。\n\n請根據以下已蒐集的文獻資料，協助整理歸納。\n\n研究／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n研究目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請用表格輸出：\n| 作者／年份 | 主題 | 方法 | 發現 | 可用處 |\n|---|---|---|---|---|\n\n請注意：\n- 不確定的作者、年份、來源請標記「需要查證」或「尚無來源」，不要捏造\n- 請歸納出主要主題、觀點、方法與研究缺口'));

  list.push(tpl('flow_specific', '寫作師', 'research', '初稿撰寫', '寫作師／論文初稿',
    '你是研究與論文寫作流程中的寫作師，這一步是初稿撰寫。\n\n請根據以下研究架構與大綱，協助撰寫論文段落初稿。\n\n研究／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n研究目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 完整初稿段落\n2. 段落邏輯說明\n3. 需要再補充查證的地方\n\n請注意：\n- 語氣正式、邏輯清楚\n- 避免未經查證的斷言，不確定處請標記「需要查證」\n- 不要捏造引用或數據'));

  list.push(tpl('flow_specific', '審查員', 'research', '引用與參考資料', '審查員／引用檢查',
    '你是研究與論文寫作流程中的審查員，這一步是引用與參考資料檢查。\n\n請根據以下內容，檢查引用是否清楚、是否需要補充來源、是否有過度推論。\n\n研究／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n\n已有成果：\n{{previous_results}}\n\n請輸出：\n1. 「需要補證據」的段落清單\n2. 「建議修改」的段落清單\n3. 引用格式是否一致\n4. 整體檢查結論\n\n請注意：\n- 不確定的引用來源請標記「需要查證」，不要幫忙捏造來源'));

  // ── 3. Polish Template（作品打磨，Polish Studio 的修正指令唯一來源）──
  list.push(tpl('polish', null, null, null, '作品打磨教練',
    '你是作品打磨教練。\n\n請根據使用者選擇的修改方向，協助修正作品。\n\n工作：{{work_name}}\n目前步驟：{{step_name}}\n使用角色：{{role_name}}\n使用 AI：{{ai_name}}\n\n上一版成果：\n{{current_result}}\n\n使用者想修改的方向：\n{{revision_direction}}\n\n請協助：\n1. 保留原本作品的優點\n2. 針對修改方向進行調整\n3. 不要重新偏題\n4. 輸出修改後版本\n5. 簡短說明你修改了哪些地方'));

  // ── 4. Handoff Templates（交接用，本輪先建立供 AI 指令庫瀏覽，尚未接進特定畫面）──
  list.push(tpl('handoff', null, null, null, '交給下一位 AI',
    '你好，我是這個作品的下一位協作者。\n\n工作：{{work_name}}\n目前步驟：{{step_name}}\n上一步的成果：\n{{previous_results}}\n\n請你接手完成「{{step_name}}」這個步驟。'));

  list.push(tpl('handoff', null, null, null, '回填成果',
    '以下是我從 AI 拿到的回答，我要把它保存到「{{step_name}}」這個步驟：\n\n{{current_result}}'));

  list.push(tpl('handoff', null, null, null, '發布前檢查',
    '這是「{{work_name}}」的最終版本，準備發布前的最後檢查。\n\n請確認：\n1. 內容是否完整\n2. 是否符合原本的目標：{{goal}}\n3. 有沒有需要修正的地方\n\n內容：\n{{current_result}}'));

  return list;
}

// 模板變數填入（{{key}} 找不到值時填「（無）」，不留下裸露的 {{}} 給使用者看到）
function fillTemplate(content, vars) {
  return content.replace(/\{\{(\w+)\}\}/g, function (match, key) {
    var v = vars[key];
    return (v !== undefined && v !== null && v !== '') ? v : '（無）';
  });
}

// 模板比對優先順序：Flow-Specific（含 stepName 精準比對）> Flow-Specific（僅 role）> Global Role
function resolveAiInstructionTemplate(flowId, role, stepName) {
  var flowSpecific = state.promptTemplates.filter(function (t) { return t.type === 'flow_specific' && t.flowType === flowId && t.role === role; });
  var exact = flowSpecific.find(function (t) { return t.stepName === stepName; });
  if (exact) return exact;
  if (flowSpecific.length > 0) return flowSpecific[0];
  return state.promptTemplates.find(function (t) { return t.type === 'global_role' && t.role === role; }) || null;
}

function resolvePolishTemplate() {
  return state.promptTemplates.find(function (t) { return t.type === 'polish'; }) || null;
}

// ═════════════════════════════════════════════════════════════
// Context Pack Builder（專案內容包）
// 分工：Prompt Template 決定「角色與輸出方式」，Context Pack 提供「背景與進度」
// 兩者相加才是完整指令，Context Pack 不取代 Prompt Template
// ═════════════════════════════════════════════════════════════

const CONTEXT_PACK_TEMPLATE =
  '# 專案背景\n\n' +
  '## 專案\n{{project_name}}\n\n' +
  '## 工作\n{{work_name}}\n\n' +
  '## 工作目標\n{{goal}}\n\n' +
  '## 使用流程\n{{flow_name}}\n\n' +
  '## 目前步驟\n{{step_name}}\n\n' +
  '## 目前角色\n{{role_name}}\n\n' +
  '## 建議使用 AI\n{{ai_name}}\n\n' +
  '## 已完成步驟\n{{completed_steps}}\n\n' +
  '## 前面累積成果\n{{previous_results}}\n\n' +
  '## 目前成果庫相關成果\n{{related_assets}}\n\n' +
  '## 本次任務\n{{step_instruction}}\n\n' +
  '## 請輸出格式\n{{output_format}}\n\n' +
  '## 回填提醒\n完成後請輸出清楚段落，方便使用者貼回 AI 工作台。';

const AUDIENCE_BY_FLOW = {
  material: '初學者、一般讀者', course: '初學者、一般讀者', product: '潛在客戶',
  video: '一般觀眾', social: '追蹤者', song: '聽眾', ebook: '一般讀者',
  website: '網站訪客', customer_reply: '這位客戶本人', custom: '一般使用者'
};
function audienceFor(flowId) { return AUDIENCE_BY_FLOW[flowId] || '一般使用者'; }

// 前面已完成步驟的完整內容（依目前採用版本）
function buildPreviousResults(workId) {
  const work = getWork(workId);
  const prev = work.stepResultIds.slice(0, work.currentStepIndex)
    .map(function (rid) { return state.results.find(function (r) { return r.id === rid; }); })
    .filter(Boolean);
  if (prev.length === 0) return '（這是第一步，還沒有前面的成果）';
  return prev.map(function (r) { return '【' + r.stepName + '】\n' + r.content; }).join('\n\n');
}

// 同一個專案裡，其他工作已完成的最終成品（提供跨工作的專案脈絡）
function buildRelatedAssets(projectId, workId) {
  const others = state.results.filter(function (r) { return r.projectId === projectId && r.workId !== workId && r.isFinal; });
  if (others.length === 0) return '（目前這個專案還沒有其他完成的成果）';
  return others.map(function (r) {
    const firstLine = (r.content || '').split('\n').filter(Boolean)[0] || '';
    return '「' + r.workName + '」：' + firstLine;
  }).join('\n');
}

// 依角色補充專屬脈絡（研究員／寫作師／潤稿師／發布助手），其餘角色回傳 null（不附加）
function buildRoleSpecificContext(work, step, role, baseVars) {
  if (role === '研究員') {
    return fillTemplate(
      '## 本次研究問題\n{{step_name}}\n\n' +
      '## 已知資料\n{{previous_results}}\n\n' +
      '## 需要查證的假設\n（依常識判斷，若有明顯需要查證的數字或事實，請特別標註）\n\n' +
      '## 不要重複研究的內容\n{{completed_steps}}\n\n' +
      '## 請標註不確定處\n遇到不確定或無法查證的地方，請直接說明，不要憑空捏造。',
      baseVars
    );
  }
  if (role === '寫作師') {
    return fillTemplate(
      '## 寫作風格\n請維持這個工作目前的語氣與風格，與前面已完成的內容一致。\n\n' +
      '## 目標讀者\n{{audience}}\n\n' +
      '## 已有素材\n{{previous_results}}\n\n' +
      '## 請保持前後一致\n不要跟前面已完成的內容互相矛盾。',
      Object.assign({}, baseVars, { audience: audienceFor(work.flowId) })
    );
  }
  if (role === '潤稿師') {
    return fillTemplate(
      '## 上一版成果\n{{previous_results}}\n\n' +
      '## 使用者想修改的方向\n（本次為一般潤稿步驟，非作品打磨修正，暫無特定修改方向）\n\n' +
      '## 請保留原本優點\n潤稿時請保留原本內容的優點，不要整篇重寫。\n\n' +
      '## 不要重新偏題\n請維持原本的主題與方向。',
      baseVars
    );
  }
  if (role === '發布助手') {
    return fillTemplate(
      '## 最終成品摘要\n{{previous_results}}\n\n' +
      '## 發布平台\nYouTube、Facebook、IG、Threads、LINE\n\n' +
      '## 需要產出的版本\n請產出適合上述平台的發布版本。',
      baseVars
    );
  }
  return null;
}

// 產生完整的專案內容包（含角色專屬補充）
function buildContextPack(workId) {
  const work = getWork(workId);
  const project = getProject(work.projectId);
  const flow = FLOWS[work.flowId];
  const step = currentStep(work);

  const vars = {
    project_name: project ? project.name : '',
    work_name: work.name,
    goal: work.name,
    flow_name: flow.name,
    step_name: step.name,
    role_name: step.role,
    ai_name: suggestedToolForStep(work.flowId, step.role, step.name).name,
    completed_steps: flow.steps.slice(0, work.currentStepIndex).map(function (s) { return s.name; }).join('、') || '（尚未完成任何步驟）',
    previous_results: buildPreviousResults(workId),
    related_assets: buildRelatedAssets(work.projectId, workId),
    step_instruction: '請以「' + step.role + '」的身份，完成「' + step.name + '」這個步驟。',
    output_format: '請參考下方指令母模的詳細輸出要求。'
  };

  var pack = fillTemplate(CONTEXT_PACK_TEMPLATE, vars);
  var roleExtra = buildRoleSpecificContext(work, step, step.role, vars);
  if (roleExtra) pack += '\n\n' + roleExtra;
  var flowExtra = buildFlowSpecificContext(work, vars);
  if (flowExtra) pack += '\n\n' + flowExtra;
  return pack;
}

// 依「流程」補充專屬脈絡（跟 buildRoleSpecificContext 依「角色」互補，兩者可同時出現）
function buildFlowSpecificContext(work, vars) {
  if (work.flowId === 'research') {
    return fillTemplate(
      '## 研究主題\n{{work_name}}\n\n' +
      '## 研究目的\n（請參考「研究題目」與「研究架構」步驟的成果推斷，若尚未完成請協助釐清）\n\n' +
      '## 研究問題\n（請參考「研究問題」步驟的成果）\n\n' +
      '## 目標讀者\n學術／專業讀者\n\n' +
      '## 已蒐集文獻\n{{previous_results}}\n\n' +
      '## 需要查證的假設\n請標註所有不確定的數據、引用或論點，不要視為已確認的事實。\n\n' +
      '## 引用格式需求\n請維持前後一致的引用格式，若前面步驟已建立格式，請沿用。\n\n' +
      '## ⚠️ 不可捏造來源提醒\n不得捏造文獻、作者、年份、DOI 或引用來源。如果沒有可靠來源，請標記「需要查證」或「尚無來源」，不要編造看起來合理但無法查證的內容。',
      vars
    );
  }
  return null;
}

// 指令母模 + 專案內容包 → 完整指令（先給背景，再給任務與輸出要求）
function buildAiInstructionFromTemplate(workId) {
  const work = getWork(workId);
  const step = currentStep(work);
  const project = getProject(work.projectId);
  const flow = FLOWS[work.flowId];
  const template = resolveAiInstructionTemplate(work.flowId, step.role, step.name);

  const vars = {
    project_name: project ? project.name : '',
    work_name: work.name,
    flow_name: flow.name,
    step_name: step.name,
    role_name: step.role,
    ai_name: suggestedToolForStep(work.flowId, step.role, step.name).name,
    goal: work.name,
    previous_results: buildPreviousResults(workId)
  };

  const templateText = template ? fillTemplate(template.content, vars) : ('請協助完成「' + step.name + '」這個步驟。');
  const contextPack = buildContextPack(workId);

  return contextPack + '\n\n---\n\n' + templateText;
}

// 既有 localStorage（Mission 019 之前建立）可能沒有這些欄位，載入後自動補齊，不影響既有資料
function ensureNewFields(s) {
  if (!s.promptTemplates) s.promptTemplates = buildDefaultPromptTemplates();
  if (s.gasWebhookUrl === undefined) s.gasWebhookUrl = '';
  if (!s.myTools) s.myTools = buildDefaultMyTools();
  // 官方工具目錄新增工具時，既有使用者的清單也同步補上（預設啟用），這樣新工具才推薦得到，不用使用者自己手動加
  TOOLS_CATALOG.forEach(function (t) {
    if (!s.myTools.some(function (mt) { return mt.id === t.id; })) {
      s.myTools.push({ id: t.id, name: t.name, category: t.category, emoji: t.emoji, enabled: true, isCustom: false });
    }
  });
  s.results.forEach(function (r) { if (r.cloudStatus === undefined) r.cloudStatus = 'none'; });
}
function buildChannelDraft(channel, result) {
  const excerpt = (result.content || '').split('\n').filter(Boolean).slice(0, 2).join(' ');
  const base = result.workName + '　' + excerpt;
  switch (channel) {
    case 'YouTube': return '【標題】' + result.workName + '\n【說明】' + base + '\n#AI共創 #' + result.category;
    case 'Facebook': return base + '\n\n完整內容歡迎點連結閱讀 👇';
    case 'IG': return base + '\n.\n.\n#' + result.category + ' #創作日常';
    case 'Threads': return base;
    case 'LINE': return '📢 新作品上架：' + result.workName + '\n' + excerpt;
    default: return base;
  }
}

// ── 狀態 ──────────────────────────────────────────────────────
let state = null;

function defaultState() {
  return {
    userName: '秀芳',
    workspaceName: '我的工作台',
    roleAiMap: Object.assign({}, ROLE_AI_DEFAULT),
    projects: [],
    works: [],
    results: [],
    publishRecords: [],
    promptTemplates: buildDefaultPromptTemplates(),
    gasWebhookUrl: '',
    myTools: buildDefaultMyTools(),
    nextProjectId: 1, nextWorkId: 1, nextResultId: 1, nextPublishId: 1
  };
}

function seedDemoData(s) {
  const p1 = { id: s.nextProjectId++, type: 'material', emoji: '📚', name: '我的教材' };
  const p2 = { id: s.nextProjectId++, type: 'video', emoji: '🎬', name: '我的影片' };
  const p3 = { id: s.nextProjectId++, type: 'product', emoji: '🛍️', name: '商品行銷' };
  s.projects.push(p1, p2, p3);

  const w1 = { id: s.nextWorkId++, projectId: p1.id, name: 'Lesson 1-02', flowId: 'material', started: true, currentStepIndex: 1, status: '進行中', stepResultIds: [], stepVersions: [] };
  const r1 = makeResult(s, w1, p1, 0, '已經整理好這次教材的規劃方向：先講「為什麼要用 AI 團隊」，再講角色分工，最後放一個小商家案例。', false, '很滿意');
  w1.stepResultIds[0] = r1.id;
  s.works.push(w1);

  const w2 = { id: s.nextWorkId++, projectId: p2.id, name: '七月影片 001', flowId: 'video', started: false, currentStepIndex: 0, status: '等待開始', stepResultIds: [], stepVersions: [] };
  s.works.push(w2);

  const w3 = { id: s.nextWorkId++, projectId: p3.id, name: '手作商品上架文案', flowId: 'product', started: true, currentStepIndex: 6, status: '已完成', stepResultIds: [], stepVersions: [] };
  const flow3 = FLOWS.product;
  const demo = ['整理了三款手作商品的特色與規格。', '賣點：純手工、限量、可客製化。', '「每一件都是獨一無二的手作溫度」主打文案。', '建議用暖色系拍攝，搭配自然光。', '已發布到社群貼文。', '目前沒有客戶提問。', '上架三天，詢問度不錯。'];
  flow3.steps.forEach(function (step, i) {
    const r = makeResult(s, w3, p3, i, demo[i] || '', false);
    w3.stepResultIds[i] = r.id;
  });
  s.works.push(w3);
  createFinalProduct(s, w3, p3);
}

function makeResult(s, work, project, stepIndex, content, isFinal, satisfaction) {
  const flow = FLOWS[work.flowId];
  const step = flow.steps[stepIndex];
  if (!work.stepVersions) work.stepVersions = [];
  if (!work.stepVersions[stepIndex]) work.stepVersions[stepIndex] = [];
  const version = work.stepVersions[stepIndex].length + 1;
  const r = {
    id: s.nextResultId++,
    title: work.name + '｜' + step.name,
    projectId: project.id, projectName: project.name,
    workId: work.id, workName: work.name,
    flowId: flow.id, flowName: flow.name,
    stepName: step.name, role: step.role, stepIndex: stepIndex,
    ai: suggestedToolForStep(work.flowId, step.role, step.name).name,
    content: content, category: step.category,
    completedAt: new Date().toISOString(), isFinal: !!isFinal,
    version: version, satisfaction: satisfaction || '很滿意',
    cloudStatus: 'none'
  };
  s.results.push(r);
  if (!isFinal) work.stepVersions[stepIndex].push(r.id);
  return r;
}

function createFinalProduct(s, work, project) {
  const flow = FLOWS[work.flowId];
  const pieces = flow.steps.map(function (step, i) {
    const r = s.results.find(function (x) { return x.id === work.stepResultIds[i]; });
    return '【' + step.name + '】\n' + (r ? r.content : '');
  }).join('\n\n');
  const aiUsed = Array.from(new Set(flow.steps.map(function (step) { return suggestedToolForStep(work.flowId, step.role, step.name).name; }))).join('、');
  const finalCategory = flow.id === 'video' ? '影片' : flow.id === 'ebook' ? '電子書' : flow.id === 'course' ? '課程' : flow.id === 'material' ? '教材' : flow.id === 'product' ? '商品' : flow.id === 'social' ? '社群貼文' : flow.id === 'song' ? '歌曲' : flow.id === 'research' ? '論文' : '其他';
  const final = {
    id: s.nextResultId++,
    title: work.name + '（最終成品）',
    projectId: project.id, projectName: project.name,
    workId: work.id, workName: work.name,
    flowId: flow.id, flowName: flow.name,
    stepName: '最終成品', role: '—', ai: aiUsed,
    content: pieces, category: finalCategory,
    completedAt: new Date().toISOString(), isFinal: true,
    cloudStatus: 'none'
  };
  s.results.push(final);
  return final;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { state = JSON.parse(raw); ensureNewFields(state); saveState(); return; }
  } catch (e) { /* 重建 */ }
  state = defaultState();
  seedDemoData(state);
  saveState();
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { showToast('保存失敗，可能是這台裝置空間不足'); }
}

// ── 畫面切換 ──────────────────────────────────────────────────
const TAB_SCREENS = ['screen-home', 'screen-assets', 'screen-publish', 'screen-ai-team', 'screen-settings'];

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function (el) { el.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
  document.getElementById('bottom-nav').classList.toggle('show', TAB_SCREENS.indexOf(id) !== -1);
  document.querySelectorAll('.nav-item').forEach(function (el) {
    el.classList.toggle('active', el.dataset.target === id);
  });
  render();
  window.scrollTo(0, 0);
}
function goBack(target) { showScreen(target); }

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
}
function greetPrefix() {
  const h = new Date().getHours();
  if (h < 11) return '早安';
  if (h < 18) return '午安';
  return '晚安';
}

// ── Project ───────────────────────────────────────────────────
let activeProjectId = null;

function getProject(id) { return state.projects.find(function (p) { return p.id === id; }); }
function getActiveProject() { return getProject(activeProjectId); }
function projectWorks(projectId) { return state.works.filter(function (w) { return w.projectId === projectId; }); }

function openPurpose(typeKey) {
  const type = PROJECT_TYPES[typeKey];
  if (typeKey === 'custom') {
    const name = prompt('幫這個新專案取個名字：');
    if (!name || !name.trim()) return;
    const p = { id: state.nextProjectId++, type: 'custom', emoji: '➕', name: name.trim() };
    state.projects.push(p);
    saveState();
    activeProjectId = p.id;
    showScreen('screen-project');
    return;
  }
  let p = state.projects.find(function (x) { return x.type === typeKey; });
  if (!p) {
    p = { id: state.nextProjectId++, type: typeKey, emoji: type.emoji, name: type.name };
    state.projects.push(p);
    saveState();
    showToast('已建立「' + type.name + '」專案');
  }
  activeProjectId = p.id;
  showScreen('screen-project');
}

function openProject(projectId) {
  activeProjectId = projectId;
  showScreen('screen-project');
}

// ── Flow Marketplace ─────────────────────────────────────────
let activeFlowIntroId = null;

function openFlowMarket() { showScreen('screen-flow-market'); }

function openFlowIntro(flowId) {
  activeFlowIntroId = flowId;
  showScreen('screen-flow-intro');
}

function startFlowFromMarket() {
  openPurpose(activeFlowIntroId === 'custom' ? 'custom' : activeFlowIntroId);
}

// ── Work ──────────────────────────────────────────────────────
let activeWorkId = null;
let pendingFlowId = null;

function getWork(id) { return state.works.find(function (w) { return w.id === id; }); }
function getActiveWork() { return getWork(activeWorkId); }
function currentStep(work) { return FLOWS[work.flowId].steps[work.currentStepIndex]; }

function openAddWork() {
  const project = getActiveProject();
  pendingFlowId = PROJECT_TYPES[project.type] ? PROJECT_TYPES[project.type].flowId : 'custom';
  showScreen('screen-add-work');
}

function chooseFlow(flowId) {
  pendingFlowId = flowId;
  render();
}

function confirmNewWork() {
  const input = document.getElementById('new-work-name-input');
  const name = (input.value || '').trim();
  if (!name) { showToast('幫這件工作取個名字吧'); return; }
  const project = getActiveProject();
  const work = {
    id: state.nextWorkId++, projectId: project.id, name: name,
    flowId: pendingFlowId, started: false, currentStepIndex: 0,
    status: '等待開始', stepResultIds: []
  };
  state.works.push(work);
  saveState();
  input.value = '';
  showToast('已建立「' + name + '」');
  showScreen('screen-project');
}

function openWork(workId) {
  activeWorkId = workId;
  const work = getWork(workId);
  if (work && !work.started) { work.started = true; work.status = '進行中'; saveState(); }
  showScreen('screen-work-detail');
}

function editWork(workId, event) {
  if (event) event.stopPropagation();
  const work = getWork(workId);
  const newName = prompt('把工作名稱改成：', work.name);
  if (newName && newName.trim()) {
    work.name = newName.trim();
    saveState();
    render();
    showToast('已修改');
  }
}

function deleteWork(workId, event) {
  if (event) event.stopPropagation();
  const work = getWork(workId);
  if (!confirm('確定要刪除「' + work.name + '」嗎？已保存的成果不會被刪除，仍會留在成果庫。')) return;
  state.works = state.works.filter(function (w) { return w.id !== workId; });
  saveState();
  render();
  showToast('已刪除');
}

// ── 交給 AI ───────────────────────────────────────────────────
// 依「指令母模中心」規則產生指令：Flow-Specific 優先，找不到才退回 Global Role
// Mission 021：改為「指令母模 + 專案內容包」組合，不再只產生單一步驟指令
function buildCopyText(work) {
  return buildAiInstructionFromTemplate(work.id);
}
function goCopyToAi() { showScreen('screen-copy-to-ai'); }
function currentStepAiName() {
  const work = getActiveWork();
  const step = currentStep(work);
  return suggestedToolForStep(work.flowId, step.role, step.name).name;
}
function copyToClipboard() {
  const text = lastCopyText;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast('已複製，請貼到 ' + currentStepAiName() + '。'); }).catch(function () { fallbackCopy(text); });
  } else { fallbackCopy(text); }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast('已複製！'); } catch (e) { showToast('複製失敗，請手動選取文字複製'); }
  document.body.removeChild(ta);
}

// ── 貼回成果 ──────────────────────────────────────────────────
function goPasteBack() { showScreen('screen-paste-back'); }
function submitPasteBack() {
  const work = getActiveWork();
  const project = getProject(work.projectId);
  const textarea = document.getElementById('paste-back-textarea');
  const content = (textarea.value || '').trim();
  if (!content) { showToast('請先貼上 AI 給你的內容'); return; }

  const r = makeResult(state, work, project, work.currentStepIndex, content, false);
  work.stepResultIds[work.currentStepIndex] = r.id;
  textarea.value = '';
  saveState();

  lastSubmittedResultId = r.id;
  showScreen('screen-satisfaction');
}

// ── 作品打磨（滿意度 → 修改方向 → 修正指令 → 貼回修改版 → 版本歷程）──
let lastSubmittedResultId = null;
let selectedDirections = [];

function satisfactionGood() {
  const r = getResult(lastSubmittedResultId);
  r.satisfaction = '很滿意';
  saveState();

  const work = getActiveWork();
  const project = getProject(work.projectId);
  const flow = FLOWS[work.flowId];
  if (work.currentStepIndex + 1 >= flow.steps.length) {
    work.status = '已完成';
    createFinalProduct(state, work, project);
    saveState();
    showToast('完成了！已收進成果庫');
    showScreen('screen-project');
  } else {
    work.currentStepIndex += 1;
    saveState();
    showToast('已保存，交給下一位 → ' + currentStep(work).role);
    showScreen('screen-work-detail');
  }
}

function satisfactionRevise(level) {
  const r = getResult(lastSubmittedResultId);
  r.satisfaction = level;
  saveState();
  selectedDirections = [];
  showScreen('screen-revise-direction');
}

// 從「成果詳情」畫面直接進入打磨（例如已經按過「很滿意」，但回頭看又想再調整）
// 只給 renderAssetDetail() 已經確認過「還是目前這一步」的成果呼叫，避免資料錯位
function openPolishFromAsset(resultId) {
  const r = getResult(resultId);
  activeWorkId = r.workId;
  lastSubmittedResultId = r.id;
  selectedDirections = [];
  showScreen('screen-revise-direction');
}

function toggleDirection(dir, event) {
  const idx = selectedDirections.indexOf(dir);
  if (idx === -1) { selectedDirections.push(dir); } else { selectedDirections.splice(idx, 1); }
  if (event && event.target) { event.target.classList.toggle('selected'); }
}

function goRevisionInstruction() {
  if (selectedDirections.length === 0) { showToast('請至少選一個修改方向'); return; }
  showScreen('screen-revise-instruction');
}

// 修正指令一律由「作品打磨模板」產生，不再另外手寫一套邏輯
function buildRevisionInstruction() {
  const work = getActiveWork();
  const step = currentStep(work);
  const r = getResult(lastSubmittedResultId);
  const template = resolvePolishTemplate();

  const vars = {
    work_name: work.name,
    step_name: step.name,
    role_name: step.role,
    ai_name: suggestedToolForStep(work.flowId, step.role, step.name).name,
    current_result: r.content,
    revision_direction: selectedDirections.join('、')
  };

  if (template) return fillTemplate(template.content, vars);
  return '請依照修改方向調整：' + selectedDirections.join('、');
}

function copyRevisionInstruction() {
  const text = document.getElementById('revise-instruction-box').textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast('已複製修正指令'); });
  } else { fallbackCopy(text); }
}

function goReviseSubmit() { showScreen('screen-paste-back'); }

// ── AI Team ───────────────────────────────────────────────────
function updateRoleAi(role, ai) { state.roleAiMap[role] = ai; saveState(); }

// ── Asset Library（成果庫）────────────────────────────────────
let activeCategory = '全部';
let activeResultId = null;
function setCategory(cat) { activeCategory = cat; renderAssets(); }
function getResult(id) { return state.results.find(function (r) { return r.id === id; }); }
function openResult(id) { activeResultId = id; showScreen('screen-asset-detail'); }
function copyResultContent() {
  const r = getResult(activeResultId);
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(r.content).then(function () { showToast('已複製'); }); }
  else { fallbackCopy(r.content); }
}
function editResultTitle() {
  const r = getResult(activeResultId);
  const t = prompt('幫這份成果取個新標題：', r.title);
  if (t && t.trim()) { r.title = t.trim(); saveState(); render(); showToast('標題已更新'); }
}
function toggleFinalMark() {
  const r = getResult(activeResultId);
  r.isFinal = !r.isFinal; saveState(); render();
  showToast(r.isFinal ? '已標記為最終成品' : '已取消最終成品標記');
}

// 版本歷程：找同一個工作、同一個步驟的所有版本（依 version 排序）
function getVersionHistory(result) {
  if (result.stepIndex === undefined) return [result];
  return state.results
    .filter(function (r) { return r.workId === result.workId && r.stepIndex === result.stepIndex && !r.isFinal; })
    .sort(function (a, b) { return a.version - b.version; });
}
function viewVersion(id) { activeResultId = id; render(); }

// ── 雲端作品庫（Alpha 階段：只做 UI + localStorage 狀態，不接 Google Drive）──
function saveToCloud(resultId) {
  if (!state.gasWebhookUrl) { showToast('請先到「我的工作台」開通雲端設定'); return; }
  const r = getResult(resultId);
  r.cloudStatus = 'saved';
  saveState();
  render();
  showToast('已加入雲端作品庫（本輪為狀態模擬，尚未實際連接 Google Drive）');
}

function updateGasWebhookUrl(v) { state.gasWebhookUrl = (v || '').trim(); saveState(); }

function openGasInstructions() { showScreen('screen-gas-instructions'); }

// 一鍵複製腳本代碼：本輪為 placeholder，未來由 GAS 階段實作真正邏輯（建資料夾/分類/存 Docs/寫 Sheets 索引）
const GAS_CODE_TEMPLATE = [
  '// AI 工作台｜雲端作品庫連線腳本（Placeholder，尚未實作真正邏輯）',
  '// 部署方式：Google Drive → 新增 → Google Apps Script → 貼上這段 → 部署為 Web App',
  '',
  'function doPost(e) {',
  '  // 未來這裡會依序：',
  '  // 1. 建立或尋找「AI工作台」資料夾',
  '  // 2. 依作品類型建立子資料夾（教材／歌曲／影片...）',
  '  // 3. 將文字成果存成 Google Docs',
  '  // 4. 將索引寫回 Google Sheets',
  '  // 5. 回傳 Google Doc 連結',
  '  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: "placeholder" }))',
  '    .setMimeType(ContentService.MimeType.JSON);',
  '}'
].join('\n');

function copyGasCode() {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(GAS_CODE_TEMPLATE).then(function () { showToast('已複製腳本代碼！'); });
  } else { fallbackCopy(GAS_CODE_TEMPLATE); }
}

// ── Publish Center（發布中心）──────────────────────────────────
function markPublished(resultId) {
  const r = getResult(resultId);
  state.publishRecords.push({ id: state.nextPublishId++, resultId: resultId, title: r.title, publishedAt: new Date().toISOString() });
  saveState();
  showToast('已標記為已發布');
  render();
}
function isPublished(resultId) { return state.publishRecords.some(function (p) { return p.resultId === resultId; }); }

// ── 發布助手（產生各通路草稿文案，不自動發布）───────────────────
let activePublishAssistantResultId = null;
function openPublishAssistant(resultId) {
  activePublishAssistantResultId = resultId;
  showScreen('screen-publish-assistant');
}
function copyChannelDraft(channel) {
  const r = getResult(activePublishAssistantResultId);
  const text = buildChannelDraft(channel, r);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast('已複製 ' + channel + ' 文案'); });
  } else { fallbackCopy(text); }
}

// ── 我的工作台 ────────────────────────────────────────────────
function updateUserName(v) { state.userName = (v || '').trim() || '朋友'; saveState(); }
function updateWorkspaceName(v) { state.workspaceName = (v || '').trim() || '我的工作台'; saveState(); }
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = '我的工作台備份.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast('已匯出，檔案在你的下載資料夾');
}

// ── 渲染 ──────────────────────────────────────────────────────
function render() {
  const active = document.querySelector('.screen.active');
  if (!active) return;
  const id = active.id;
  if (id === 'screen-home') renderHome();
  if (id === 'screen-project') renderProject();
  if (id === 'screen-add-work') renderAddWork();
  if (id === 'screen-work-detail') renderWorkDetail();
  if (id === 'screen-copy-to-ai') renderCopyToAi();
  if (id === 'screen-paste-back') renderPasteBack();
  if (id === 'screen-satisfaction') renderSatisfaction();
  if (id === 'screen-revise-direction') renderReviseDirection();
  if (id === 'screen-revise-instruction') renderReviseInstruction();
  if (id === 'screen-ai-team') renderAiTeam();
  if (id === 'screen-assets') renderAssets();
  if (id === 'screen-asset-detail') renderAssetDetail();
  if (id === 'screen-publish') renderPublish();
  if (id === 'screen-publish-assistant') renderPublishAssistant();
  if (id === 'screen-settings') renderSettings();
  if (id === 'screen-flow-market') renderFlowMarket();
  if (id === 'screen-flow-intro') renderFlowIntro();
  if (id === 'screen-prompt-library') renderPromptLibrary();
  if (id === 'screen-prompt-detail') renderPromptDetail();
  if (id === 'screen-my-tools') renderMyTools();
}

function renderHome() {
  document.getElementById('home-greeting').textContent = greetPrefix() + '，' + state.userName + ' ' + (greetPrefix() === '晚安' ? '🌙' : '☀️');

  const list = document.getElementById('home-project-list');
  if (state.projects.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">👆</div><div class="txt">點上面的圖示，開始你的第一個專案</div></div>';
    return;
  }
  list.innerHTML = state.projects.map(function (p) {
    const works = projectWorks(p.id);
    const doing = works.filter(function (w) { return w.status === '進行中'; });
    const waiting = works.filter(function (w) { return w.status === '等待開始'; });
    let hint;
    if (doing.length > 0) hint = '今天可以做：' + doing[0].name + '（' + currentStep(doing[0]).name + '）';
    else if (waiting.length > 0) hint = '今天可以做：' + waiting[0].name + '（尚未開始）';
    else if (works.length > 0) hint = '這個專案的工作都完成了 ✅';
    else hint = '還沒有工作，點進去新增一個';
    return '<div class="card" onclick="openProject(' + p.id + ')">' +
      '<h3>' + p.emoji + ' ' + escHtml(p.name) + '</h3>' +
      '<div class="line">' + works.length + ' 件工作</div>' +
      '<div class="line" style="color:var(--green-soft);font-weight:700">' + escHtml(hint) + '</div>' +
      '</div>';
  }).join('');
}

function renderProject() {
  const project = getActiveProject();
  if (!project) { showScreen('screen-home'); return; }
  const works = projectWorks(project.id);
  const doing = works.filter(function (w) { return w.status === '進行中'; });
  const waiting = works.filter(function (w) { return w.status === '等待開始'; });
  const done = works.filter(function (w) { return w.status === '已完成'; });
  const recentAsset = state.results.filter(function (r) { return r.projectId === project.id; }).slice(-1)[0];

  document.getElementById('proj-title').textContent = project.emoji + ' ' + project.name;
  document.getElementById('proj-summary').innerHTML =
    '<div class="line"><b>這是什麼專案？</b>　' + escHtml(project.name) + '</div>' +
    '<div class="line"><b>目前做到哪？</b>　進行中 ' + doing.length + '　等待開始 ' + waiting.length + '　已完成 ' + done.length + '</div>' +
    '<div class="line"><b>今天可以做什麼？</b>　' + (doing[0] ? doing[0].name + '（' + currentStep(doing[0]).name + '）' : (waiting[0] ? waiting[0].name + '（尚未開始）' : '目前沒有待處理的工作')) + '</div>' +
    '<div class="line"><b>最近成果？</b>　' + (recentAsset ? escHtml(recentAsset.title) : '還沒有成果') + '</div>';

  const list = document.getElementById('proj-work-list');
  if (works.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">📋</div><div class="txt">這個專案還沒有工作</div></div>';
    return;
  }
  list.innerHTML = works.slice().reverse().map(function (w) {
    const editRow = '<div style="text-align:right;margin-bottom:6px">' +
      '<span style="cursor:pointer;font-size:15px;margin-left:10px" onclick="editWork(' + w.id + ', event)">✏️</span>' +
      '<span style="cursor:pointer;font-size:15px;margin-left:10px" onclick="deleteWork(' + w.id + ', event)">🗑️</span></div>';
    if (w.status === '已完成') {
      const fr = state.results.find(function (r) { return r.workId === w.id && r.isFinal; });
      return '<div class="card">' + editRow + '<span class="status-chip done">✅ 已完成</span><h3>' + escHtml(w.name) + '</h3>' +
        '<button class="card-btn done" onclick="openResult(' + (fr ? fr.id : 0) + ')">查看成果</button></div>';
    }
    if (!w.started) {
      return '<div class="card">' + editRow + '<span class="status-chip waiting">⏳ 等待開始</span><h3>' + escHtml(w.name) + '</h3>' +
        '<button class="card-btn waiting" onclick="openWork(' + w.id + ')">開始</button></div>';
    }
    const step = currentStep(w);
    return '<div class="card">' + editRow + '<span class="status-chip doing">🟡 進行中</span><h3>' + escHtml(w.name) + '</h3>' +
      '<div class="line">目前：<b>' + step.role + '</b></div><div class="line">下一步：' + step.name + '</div>' +
      '<button class="card-btn doing" onclick="openWork(' + w.id + ')">繼續工作</button></div>';
  }).join('');
}

function renderAddWork() {
  const flow = FLOWS[pendingFlowId];
  document.getElementById('new-work-flow-name').textContent = flow.name;
  const stepsPreview = document.getElementById('new-work-flow-steps');
  stepsPreview.textContent = flow.steps.map(function (s) { return s.name; }).join(' → ');

  const switcher = document.getElementById('flow-switch-list');
  switcher.innerHTML = ALL_FLOW_IDS.map(function (fid) {
    const f = FLOWS[fid];
    const sel = fid === pendingFlowId ? ' selected' : '';
    return '<div class="template-pick' + sel + '" onclick="chooseFlow(\'' + fid + '\')">' + f.name + '</div>';
  }).join('');
}

function renderWorkDetail() {
  const work = getActiveWork();
  if (!work) { showScreen('screen-home'); return; }
  const flow = FLOWS[work.flowId];
  const step = currentStep(work);
  document.getElementById('wd-name').textContent = work.name;
  document.getElementById('wd-tpl').textContent = flow.name + '　·　共 ' + flow.steps.length + ' 步';
  document.getElementById('wd-step-name').textContent = step.name;
  document.getElementById('wd-role').textContent = ROLE_ICON[step.role] + ' ' + step.role;
  const suggested = suggestedToolForStep(work.flowId, step.role, step.name);
  document.getElementById('wd-ai-suggest').textContent = '建議找：' + suggested.name;
  document.getElementById('wd-ai-reason').textContent = suggested.reason || '';

  const toolsBox = document.getElementById('wd-recommended-tools');
  const toolChain = getRecommendedToolsChain(work.flowId, step.role, step.name);
  if (toolChain.length > 0) {
    const medals = ['🥇', '🥈', '🥉'];
    toolsBox.style.display = 'block';
    toolsBox.innerHTML = '<div class="section-label" style="margin-top:14px">💡 這一步適合的工具</div>' +
      toolChain.map(function (item, i) {
        const tool = getMyToolById(item.toolId);
        const label = tool ? tool.name : item.toolId;
        return '<div class="tool-suggest-row"><span class="medal">' + (medals[i] || '　') + '</span><b>' + escHtml(label) + '</b>　<span class="reason">' + escHtml(item.reason || '') + '</span></div>';
      }).join('') +
      '<div class="tool-suggest-note">這只是起點，你也可以用自己熟悉的工具。</div>';
  } else {
    toolsBox.style.display = 'none';
    toolsBox.innerHTML = '';
  }

  const track = document.getElementById('wd-progress');
  track.innerHTML = flow.steps.map(function (s, i) {
    let cls = 'progress-step';
    if (i < work.currentStepIndex) cls += ' done'; else if (i === work.currentStepIndex) cls += ' current';
    return '<div class="' + cls + '" title="' + s.name + '"></div>';
  }).join('');
}

// 把「專案背景 + 指令母模」的原始文字，轉成分段、分區塊的預覽畫面
// 複製出去的內容不受影響，還是完整原始文字（見 lastCopyText／copyToClipboard）
function renderCopyPreviewHtml(text) {
  const lines = text.split('\n');
  let html = '';
  let sectionOpen = false;
  function closeSection() { if (sectionOpen) { html += '</div></div>'; sectionOpen = false; } }
  lines.forEach(function (line) {
    if (line.indexOf('## ') === 0) {
      closeSection();
      html += '<div class="pack-section"><div class="pack-label">' + escHtml(line.slice(3)) + '</div><div class="pack-value">';
      sectionOpen = true;
    } else if (line.indexOf('# ') === 0) {
      closeSection();
      html += '<div class="pack-title">' + escHtml(line.slice(2)) + '</div>';
    } else if (line.trim() === '---') {
      closeSection();
      html += '<div class="pack-divider"></div>';
    } else if (line.trim() === '') {
      if (sectionOpen) html += '<br>';
    } else {
      html += escHtml(line) + '<br>';
    }
  });
  closeSection();
  return html;
}

let lastCopyText = '';

function renderCopyToAi() {
  const work = getActiveWork();
  lastCopyText = buildCopyText(work);
  document.getElementById('copy-text-box').innerHTML = renderCopyPreviewHtml(lastCopyText);
  document.getElementById('copy-ai-name').textContent = currentStepAiName();
}
// 特定步驟的字數建議（目前僅歌曲創作流程的 Lyrics／Style 有實際工具字數限制需要提醒）
// 依據 Suno 官方目前實際狀況（2026）：Lyrics 新版模型上限 5000 字，但 3000 字（約40-60行）內是實際好用的甜蜜點；
// Style 舊版模型上限 200 字，新版模型上限 1000 字，控制在 200 字內可相容所有版本
const LENGTH_GUIDANCE = {
  '歌詞創作': { soft: 3000, hard: 5000, note: 'Suno 歌詞欄位建議控制在 3000 字（約 40-60 行）內，太長容易被系統壓縮或搶拍；新版模型上限是 5000 字。' },
  '音樂風格': { soft: 200, hard: 1000, note: 'Suno 風格欄位建議控制在 200 字內，這樣不管新舊版本都能直接用；新版模型雖然可以到 1000 字，但精簡的效果通常更好。' }
};

function updatePasteBackCounter() {
  const work = getActiveWork();
  const stepName = currentStep(work).name;
  const guidance = LENGTH_GUIDANCE[stepName];
  const counterEl = document.getElementById('pb-char-counter');
  if (!guidance) { counterEl.style.display = 'none'; return; }

  const len = document.getElementById('paste-back-textarea').value.length;
  counterEl.style.display = 'block';
  let color = 'var(--text-dim)';
  let msg = len + ' 字';
  if (len > guidance.hard) { color = 'var(--red)'; msg += '　已超過上限，Suno 可能會拒絕或截斷內容'; }
  else if (len > guidance.soft) { color = 'var(--gold)'; msg += '　已超過建議長度，可以考慮精簡一點'; }
  counterEl.style.color = color;
  counterEl.textContent = msg;
}

function renderPasteBack() {
  const work = getActiveWork();
  const stepName = currentStep(work).name;
  document.getElementById('pb-step-name').textContent = stepName;
  const versions = (work.stepVersions && work.stepVersions[work.currentStepIndex]) || [];
  document.getElementById('pb-version-hint').textContent = versions.length > 0 ? '這會是第 v' + (versions.length + 1) + ' 版' : '這是第一版';

  const guidance = LENGTH_GUIDANCE[stepName];
  const guidanceEl = document.getElementById('pb-length-guidance');
  if (guidance) { guidanceEl.style.display = 'block'; guidanceEl.textContent = '💡 ' + guidance.note; }
  else { guidanceEl.style.display = 'none'; }
  updatePasteBackCounter();
}

function renderSatisfaction() {
  const r = getResult(lastSubmittedResultId);
  document.getElementById('sat-step-name').textContent = r.stepName;
  document.getElementById('sat-content-preview').textContent = r.content;
}

function renderReviseDirection() {
  const work = getActiveWork();
  const dirs = directionsFor(work.flowId, currentStep(work).name);
  const list = document.getElementById('direction-list');
  list.innerHTML = dirs.map(function (d) {
    return '<div class="template-pick" onclick="toggleDirection(\'' + d + '\', event)">' + d + '</div>';
  }).join('');
}

function renderReviseInstruction() {
  document.getElementById('revise-instruction-box').textContent = buildRevisionInstruction();
}

function renderAiTeam() {
  const list = document.getElementById('ai-team-list');
  list.innerHTML = ROLE_LIST.map(function (role) {
    const options = AI_OPTIONS.map(function (ai) {
      const sel = (state.roleAiMap[role] === ai) ? ' selected' : '';
      return '<option value="' + ai + '"' + sel + '>' + ai + '</option>';
    }).join('');
    return '<div class="role-row"><span class="role-name"><span class="icon">' + ROLE_ICON[role] + '</span>' + role + '</span>' +
      '<select onchange="updateRoleAi(\'' + role + '\', this.value)">' + options + '</select></div>';
  }).join('');
}

function isLatestVersion(r) {
  if (r.isFinal || r.stepIndex === undefined) return true;
  const hist = getVersionHistory(r);
  return hist.length > 0 && hist[hist.length - 1].id === r.id;
}

function renderAssets() {
  const tabs = document.getElementById('category-tabs');
  const cats = ['全部'].concat(CATEGORY_LIST);
  tabs.innerHTML = cats.map(function (c) {
    return '<div class="category-tab' + (c === activeCategory ? ' active' : '') + '" onclick="setCategory(\'' + c + '\')">' + c + '</div>';
  }).join('');
  const list = document.getElementById('assets-list');
  let items = state.results.slice().reverse().filter(isLatestVersion);
  if (activeCategory !== '全部') items = items.filter(function (r) { return r.category === activeCategory; });
  if (items.length === 0) { list.innerHTML = '<div class="empty-state"><div class="icon">📚</div><div class="txt">這個分類還沒有成果</div></div>'; return; }
  list.innerHTML = items.map(function (r) {
    const versions = getVersionHistory(r);
    const cloudBadge = r.isFinal ? (r.cloudStatus === 'saved' ? '<span class="final-badge" style="background:var(--green-soft)">☁️ 已存雲端</span>' : '') : '';
    return '<div class="result-card" onclick="openResult(' + r.id + ')">' +
      '<h4>' + escHtml(r.title) + (r.isFinal ? '<span class="final-badge">最終版</span>' : '') + cloudBadge + '</h4>' +
      '<div class="meta">來自「' + escHtml(r.projectName) + ' / ' + escHtml(r.workName) + '」　·　' + r.ai + '　·　' + formatDate(r.completedAt) + '</div>' +
      (versions.length > 1 ? '<div class="meta">版本數：v' + versions.length + '　修改次數：' + (versions.length - 1) + '</div>' : '') +
      (r.isFinal ? '<div class="meta">發布狀態：' + (isPublished(r.id) ? '已發布' : '尚未發布') + '</div>' : '') +
      '</div>';
  }).join('');
}

function renderAssetDetail() {
  const r = getResult(activeResultId);
  if (!r) { showScreen('screen-assets'); return; }
  document.getElementById('rd-title').textContent = r.title;
  document.getElementById('rd-meta').textContent = '來自「' + r.projectName + ' / ' + r.workName + '」　·　角色：' + r.role + '　·　使用：' + r.ai + '　·　' + formatDate(r.completedAt) + (r.version ? '　·　v' + r.version : '');
  document.getElementById('rd-content').textContent = r.content;
  document.getElementById('rd-final-btn').textContent = r.isFinal ? '取消最終成品標記' : '標記為最終成品';

  const versions = getVersionHistory(r);
  const historyBox = document.getElementById('rd-version-history');
  if (versions.length > 1) {
    historyBox.innerHTML = '<div class="section-label">版本歷程</div>' +
      versions.map(function (v) {
        return '<div class="template-pick' + (v.id === r.id ? ' selected' : '') + '" onclick="viewVersion(' + v.id + ')">v' + v.version + ' ' + escHtml(v.satisfaction || '') + '</div>';
      }).join('');
  } else {
    historyBox.innerHTML = '';
  }

  // 打磨這個版本：只有在「這個版本還是所屬工作目前正在進行的那一步」時才安全提供，
  // 避免工作已經往前推進後，打磨結果被錯誤接到別的步驟去
  const polishBox = document.getElementById('rd-polish-box');
  const ownerWork = state.works.find(function (w) { return w.id === r.workId; });
  const canPolishHere = !r.isFinal && ownerWork && ownerWork.currentStepIndex === r.stepIndex;
  polishBox.innerHTML = canPolishHere
    ? '<button class="btn outline" onclick="openPolishFromAsset(' + r.id + ')">🎨 打磨這個版本</button>'
    : '';

  const cloudBox = document.getElementById('rd-cloud-box');
  if (r.isFinal) {
    if (!state.gasWebhookUrl) {
      cloudBox.innerHTML = '<div class="notice">尚未開通雲端設定。</div>' +
        '<button class="btn outline" onclick="showScreen(\'screen-settings\')">前往我的工作台開通</button>';
    } else if (r.cloudStatus === 'saved') {
      cloudBox.innerHTML = '<div class="notice">☁️ 已加入雲端作品庫</div>';
    } else {
      cloudBox.innerHTML = '<div class="notice">尚未存雲端</div>' +
        '<button class="btn outline" onclick="saveToCloud(' + r.id + ')">☁️ 存到我的雲端作品庫</button>';
    }
  } else {
    cloudBox.innerHTML = '<div class="notice">尚未完成打磨，暫不建議發布。</div>';
  }
}

function renderPublish() {
  const finals = state.results.filter(function (r) { return r.isFinal; });
  const pending = finals.filter(function (r) { return !isPublished(r.id); });
  const published = finals.filter(function (r) { return isPublished(r.id); });

  const pendingList = document.getElementById('publish-pending-list');
  pendingList.innerHTML = pending.length === 0
    ? '<div class="empty-state"><div class="icon">📭</div><div class="txt">目前沒有待發布的成品</div></div>'
    : pending.map(function (r) {
      const paperNote = r.category === '論文'
        ? '<div class="meta">未來支援格式：DOCX／PDF／Google Docs／簡報／摘要版／投稿版（本輪僅列出，尚未實作真正匯出）</div>'
        : '';
      return '<div class="result-card"><h4>' + escHtml(r.title) + '</h4>' +
        '<div class="meta">' + escHtml(r.projectName) + '　·　' + formatDate(r.completedAt) + '</div>' +
        paperNote +
        '<div class="action-row" style="margin-top:10px">' +
        '<button class="btn outline" onclick="openPublishAssistant(' + r.id + ')">✍️ 產生發布文案</button>' +
        '</div>' +
        '<button class="btn outline" onclick="markPublished(' + r.id + ')">標記為已發布</button></div>';
    }).join('');

  const pubList = document.getElementById('publish-published-list');
  pubList.innerHTML = published.length === 0
    ? '<div class="empty-state"><div class="icon">📢</div><div class="txt">還沒有發布紀錄</div></div>'
    : published.map(function (r) {
      return '<div class="result-card" onclick="openResult(' + r.id + ')"><h4>' + escHtml(r.title) + '</h4><div class="meta">' + escHtml(r.projectName) + '</div></div>';
    }).join('');

  const logList = document.getElementById('publish-log-list');
  logList.innerHTML = state.publishRecords.length === 0
    ? '<div class="empty-state"><div class="icon">🗒️</div><div class="txt">還沒有發布紀錄</div></div>'
    : state.publishRecords.slice().reverse().map(function (p) {
      return '<div class="result-card"><h4>' + escHtml(p.title) + '</h4><div class="meta">發布於 ' + formatDate(p.publishedAt) + '</div></div>';
    }).join('');
}

function renderPublishAssistant() {
  const r = getResult(activePublishAssistantResultId);
  if (!r) { showScreen('screen-publish'); return; }
  document.getElementById('pa-title').textContent = r.title;
  const list = document.getElementById('pa-channel-list');
  list.innerHTML = PUBLISH_CHANNELS.map(function (ch) {
    const draft = buildChannelDraft(ch, r);
    return '<div class="card"><h3>' + ch + '</h3>' +
      '<div class="copy-box" style="margin-bottom:10px">' + escHtml(draft) + '</div>' +
      '<button class="btn outline" onclick="copyChannelDraft(\'' + ch + '\')">複製 ' + ch + ' 文案</button></div>';
  }).join('');
}

function renderFlowMarket() {
  const list = document.getElementById('flow-market-list');
  list.innerHTML = MARKET_FLOW_IDS.map(function (fid) {
    const intro = FLOW_INTRO[fid];
    const flow = FLOWS[fid];
    return '<div class="market-card" onclick="openFlowIntro(\'' + fid + '\')">' +
      '<h3>' + intro.emoji + ' ' + intro.label + '</h3>' +
      '<div class="who">共 ' + flow.steps.length + ' 個步驟</div>' +
      '</div>';
  }).join('');
}

function renderFlowIntro() {
  const fid = activeFlowIntroId;
  const intro = FLOW_INTRO[fid];
  const flow = FLOWS[fid];
  document.getElementById('fi-title').textContent = intro.emoji + ' ' + intro.label;
  document.getElementById('fi-produces').innerHTML = '<div class="section-label">這套流程會完成什麼？</div>' +
    '<ul style="padding-left:20px;font-size:14px;line-height:1.9;color:var(--text)">' +
    intro.produces.map(function (p) { return '<li>' + escHtml(p) + '</li>'; }).join('') + '</ul>';

  const roles = flow.steps.map(function (s) { return s.role; });
  const uniqueRoles = roles.filter(function (r, i) { return roles.indexOf(r) === i; });
  document.getElementById('fi-ai-team').innerHTML = '<div class="section-label" style="margin-top:18px">目前合作角色</div>' +
    '<div style="font-size:14px;line-height:2.2;color:var(--text)">' +
    uniqueRoles.map(function (r) { return ROLE_ICON[r] + ' ' + r; }).join('　→　') + '</div>';
}

function renderSettings() {
  document.getElementById('settings-username').value = state.userName;
  document.getElementById('settings-workspacename').value = state.workspaceName;
  document.getElementById('settings-count').textContent = state.projects.length + ' 個專案、' + state.works.length + ' 件工作、' + state.results.length + ' 筆成果';
  document.getElementById('settings-gas-url').value = state.gasWebhookUrl || '';
}

// ── 我的工具 ──────────────────────────────────────────────────
function renderMyTools() {
  const list = document.getElementById('my-tools-list');
  if (state.myTools.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">🧰</div><div class="txt">還沒有任何工具，先新增一個吧</div></div>';
    return;
  }
  list.innerHTML = state.myTools.map(function (t) {
    const deleteBtn = t.isCustom
      ? '<button class="tool-delete" onclick="deleteCustomTool(\'' + t.id + '\')" title="刪除">🗑️</button>'
      : '';
    return '<div class="tool-row">' +
      '<div class="tool-info"><span class="tool-emoji">' + (t.emoji || '🔧') + '</span>' +
      '<div><div class="tool-name">' + escHtml(t.name) + '</div><div class="tool-category">' + escHtml(t.category) + (t.isCustom ? '　·　我自己加的' : '') + '</div></div></div>' +
      '<div class="tool-actions">' +
      '<label class="toggle-switch"><input type="checkbox" ' + (t.enabled ? 'checked' : '') + ' onchange="toggleMyTool(\'' + t.id + '\')"><span class="toggle-slider"></span></label>' +
      deleteBtn +
      '</div></div>';
  }).join('');
}

// ── AI 指令庫（指令母模瀏覽）───────────────────────────────────
let activePromptFilter = '全部';
let activePromptTemplateId = null;

function setPromptFilter(type) { activePromptFilter = type; renderPromptLibrary(); }
function openPromptTemplateDetail(id) { activePromptTemplateId = id; showScreen('screen-prompt-detail'); }

function renderPromptLibrary() {
  const tabTypes = ['全部', 'global_role', 'flow_specific', 'polish', 'handoff'];
  const tabs = document.getElementById('prompt-filter-tabs');
  tabs.innerHTML = tabTypes.map(function (t) {
    const label = t === '全部' ? '全部' : PROMPT_TEMPLATE_TYPE_LABEL[t];
    return '<div class="category-tab' + (t === activePromptFilter ? ' active' : '') + '" onclick="setPromptFilter(\'' + t + '\')">' + label + '</div>';
  }).join('');

  const list = document.getElementById('prompt-list');
  let items = state.promptTemplates.slice();
  if (activePromptFilter !== '全部') items = items.filter(function (t) { return t.type === activePromptFilter; });

  if (items.length === 0) { list.innerHTML = '<div class="empty-state"><div class="icon">🧠</div><div class="txt">這個分類還沒有模板</div></div>'; return; }
  list.innerHTML = items.map(function (t) {
    return '<div class="result-card" onclick="openPromptTemplateDetail(' + t.id + ')">' +
      '<h4>' + escHtml(t.name) + (t.isDefault ? '<span class="final-badge">系統預設</span>' : '') + '</h4>' +
      '<div class="meta">' + PROMPT_TEMPLATE_TYPE_LABEL[t.type] + '　·　v' + t.version + '</div></div>';
  }).join('');
}

function renderPromptDetail() {
  const t = state.promptTemplates.find(function (x) { return x.id === activePromptTemplateId; });
  if (!t) { showScreen('screen-prompt-library'); return; }
  document.getElementById('pd-title').textContent = t.name;
  document.getElementById('pd-meta').textContent = PROMPT_TEMPLATE_TYPE_LABEL[t.type] + '　·　v' + t.version + '　·　' + (t.isDefault ? '系統預設' : '自訂') + (t.flowType ? '　·　流程：' + (FLOWS[t.flowType] ? FLOWS[t.flowType].name : t.flowType) : '') + (t.role ? '　·　角色：' + t.role : '');
  document.getElementById('pd-content').textContent = t.content;
}

function formatDate(iso) { const d = new Date(iso); return (d.getMonth() + 1) + '/' + d.getDate(); }
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── 啟動 ──────────────────────────────────────────────────────
// 先載入工具資料（官方工具清單／合作模板），確保 loadState() 建立預設狀態時 TOOLS_CATALOG 已經就緒
function startApp() {
  loadState();
  showScreen('screen-home');
}
loadToolData().then(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }
});
