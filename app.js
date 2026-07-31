'use strict';

/* ============================================================
   AI 工作台 v3（Sprint 003）— People First 架構
   Workspace → Project → Work → Flow → AI Team → Asset Library → Publish Center
   資料以 localStorage 為主要保存位置；Google Drive Backup（MVP）是使用者主動選擇才會用到的
   選配備援——只在使用者點擊「立即備份」／「還原」時才連接 Google 帳號，不做背景自動同步、
   不做靜默登入，且只申請 drive.appdata（App 專屬隱藏資料夾）＋ openid/email（僅用於畫面
   顯示目前連接哪個帳號）這兩類最小權限，不讀取使用者 Drive 裡的其他檔案。
   ============================================================ */

const STORAGE_KEY = 'ai_workspace_v3';
// Google Drive Backup MVP：本機／備份檔資料結構版本號，見 defaultState()／ensureNewFields()／
// migrateSchema() 的說明。
const CURRENT_SCHEMA_VERSION = 1;

// ── 角色（8 個，AI 可換）──────────────────────────────────────
const ROLE_LIST = ['規劃師', '研究員', '寫作師', '潤稿師', '設計師', '工程師', '審查員', '發布助手'];
const ROLE_ICON = { '規劃師': '🧭', '研究員': '🔎', '寫作師': '✍️', '潤稿師': '🌿', '設計師': '🎨', '工程師': '🛠️', '審查員': '🔍', '發布助手': '📮' };
const ROLE_AI_DEFAULT = {
  '規劃師': 'ChatGPT', '研究員': 'Gemini', '寫作師': 'Claude', '潤稿師': 'Claude',
  '設計師': 'ChatGPT', '工程師': 'Claude Code', '審查員': '自己', '發布助手': '自己'
};
const AI_OPTIONS = ['ChatGPT', 'Claude', 'Gemini', 'Claude Code', 'Codex', '自己', '其他'];

// ── 常用 AI（Preferred AI，Starter Alpha，Minimum Tools Principle 的落地機制）──
// 使用者第一次使用時選「目前最常用哪一個 AI」，之後所有 Official Flow 都優先建議這個 AI，
// 只有在某一步官方建議明顯更適合時，才另外用「智慧推薦」提示，且可以忽略、不強制切換。
const PREFERRED_AI_OPTIONS = ['ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'Copilot', 'Grok'];

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
  { id: 'chatgpt', name: 'ChatGPT', category: 'AI', emoji: '🤖', specialty: '發想、整理、互動打磨與一步一步完成內容', suitableFor: '主題、文案、歌詞、腳本、規劃與初學者協作', url: 'https://chatgpt.com' },
  { id: 'claude', name: 'Claude', category: 'AI', emoji: '🧠', specialty: '長文整理、深度分析與文件品質打磨', suitableFor: '教材、電子書、提案、報告與長篇內容', url: 'https://claude.ai' },
  { id: 'gemini', name: 'Gemini', category: 'AI', emoji: '✨', specialty: '資訊查詢、資料整合與研究整理', suitableFor: '市場研究、資料蒐集、趨勢與需要外部資訊的工作', url: 'https://gemini.google.com' }
];

// Correction Proposal Stage D：外部工具的官方入口網址統一從這裡查（來源是 tools-catalog.json
// 每個工具自己的 url 欄位，離線／載入失敗時退回 TOOLS_CATALOG_FALLBACK），不在各畫面各自寫死
// 網址字串——這是 renderToolGuide()／renderToolRecommendationCard()／screen-tool-companion／
// 逐幕「開啟推薦工具」按鈕共用的唯一查詢入口。找不到就回傳 null，呼叫端各自決定安全降級方式
// （通常是不顯示開啟連結，不開啟空白頁或錯誤連結）。
function getToolUrlById(toolId) {
  const tool = TOOLS_CATALOG.find(function (t) { return t.id === toolId; });
  return (tool && tool.url) || null;
}

// 統一的「開啟工具」連結產生器：沒有網址時回傳空字串（安全降級，不渲染任何連結），
// 有網址時一律 target="_blank" rel="noopener"，不取代目前頁面、不會讓使用者迷路。
function buildToolOpenLinkHtml(toolId, label, extraStyle) {
  const url = getToolUrlById(toolId);
  if (!url) return '';
  return '<a class="btn outline" style="margin-top:6px;text-decoration:none;display:block;text-align:center' + (extraStyle || '') + '" href="' + escHtml(url) + '" target="_blank" rel="noopener">' + escHtml(label) + '</a>';
}

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

// 找官方合作模板裡，這個流程＋角色（可選：精準比對步驟名稱）的建議工具鏈。
// 找不到精準比對的步驟時，優雅退回這個角色的通用建議（沒有 stepName 的那筆），這是原本就有的
// 行為——「哪個 AI 適合協助寫這一步」就算不夠精準也總比完全沒建議好。
function getRecommendChain(flowId, role, stepName) {
  const tpl = COLLAB_TEMPLATES[flowId];
  if (!tpl) return [];
  const steps = tpl.steps.filter(function (s) { return s.role === role; });
  const exact = steps.find(function (s) { return s.stepName === stepName; });
  if (exact) return exact.recommend || [];
  const generic = steps.find(function (s) { return !s.stepName; });
  return generic ? (generic.recommend || []) : (steps[0] ? steps[0].recommend || [] : []);
}

// Official Recommendation Center（Phase 1B）：這一步「真正要交給哪個工具做成品」的建議鏈，
// 跟 getRecommendChain（挑一個 AI 協助寫指令）是兩件不同的事，語意上刻意只做精準比對、
// 不退回其他步驟的建議——推薦錯的生成工具比完全不推薦更糟，找不到就該讓呼叫端顯示
// 「目前尚無官方建議」，不是硬塞一個可能不相關的答案。category 只有「製作影片」這種
// 同一步驟內有多個性質不同子階段（圖片 vs 影片）時才需要，其餘留空即可。
const NO_OFFICIAL_RECOMMENDATION_MESSAGE = '目前尚無官方建議。建議先使用 ChatGPT（一般規劃）或依照你熟悉的 AI／工具進行本步驟。';

// Official Recommendation Center 對外的統一查詢入口（Phase 1B）：把 chain 資料轉成畫面要用的形狀
// （主要建議＋其他可選＋找不到時的固定回覆），renderToolGuide／renderToolRecommendationCard
// 都改從這裡拿資料，不再各自組字串或各自決定「沒有建議時要顯示什麼」。
function getOfficialToolRecommendation(flowId, role, stepName, category) {
  const chain = getRecommendedToolsChain(flowId, role, stepName, category);
  if (!chain.length) return { hasRecommendation: false, message: NO_OFFICIAL_RECOMMENDATION_MESSAGE };
  const entries = chain.map(function (c) {
    const tool = getMyToolById(c.toolId);
    // validation／lastVerified（Phase 1B.1 資料模型收尾）：先把欄位帶過來，畫面目前還沒有地方顯示，
    // 之後要加「這筆建議驗證到什麼程度」的提示時，資料已經在，不用再回頭補一次管線。
    // toolId（Correction Proposal Stage D）：讓 withOfficialRecommendation() 能把「實際被推薦的
    // 是哪個工具 id」傳給 renderToolGuide()，開啟按鈕的網址才會永遠對應「畫面上顯示的那個名字」，
    // 不會在未來調整推薦順位（Stage E）後，名字換了、連結卻還指向舊工具。
    // Correction Proposal Stage E：擴充官方推薦資料結構，讓每個工具能完整說明「為什麼推薦、
    // 適合什麼情境、手機操作、使用心得、費用提醒、注意事項」，不是只有一句 reason。這幾個欄位
    // 目前只有 video／工程師／製作影片／category:video 這條鏈有填寫（本輪校準範圍），其餘 Flow
    // 的既有資料沒有這些欄位也完全沒關係——都是可選欄位，畫面端只在有值時才顯示對應那一行。
    return {
      toolId: c.toolId,
      name: tool ? tool.name : c.toolId, rating: c.rating || null, fitFor: c.fitFor || null, reason: c.reason || null, openUrl: c.openUrl || null,
      validation: c.validation || null, lastVerified: c.lastVerified || null,
      positioning: c.positioning || null, whyRecommended: c.whyRecommended || null, bestFor: c.bestFor || null,
      mobileExperience: c.mobileExperience || null, experienceNote: c.experienceNote || null,
      pricingNote: c.pricingNote || null, caution: c.caution || null
    };
  });
  return { hasRecommendation: true, primary: entries[0], alternatives: entries.slice(1) };
}

// 把 TOOL_GUIDES 裡「怎麼用這個工具」的固定教學內容（toolIntro／toolFeatures／steps／
// completionReminder／firstTimeReminder／openToolLabel／openToolUrl）留在原地不動，只把
// 「該推薦誰、為什麼、還有什麼替代方案」這幾個欄位換成 Official Recommendation Center 查出來的
// 資料——Center 管的是推薦規則，不是使用教學，這兩件事本來就該分開維護。
function withOfficialRecommendation(baseGuide, flowId, role, stepName, category) {
  const rec = getOfficialToolRecommendation(flowId, role, stepName, category);
  if (!rec.hasRecommendation) {
    return Object.assign({}, baseGuide, { noOfficialRecommendation: true, noRecommendationMessage: rec.message });
  }
  return Object.assign({}, baseGuide, {
    toolName: rec.primary.name,
    toolId: rec.primary.toolId,
    rating: rec.primary.rating,
    fitFor: rec.primary.fitFor,
    positioning: rec.primary.positioning,
    whyRecommended: rec.primary.whyRecommended,
    mobileExperience: rec.primary.mobileExperience,
    pricingNote: rec.primary.pricingNote,
    caution: rec.primary.caution,
    altTools: rec.alternatives
  });
}

function getRecommendedToolsChain(flowId, role, stepName, category) {
  const tpl = COLLAB_TEMPLATES[flowId];
  if (!tpl) return [];
  const steps = tpl.steps.filter(function (s) { return s.role === role && s.stepName === stepName; });
  if (category) {
    const withCategory = steps.find(function (s) { return s.category === category; });
    if (withCategory) return withCategory.recommendedTools || [];
  }
  const noCategory = steps.find(function (s) { return !s.category; });
  return (noCategory && noCategory.recommendedTools) || (steps[0] && steps[0].recommendedTools) || [];
}

// 核心推薦引擎：依序嘗試 → 使用者手動指定（AI團隊，且該工具目前仍啟用，屬於明確覆蓋，優先權最高）
// → 使用者設定的常用 AI（Preferred AI，Starter 預設機制）→ 官方建議鏈中使用者有的工具
// → 使用者任何一個啟用中的工具 → 通用防呆文字。任何情況都會回傳可用結果，不會中斷、不會報錯
function suggestedToolForStep(flowId, role, stepName) {
  const manual = state.roleAiMap[role];
  // roleAiMap 預設就會對 8 個角色都填好初始值（ROLE_AI_DEFAULT），這不代表使用者「手動選過」，
  // 只有跟預設值不一樣，才代表使用者真的在 AI 團隊畫面自己改過，這種情況才優先於常用 AI 與官方建議
  const isExplicitOverride = manual && manual !== ROLE_AI_DEFAULT[role];
  if (isExplicitOverride && isToolEnabledByName(manual)) return { name: manual, reason: null, isPreferred: false };

  const preferred = state.myAiList && state.myAiList[0];
  if (preferred) return { name: preferred, reason: null, isPreferred: true };

  const chain = getRecommendChain(flowId, role, stepName);
  for (var i = 0; i < chain.length; i++) {
    const tool = getMyToolById(chain[i].toolId);
    if (tool && tool.enabled) return { name: tool.name, reason: chain[i].reason || null, isPreferred: false };
  }

  // 官方模板沒有建議、或建議的工具使用者都沒有 → 退回目前設定值（如果還啟用中）
  if (manual && isToolEnabledByName(manual)) return { name: manual, reason: null, isPreferred: false };

  const anyEnabled = state.myTools.find(function (t) { return t.enabled; });
  if (anyEnabled) return { name: anyEnabled.name, reason: '目前可用的工具', isPreferred: false };

  return { name: manual || ROLE_AI_DEFAULT[role] || '你習慣使用的 AI', reason: null, isPreferred: false };
}

// ── AI 協作夥伴導航（AI Collaboration Calibration MVP）───────────
// AI 特長／適合情境文案集中存在 tools-catalog.json（category:'AI' 的項目），畫面只負責讀取，
// 之後工具更新只需要改那一份資料，不會散落在多個畫面。取代原本的「智慧推薦」（capabilityRecommendationForStep）
// 那套「額外跳一張可忽略/可靜音的提示卡」——同樣的資訊現在直接以「其他可選夥伴」卡片的形式常駐顯示，
// 使用者隨時可以點選，不需要先接受或關閉一張隱藏在旁邊的建議卡，更符合 Recommendation First, Choice Always。
function getAiPartnerCatalog() {
  return TOOLS_CATALOG.filter(function (t) { return t.category === 'AI' && t.specialty && t.suitableFor; });
}
function getAiPartnerByName(name) {
  return getAiPartnerCatalog().find(function (t) { return t.name === name; });
}

// 這一步「真正該推薦」的 AI 夥伴：直接依官方合作模板的建議鏈（跟目前 Flow／Step／Role 的工作需要有關），
// 不看使用者個人的常用 AI 或手動覆蓋——這樣「⭐ 這一步建議」才不會被使用者自己過去的選擇蓋掉
// （沿用既有 getRecommendChain／getMyToolById／isToolEnabledByName，沒有另建推薦引擎）。
// 官方建議鏈沒有資料，或建議的工具都沒有特長文案時，優雅退回目前系統本來就會用的 AI，一定有結果可顯示。
function officialSuggestedAiForStep(flowId, role, stepName) {
  const chain = getRecommendChain(flowId, role, stepName);
  for (var i = 0; i < chain.length; i++) {
    const tool = getMyToolById(chain[i].toolId);
    if (tool && tool.enabled && getAiPartnerByName(tool.name)) return tool.name;
  }
  return suggestedToolForStep(flowId, role, stepName).name;
}

// 使用者選擇這一步的協作夥伴：沿用既有的角色 AI 選擇欄位（state.roleAiMap，跟「AI 團隊」設定同一個機制），
// 不新增資料模型；因為是依角色保存，同角色的其他工作／步驟也會沿用這個選擇，這是既有設計，這輪沒有更動。
function chooseAiForStep(name) {
  const work = getActiveWork();
  const role = currentStep(work).role;
  updateRoleAi(role, name);
  showToast('已選擇 ' + name + ' 作為這一步的協作夥伴');
  renderWorkDetail();
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
  // Phase 1A（material 重複步驟收斂，見 Sprint 0 稽核 12.6 節）：原本「Review」與「作品打磨」
  // 兩步角色都是審查員，也都沒有 flow_specific 模板（兩者原本都落到同一個 global_role 審查員
  // 模板），是純粹的流程設計冗餘，不是內容缺口，合併成一步不影響任何 Prompt 內容。
  // 已知風險（見 Phase 1A 完成報告「新發現風險」）：如果有既有使用者的 material 工作剛好停在
  // 舊版第 5-6 步（Review／作品打磨），步驟數變動後 currentStepIndex 可能對不齊；material Flow
  // 目前沒有真人使用資料（Sprint 0 稽核已確認），影響範圍評估為低，故不另外寫遷移邏輯。
  material: {
    id: 'material', name: '教材出版流程',
    steps: [
      { name: '教材規劃', role: '規劃師', category: '教材' },
      { name: '資料蒐集', role: '研究員', category: '教材' },
      { name: '教材撰寫', role: '寫作師', category: '教材' },
      { name: '潤稿', role: '潤稿師', category: '教材' },
      { name: '審查與打磨', role: '審查員', category: '教材' },
      { name: '發布素材', role: '發布助手', category: '教材' }
    ]
  },
  // Video Production Studio Sprint 1（依 docs/video-production-flow-v2.md 設計文件實作）：
  // 原本 7 步（主題/腳本/開場Hook/分鏡/字幕/發布文案/作品打磨）收斂成 3 步，
  // 「腳本」一次產出含開場鉤子與字卡重點的完整文字，不用分三步；發布文案／作品打磨
  // 移除（每個 Flow 只完成一種 Deliverable，作品打磨已有 Polish Studio 通用機制涵蓋）；
  // 「製作影片」比照歌曲 Flow「製作歌曲」，不是 AI 寫文字，是帶著已完成內容去外部工具動手做。
  //
  // Video Workflow vNext（CEO 核准）：新增「配音與字幕」步驟，插在「腳本」與「製作影片」
  // 之間——這是本輪真人測試發現的必做項目（逐幕配音稿／語氣／語速停頓／字幕），不是
  // 資料契約或畫面骨架，是真正呼叫 AI 產出正式文字的一步。「製作影片」維持在陣列最後一個，
  // MVD／isWorkComplete() 判斷「最後一步」的既有邏輯不受影響。
  video: {
    id: 'video', name: '影片製作流程',
    steps: [
      { name: '主題', role: '規劃師', category: '影片' },
      { name: '腳本', role: '寫作師', category: '腳本' },
      { name: '配音與字幕', role: '寫作師', category: '腳本' },
      { name: '製作影片', role: '工程師', category: '影片' }
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
  // 商品行銷工作區重整（第一個子工作，2026-07-14）：行銷海報是獨立的短流程，
  // 只完成一種 Deliverable（海報），比照歌曲／影片的「Production Studio」模式——
  // 文字步驟走一般交給AI／貼回，最後一步「完成海報」是真正把圖片工具的產出帶回來，
  // 不是 AI 寫文字，跟 screen-make-song／screen-make-video 是同一套設計。
  poster: {
    id: 'poster', name: '行銷海報流程',
    steps: [
      { name: '海報文案', role: '寫作師', category: '商品' },
      { name: '視覺設計', role: '設計師', category: '海報' },
      { name: '完成海報', role: '工程師', category: '海報' }
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
  // Sprint「歌曲 Production Flow MVP」新增「製作歌曲」步驟：把歌詞＋音樂風格實際帶去音樂工具生成歌曲，
  // 這一步不是「AI 寫文字」，是「帶著已完成的內容去外部工具動手做」，見 renderWorkDetail() 的專屬導轉
  // Product Review「歌曲 Flow 與影片 Flow 架構調整」：每個 Official Flow 只負責完成一種 Deliverable，
  // 歌曲 Flow 的成果只到「歌曲」為止，移除封面／MV／發布文案（封面/MV 屬於未來的影片製作 Flow，Sprint #05）
  song: {
    id: 'song', name: '歌曲創作流程',
    steps: [
      { name: '主題', role: '規劃師', category: '歌曲' },
      { name: '歌名＋歌詞', role: '寫作師', category: '歌曲' },
      { name: '音樂風格', role: '工程師', category: '歌曲' },
      { name: '製作歌曲', role: '工程師', category: '歌曲' }
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
  song: { emoji: '🎵', label: '歌曲創作', produces: ['歌曲主題', '歌詞（可直接貼 Lyrics）', '音樂風格（可直接貼 Style of Music）', '完成的歌曲（由你習慣使用的音樂工具生成）'] },
  video: { emoji: '🎬', label: '影片製作', produces: ['影片主題', '完整腳本（含開場與字卡重點）', '完成的影片（由你習慣使用的影片工具生成）'] },
  material: { emoji: '📚', label: '教材出版', produces: ['教材規劃', '蒐集資料', '教材內文', '潤稿後定稿', '打磨過的最終版'] },
  ebook: { emoji: '📖', label: '電子書', produces: ['大綱', '蒐集資料', '內文', '排版設計'] },
  product: { emoji: '🛍️', label: '商品行銷', produces: ['商品整理', '賣點分析', '文案', '商品圖'] },
  website: { emoji: '🌐', label: '建立網站', produces: ['網站規劃', '內容文字', '頁面設計', '網站建置'] },
  course: { emoji: '🎤', label: '課程設計', produces: ['課程大綱', '課程內容', '潤稿後定稿'] },
  social: { emoji: '📱', label: '社群貼文', produces: ['主題發想', '貼文文案', '配圖建議'] },
  research: { emoji: '🧪', label: '研究與論文寫作', produces: ['研究題目與問題', '文獻蒐集與整理', '研究架構', '論文大綱', '初稿', '引用與參考資料', '摘要與關鍵字', '打磨過的最終版'] },
  custom: { emoji: '✍️', label: '自訂流程', produces: ['依你的需求自由發揮'] }
};
const MARKET_FLOW_IDS = ['song', 'video', 'material', 'ebook', 'product', 'poster', 'website', 'course', 'social', 'research', 'custom'];

// ── 影片類型（Video Production Studio Sprint 1：新增工作時快速選一種，存在 work.videoType）──
// Sprint 2 依這個分類做「素材生成」自動分流：預設圖片比例／數量、推薦工具
const VIDEO_TYPES = [
  { id: 'song_mv', emoji: '🎵', label: '歌曲 MV' },
  { id: 'product', emoji: '📦', label: '商品介紹' },
  { id: 'brand', emoji: '🏢', label: '品牌影片' },
  { id: 'course', emoji: '📚', label: '教材' },
  { id: 'travel', emoji: '✈️', label: '旅遊' },
  { id: 'life_story', emoji: '❤️', label: '人生故事' },
  { id: 'custom', emoji: '✍️', label: '自訂' }
];

// ── 圖片比例／數量（Video Production Studio Sprint 2：用途導向，不要求使用者理解 Aspect Ratio）──
// 依 docs/video-production-flow-v2.md 第六/七節：Starter 預設直式，圖片數量預設 3 張（好上手、有基本敘事感）
const VIDEO_RATIO_OPTIONS = [
  { id: 'portrait', emoji: '📱', label: '直式', uses: 'Shorts／Reels／TikTok／手機觀看', starter: true },
  { id: 'landscape', emoji: '🖥️', label: '橫式', uses: 'YouTube／教學／品牌影片' },
  { id: 'square', emoji: '🟦', label: '方形', uses: '社群／商品展示' }
];
const VIDEO_IMAGE_COUNT_OPTIONS = [
  { count: 1, label: '1 張（最快）' },
  { count: 3, label: '3 張（建議，好上手）' },
  { count: 6, label: '6 張' },
  { count: 12, label: '12 張（適合已經比較熟悉的人）' }
];
// CEO 真人驗收 Blocker #2：跟上面 VIDEO_IMAGE_COUNT_OPTIONS 是兩件不同的事——那組只是
// Phase A 畫面上「這支影片大概要準備幾張圖片」的提示選項，跟逐幕母稿完全無關；這組才是
// 「目前所有場景都沒有有效 imagePrompt」時，用來決定要把乾淨旁白重新切成幾幕的補救入口
// （見 generateImagePromptsForAllScenes()）。刻意不重用同一組選項或同一個 UI，避免使用者
// 誤以為調整「圖片數量」提示也會影響已經產生好的逐幕內容。
const IMAGE_RECOVERY_COUNT_OPTIONS = [3, 5, 8, 10];
// 影片類型沒有明確理由需要橫式／方形時，一律用 Starter 預設「直式」，這是設計文件的判斷，不是每種類型都有強烈理由
const VIDEO_TYPE_DEFAULTS = {
  song_mv: { ratio: 'portrait', count: 3 },
  product: { ratio: 'square', count: 3 },
  brand: { ratio: 'landscape', count: 3 },
  course: { ratio: 'landscape', count: 3 },
  travel: { ratio: 'portrait', count: 3 },
  life_story: { ratio: 'portrait', count: 3 },
  custom: { ratio: 'portrait', count: 3 }
};
function videoTypeDefaults(videoType) { return VIDEO_TYPE_DEFAULTS[videoType] || VIDEO_TYPE_DEFAULTS.custom; }

// ── 依影片類型推薦工具（Sprint 2：只用 tools-catalog.json 已有的工具，Kling／剪映／開拍等 Tool Companion 留給 Sprint 3）──
const VIDEO_TYPE_TOOL_RECOMMENDATIONS = {
  song_mv: [
    { toolId: 'runway', reason: '很多創作者會用 Runway 把圖片變成有動態感的畫面，適合歌曲 MV。' },
    { toolId: 'pika', reason: '如果想快速比較不同風格的動態效果，Pika 生成速度也很快。' }
  ],
  product: [
    { toolId: 'canva', reason: '商品介紹很多人會用 Canva 排版，模板多、好上手。' },
    { toolId: 'capcut', reason: '如果有實拍畫面要剪接，CapCut 是常見的搭配工具。' }
  ],
  brand: [
    { toolId: 'canva', reason: '品牌影片需要維持一致的視覺風格，Canva 的版型跟品牌工具比較方便。' },
    { toolId: 'capcut', reason: '剪接與字卡可以用 CapCut 完成。' }
  ],
  course: [
    { toolId: 'canva', reason: '教材類影片常需要圖文並茂的版面，Canva 很適合。' },
    { toolId: 'capcut', reason: '搭配字卡與重點標註，CapCut 很順手。' }
  ],
  travel: [
    { toolId: 'capcut', reason: '旅遊影片很多人會直接用 CapCut 剪接實拍片段，模板也多。' },
    { toolId: 'runway', reason: '如果想幫幾張照片加上動態感，也可以用 Runway。' }
  ],
  life_story: [
    { toolId: 'capcut', reason: '人生故事類影片很多人會用 CapCut，搭配音樂跟字卡說故事。' },
    { toolId: 'canva', reason: '如果想要更精緻的排版，也可以用 Canva。' }
  ],
  custom: [
    { toolId: 'capcut', reason: '不確定要用什麼工具的話，CapCut 是很多人習慣的起點，能剪接也能加字卡。' }
  ]
};
function getVideoTypeToolRecommendations(videoType) { return VIDEO_TYPE_TOOL_RECOMMENDATIONS[videoType] || VIDEO_TYPE_TOOL_RECOMMENDATIONS.custom; }

// ── 創作偏好（Creative Preferences MVP：只有 song／video 兩個 Flow 有意義）──
// 目標：新手完全不設定也有系統推薦偏好可用，展開後才需要調整；掛在 work.creativePreferences，
// 舊工作沒有這個欄位時不報錯，直接用該 Flow 的系統預設（見 resolveCreativePreferences）。
// productPhrase：v1.2（Product Language First）新增，給收合狀態「目前作品風格」用，
// 必須是作品感受用詞，不是 label 的改寫——跟 label 同一個物件，不是另一份對照表，
// 改 label 時一定會看到旁邊的 productPhrase，降低兩者兜不起來的風險。
const CREATIVE_PREFERENCE_CATEGORIES = {
  song: [
    { key: 'vocal', label: '唱腔', options: [
      { id: 'gentle', label: '溫柔', default: true, productPhrase: '像老朋友輕聲陪伴' },
      { id: 'fresh', label: '清新', productPhrase: '聽起來清爽自然' },
      { id: 'powerful', label: '有力量', productPhrase: '情緒有力量但不失親切' }
    ] },
    { key: 'mood', label: '情緒', options: [
      { id: 'warm', label: '溫暖', default: true, productPhrase: '溫暖療癒、讓人放鬆' },
      { id: 'healing', label: '療癒', productPhrase: '帶來安定與被陪伴的感覺' },
      { id: 'happy', label: '快樂', productPhrase: '輕鬆明亮、讓人想微笑' },
      { id: 'hopeful', label: '希望', productPhrase: '有向前走的力量與光亮感' }
    ] },
    { key: 'tempo', label: '節奏', options: [
      { id: 'slow', label: '慢', productPhrase: '節奏平穩、適合安靜聆聽' },
      { id: 'medium', label: '中速', default: true, productPhrase: '節奏舒服、容易跟唱' },
      { id: 'upbeat', label: '輕快', productPhrase: '輕鬆有律動、容易記住' }
    ] },
    { key: 'instrument', label: '樂器', options: [
      { id: 'guitar', label: '木吉他', default: true, productPhrase: '自然樸實的陪伴感' },
      { id: 'piano', label: '鋼琴', productPhrase: '柔和細膩、情緒更清楚' },
      { id: 'strings', label: '弦樂', productPhrase: '增加溫度與情感層次' }
    ] },
    { key: 'avoid', label: '避免', options: [
      { id: 'no_high', label: '不要高音', default: true, productPhrase: '舒服耐聽、不過度高亢' },
      { id: 'no_heavy_drum', label: '不要重鼓', productPhrase: '節奏輕柔、不造成壓迫' },
      { id: 'no_edm', label: '不要 EDM', productPhrase: '保持自然、不走強烈電子感' }
    ] }
  ],
  video: [
    { key: 'visual', label: '畫面', options: [
      { id: 'bright', label: '明亮', default: true, productPhrase: '清爽有朝氣' },
      { id: 'warm', label: '溫暖', productPhrase: '帶有溫暖幸福感' },
      { id: 'natural', label: '自然', productPhrase: '真實生活感、不刻意' }
    ] },
    { key: 'light', label: '光線', options: [
      { id: 'natural', label: '自然光', default: true, productPhrase: '自然真實、畫面舒服' },
      { id: 'morning', label: '晨光', productPhrase: '帶有清晨希望感' },
      { id: 'dusk', label: '黃昏', productPhrase: '柔和溫暖、富有故事感' }
    ] },
    { key: 'tone', label: '色調', options: [
      { id: 'warm', label: '暖色', default: true, productPhrase: '溫暖柔和、容易親近' },
      { id: 'cinematic', label: '電影感', productPhrase: '畫面有故事感與層次' },
      { id: 'morandi', label: '莫蘭迪', productPhrase: '低飽和、安靜有質感' }
    ] },
    { key: 'tempo', label: '節奏', options: [
      { id: 'slow', label: '慢', productPhrase: '節奏從容、適合細細感受' },
      { id: 'medium', label: '中', default: true, productPhrase: '節奏舒服、不匆忙' },
      { id: 'fast', label: '快', productPhrase: '明快有活力、容易吸引注意' }
    ] },
    // Video Workflow vNext（Style Anchor 補齊）：新增「配音性格」「語速」兩類，
    // 給「配音與字幕」步驟跟單幕重做用，其餘既有 5 類完全不動，沿用同一套選單／
    // 預設值／相容機制（舊工作沒有這兩個欄位時，resolveCreativePreferences() 已有的
    // Object.assign 合併邏輯會自動補上系統預設，不需要另外寫遷移程式碼）。
    { key: 'voiceCharacter', label: '配音性格', options: [
      { id: 'warm', label: '溫暖親切', default: true, productPhrase: '聲音溫暖、像朋友在說話' },
      { id: 'professional', label: '專業穩重', productPhrase: '聲音沉穩、值得信任' },
      { id: 'playful', label: '活潑俏皮', productPhrase: '聲音輕快、帶點活力' }
    ] },
    { key: 'voicePace', label: '語速', options: [
      { id: 'slow', label: '慢', productPhrase: '講話速度放慢、方便聽清楚' },
      { id: 'medium', label: '中', default: true, productPhrase: '講話速度適中、自然順暢' },
      { id: 'fast', label: '快', productPhrase: '講話速度稍快、明快有節奏' }
    ] },
    // 「避免」這個類別 CEO 沒有指定預設值（跟其他類別不同），保持沒有預設選項，
    // 使用者沒有主動選擇時，注入文字跟作品語言裡都不會出現這個類別，不是 bug
    { key: 'avoid', label: '避免', options: [
      { id: 'no_dark', label: '不要黑暗', productPhrase: '畫面輕鬆、不陰沉' },
      { id: 'no_horror', label: '不要恐怖', productPhrase: '保持安心、沒有驚嚇感' },
      { id: 'no_oppressive', label: '不要壓迫', productPhrase: '視覺舒適、不造成壓力' }
    ] }
  ]
};

// 收合狀態「目前作品風格」最多組兩句，這個順序決定「哪兩類最先被選進去」：
// 情緒／色調類的感受詞最能代表整體印象排最前面，「避免」本質是限制不是感受，排最後、最少入選
const CREATIVE_PREFERENCE_PRIORITY = {
  song: ['mood', 'tempo', 'vocal', 'instrument', 'avoid'],
  video: ['tone', 'visual', 'light', 'tempo', 'voiceCharacter', 'voicePace', 'avoid']
};

function defaultCreativePreferences(flowId) {
  const categories = CREATIVE_PREFERENCE_CATEGORIES[flowId];
  if (!categories) return null;
  const result = { custom: '' };
  categories.forEach(function (cat) {
    const def = cat.options.find(function (o) { return o.default; });
    result[cat.key] = def ? def.id : '';
  });
  return result;
}

// 舊工作沒有 work.creativePreferences 時，直接回傳系統預設，不報錯、不需要資料遷移；
// 已經調整過的工作只覆蓋使用者真的動過的欄位，其餘欄位仍然沿用系統預設
function resolveCreativePreferences(work) {
  const defaults = defaultCreativePreferences(work.flowId);
  if (!defaults) return null;
  return Object.assign({}, defaults, work.creativePreferences || {});
}

function isUsingCreativeDefaults(work) {
  const defaults = defaultCreativePreferences(work.flowId);
  if (!defaults) return true;
  const custom = work.creativePreferences;
  if (!custom) return true;
  return Object.keys(defaults).every(function (k) { return custom[k] === undefined || custom[k] === defaults[k]; });
}

// 依「系統預設 → 使用者選擇 → 使用者自訂偏好」順序組出注入文字（Context Pack 用）；
// 優先規則不做語意判斷，只在文字裡清楚標示「自訂偏好優先」，交給 AI 自己處理衝突
function buildCreativePreferencesText(work) {
  const categories = CREATIVE_PREFERENCE_CATEGORIES[work.flowId];
  if (!categories) return '（此工作類型目前沒有創作偏好設定）';
  const resolved = resolveCreativePreferences(work);
  const lines = categories.map(function (cat) {
    const chosenId = resolved[cat.key];
    if (!chosenId) return null;
    const opt = cat.options.find(function (o) { return o.id === chosenId; });
    return opt ? '・' + cat.label + '：' + opt.label : null;
  }).filter(Boolean);
  let text = '目前生效的創作偏好（沒有調整過的欄位使用系統推薦設定）：\n' + lines.join('\n');
  if (resolved.custom && resolved.custom.trim()) {
    text += '\n\n使用者自訂偏好：\n' + resolved.custom.trim();
  }
  text += '\n\n優先規則：自訂偏好優先於系統預設與勾選項目；如果自訂偏好跟上面勾選內容有衝突，請以自訂偏好為準。';
  return text;
}

// 自訂偏好過長時，收合狀態的「目前作品風格」只取前段，完整內容仍在展開後的欄位裡看得到，不會遺失
function truncateForProductLanguage(text) {
  const MAX = 24;
  return text.length > MAX ? text.slice(0, MAX) + '…' : text;
}

// 收合狀態「目前作品風格」（v1.2 Product Language First）：把設定翻譯成作品感受的自然短句，
// 不是設定摘要清單——固定最多兩句、用「，」串成一句話、句尾加「。」，不用「・」這類條列符號。
// 有自訂偏好時優先當作主要方向；category 挑選順序＝「使用者真的調整過的類別優先」，
// 其餘再用 CREATIVE_PREFERENCE_PRIORITY 補滿——如果永遠固定用同一組優先順序（例如情緒／節奏），
// 使用者調整了排序較後面的類別（例如樂器／唱腔）時，收合狀態會一直看不到自己的調整，
// 會誤以為沒生效，這是實作時發現、已經修正的真實 bug，不是刻意設計。
// 誠實揭露：這仍然是「挑兩句、用逗號接起來」的固定邏輯，不是真的語言生成，遇到特別不順的組合，
// 調整方式是改 CREATIVE_PREFERENCE_PRIORITY 的順序或改 productPhrase 本身的用字，不需要改這個函式的邏輯。
function buildCreativePreferenceProductLanguage(work) {
  const categories = CREATIVE_PREFERENCE_CATEGORIES[work.flowId];
  if (!categories) return '';
  const resolved = resolveCreativePreferences(work);
  const defaults = defaultCreativePreferences(work.flowId);
  const priority = CREATIVE_PREFERENCE_PRIORITY[work.flowId] || categories.map(function (c) { return c.key; });

  const phraseByKey = {};
  categories.forEach(function (cat) {
    const chosenId = resolved[cat.key];
    if (!chosenId) return;
    const opt = cat.options.find(function (o) { return o.id === chosenId; });
    if (opt && opt.productPhrase) phraseByKey[cat.key] = opt.productPhrase;
  });

  const changedKeys = priority.filter(function (key) { return resolved[key] && resolved[key] !== defaults[key]; });
  const orderedKeys = changedKeys.concat(priority.filter(function (key) { return changedKeys.indexOf(key) === -1; }));

  const parts = [];
  if (resolved.custom && resolved.custom.trim()) parts.push(truncateForProductLanguage(resolved.custom.trim()));
  orderedKeys.forEach(function (key) {
    if (parts.length >= 2) return;
    if (phraseByKey[key]) parts.push(phraseByKey[key]);
  });

  if (parts.length === 0) return '';
  return parts.join('，') + '。';
}

// Sprint 2.1（Starter UX）：先完成圖片，圖片工具固定推薦這三個（不依影片類型分流），
// 影片工具（VIDEO_TYPE_TOOL_RECOMMENDATIONS）留到圖片確認完成後才出現
const VIDEO_IMAGE_TOOL_RECOMMENDATIONS = [
  { toolId: 'chatgpt', reason: '很多人會直接用 ChatGPT 生成圖片，操作簡單，內建的圖片功能就能用。' },
  { toolId: 'canva', reason: '如果想要更精緻的排版跟版型，Canva 也是常見的選擇。' },
  { toolId: 'gemini', reason: 'Gemini 也有圖片生成功能，手邊已經在用的話直接延伸使用很方便。' }
];

// 把腳本步驟的單一輸出拆成腳本／圖片描述／風格建議三塊，讓使用者「明確看到」AI 做了什麼
// （Sprint 2.1）。AI 沒有照格式輸出時優雅降級：整段內容都放進「腳本」，不報錯、不阻擋。
function parseVideoScriptSections(content) {
  const sections = { script: content || '', images: '', style: '' };
  const scriptMatch = content && content.match(/【腳本】([\s\S]*?)(?=【圖片描述建議】|【風格建議】|$)/);
  const imagesMatch = content && content.match(/【圖片描述建議】([\s\S]*?)(?=【風格建議】|$)/);
  const styleMatch = content && content.match(/【風格建議】([\s\S]*?)$/);
  if (scriptMatch && scriptMatch[1].trim()) sections.script = scriptMatch[1].trim();
  if (imagesMatch && imagesMatch[1].trim()) sections.images = imagesMatch[1].trim();
  if (styleMatch && styleMatch[1].trim()) sections.style = styleMatch[1].trim();
  return sections;
}

// ═════════════════════════════════════════════════════════════
// Master Script ／ Style Anchor（Video Workflow vNext，CEO 核准實作）
// 正式原則（CEO 明確裁示，不得違反）：
//   state.results[].content 是唯一的正式成果來源；work.masterScript 是每次該成果
//   被保存或更新時，同一個操作內同步解析出的結構化索引，本身永遠不能被單獨編輯，
//   也不能跟正式成果不同步。解析失敗時完全不更新 work.masterScript、不指向新內容，
//   保留上一個合法版本（或維持 null），避免下游任何步驟讀到「格式錯誤但被誤判成功」
//   的內容。
//
// 延伸既有 parseVideoScriptSections() 的中文全形括號標記慣例，改成逐幕結構——沿用
// 同一套「用標記切分文字」的技術，不是發明新的資料格式或解析技術。
// ═════════════════════════════════════════════════════════════

const MASTER_SCRIPT_OVERVIEW_FIELDS = [
  { key: 'purpose', label: '目的' },
  { key: 'audience', label: '觀眾' },
  { key: 'lengthRange', label: '長度' },
  { key: 'mainThread', label: '主軸' },
  { key: 'narrativeTone', label: '敘事調性' },
  { key: 'characterProfile', label: '主要人物設定' },
  { key: 'musicDirection', label: '音樂方向' }
];
const MASTER_SCRIPT_SCENE_FIELDS = [
  { key: 'narration', label: '旁白／文案' },
  { key: 'subtitle', label: '字幕' },
  { key: 'visualIntent', label: '畫面意圖' },
  { key: 'estimatedSeconds', label: '預估秒數' },
  { key: 'mood', label: '情緒與語氣' },
  { key: 'materialNeeds', label: '素材需求' },
  { key: 'imagePrompt', label: '圖片 Prompt' },
  { key: 'videoPrompt', label: '影片 Prompt' }
];
const VOICEOVER_SCENE_FIELDS = [
  { key: 'voiceoverScript', label: '配音稿' },
  { key: 'tone', label: '配音語氣' },
  { key: 'paceNotes', label: '語速與停頓' },
  { key: 'subtitle', label: '字幕' }
];

// 抓「標籤：內容」這一行到下一個「中文標籤：」或區塊結尾之前的所有內容（允許內容跨行）。
function extractLabeledField(block, label) {
  const pattern = new RegExp(label + '[：:]([\\s\\S]*?)(?=\\n[^\\n]{1,12}[：:]|$)');
  const m = block.match(pattern);
  return m ? m[1].trim() : '';
}

// 真人驗收校準（Correction Proposal Stage A）：逐幕旁白過去是各自獨立發想，容易斷裂/重複、
// 看不出整體是否流暢。移除空白與常見標點後只比對「是否依序找得到對應片段」，允許 AI 為了
// 分幕加上必要的輕微斷句調整，但不允許整段改寫或新增/刪除句子——這是完整性驗證，不是要求
// 逐字機械相等。
function normalizeForNarrationCheck(text) {
  return (text || '').replace(/[\s，。！？、,.!?：:；;\n]/g, '');
}

// 依序檢查每一幕的旁白（正規化後）都能在完整文案（正規化後）裡依序找到對應片段——
// 前一幕比對到的位置之後才能比對下一幕，確保幕與幕之間沒有被打亂順序或整段替換。
function narrationConsistentWithFullScript(scenes, fullNarrationScript) {
  const normFull = normalizeForNarrationCheck(fullNarrationScript);
  if (!normFull) return false;
  let cursor = 0;
  for (let i = 0; i < scenes.length; i++) {
    const normScene = normalizeForNarrationCheck(scenes[i].narration);
    if (!normScene) return false;
    const idx = normFull.indexOf(normScene, cursor);
    if (idx === -1) return false;
    cursor = idx + normScene.length;
  }
  return true;
}

// 解析「腳本」步驟的正式輸出。理想格式（Correction Proposal Stage A 起，完整文案為必要區塊，
// 排在【總覽】之前）：
// 【完整影片文案／旁白稿】\n（從第一句到最後一句的完整連貫文案）
// 【總覽】\n目的：……\n觀眾：……\n長度：……\n主軸：……\n敘事調性：……\n主要人物設定：……\n音樂方向：……
// 【第1幕｜幕名稱】\n旁白／文案：……\n字幕：……\n畫面意圖：……\n預估秒數：……\n情緒與語氣：……\n素材需求：……\n圖片 Prompt：……\n影片 Prompt：……
// 【第2幕｜……】……
//
// CEO 真人驗收 Bug #1（真實貼回內容用的是舊版【腳本】/[開場][中段][結尾]/【圖片描述建議】/
// 【風格建議】這種較自由的寫法，外部 AI 沒有完全照著上面的嚴格格式輸出）：先嘗試嚴格格式
// （parseMasterScriptStrict），拿得到完整結構時保留全部逐幕細節；嚴格格式解析不到時，改用
// 較寬鬆的方式（parseMasterScriptLenient）辨認常見標題／換行／括號／補充區塊，只要抓得到
// 可用的旁白內容就成功、讓使用者能繼續下一步，不用自己重新排版格式——這是「Parser 過度嚴格」
// 的修正，不是放寬「解析失敗不可取代合法版本」這條原則本身：兩種解析都失敗時，一樣回傳
// valid:false，不動 work.masterScript。
//
// CEO 產品決策（寬鬆解析生效範圍採方案 B）：寬鬆解析只能在使用者「主動重新貼回內容」時
// 生效（submitPasteBack() 明確傳入 allowLenient=true），不得在被動讀取舊資料時觸發
// （getMasterScript() 的自我校正、單幕重做後的腳本版本對齊，一律省略此參數＝一律嚴格
// 解析）。allowLenient 預設為 false（安全預設值：不傳就是嚴格），避免任何呼叫端不小心
// 漏傳而誤觸寬鬆解析，導致舊版影片工作被動打開／重新整理時被靜默升級成新版 Master
// Script 介面。
function parseMasterScript(content, allowLenient) {
  if (!content) return { valid: false };
  const strict = parseMasterScriptStrict(content);
  if (strict.valid) return strict;
  if (!allowLenient) return { valid: false };
  return parseMasterScriptLenient(content);
}

function parseMasterScriptStrict(content) {
  const fullScriptMatch = content.match(/【完整影片文案／旁白稿】([\s\S]*?)(?=【總覽】|$)/);
  const fullNarrationScript = fullScriptMatch ? fullScriptMatch[1].trim() : '';
  if (!fullNarrationScript) return { valid: false };

  const overviewMatch = content.match(/【總覽】([\s\S]*?)(?=【第\d+幕|$)/);
  if (!overviewMatch) return { valid: false };
  const overview = {};
  MASTER_SCRIPT_OVERVIEW_FIELDS.forEach(function (f) { overview[f.key] = extractLabeledField(overviewMatch[1], f.label); });
  if (!overview.purpose || !overview.mainThread) return { valid: false };

  const scenes = [];
  const sceneRegex = /【第(\d+)幕(?:｜([^】]*))?】([\s\S]*?)(?=【第\d+幕|$)/g;
  let m;
  while ((m = sceneRegex.exec(content)) !== null) {
    const block = m[3];
    const scene = { sceneNo: parseInt(m[1], 10), sceneName: (m[2] || '').trim() };
    MASTER_SCRIPT_SCENE_FIELDS.forEach(function (f) { scene[f.key] = extractLabeledField(block, f.label); });
    scenes.push(scene);
  }
  if (scenes.length === 0) return { valid: false };
  const allScenesValid = scenes.every(function (s) { return s.narration && s.visualIntent; });
  if (!allScenesValid) return { valid: false };
  if (!narrationConsistentWithFullScript(scenes, fullNarrationScript)) return { valid: false };

  return {
    valid: true, fullNarrationScript: fullNarrationScript,
    purpose: overview.purpose, audience: overview.audience, lengthRange: overview.lengthRange,
    mainThread: overview.mainThread, narrativeTone: overview.narrativeTone, characterProfile: overview.characterProfile,
    musicDirection: overview.musicDirection, scenes: scenes
  };
}

// 【圖片描述建議】／【風格建議】／最後的複製提醒，一律視為腳本本文之後的附加內容——只要抓到
// 第一個這類標記，就整段截斷，不管標記本身或它後面接的任何內容，都不該混進旁白稿，也不該讓
// 解析失敗（CEO 核准的修正標準第 3、4 點）。
function stripTrailingMetaSections(content) {
  const idx = content.search(/【圖片描述建議】|【風格建議】|📋|請複製/);
  return idx === -1 ? content : content.slice(0, idx);
}

// 拿掉明確不是旁白本身的標籤行（字幕／字卡／秒數／情緒／素材需求／畫面意圖／圖片與影片
// Prompt／配音語氣／語速與停頓——這些是給機器或剪輯用的附加資訊，連同內容整行拿掉）；
// 旁白／文案／配音稿這幾種標籤則只拿掉標籤本身、保留後面的文字。共用在「乾淨旁白稿」跟
// 寬鬆解析的逐幕文字清理，避免兩處各寫一份清理規則、以後改一邊漏改另一邊。
function stripNonNarrationLabels(text) {
  // CEO 核准的驗收條件第 3 點明確列出：不得包含畫面、字卡、時間碼、幕次標題、操作說明——
  // 這裡逐一對應：畫面（畫面意圖／畫面描述／畫面）、字卡（字卡重點／字卡／字幕）、時間碼
  // （預估秒數／秒數／時間碼／時間軸），逐行整行拿掉，不只留標籤空殼。
  const dropLabels = [
    '字幕', '字卡重點', '字卡',
    '預估秒數', '秒數', '時間碼', '時間軸',
    '情緒與語氣', '素材需求',
    '畫面意圖', '畫面描述', '畫面',
    '圖片 Prompt', '影片 Prompt', '配音語氣', '語速與停頓'
  ];
  let out = text.replace(new RegExp('^(' + dropLabels.join('|') + ')[：:].*$', 'gm'), '');
  const keepLabels = ['旁白／文案', '旁白', '文案', '配音稿'];
  out = out.replace(new RegExp('^(' + keepLabels.join('|') + ')[：:]', 'gm'), '');
  return out;
}

// 拿掉 Markdown 符號、收斂多餘空行，前後留白也一併清掉。
function normalizeCleanedWhitespace(text) {
  return text.replace(/\*\*/g, '').replace(/^#+\s*/gm, '').replace(/^[-*]\s+/gm, '')
    .split('\n').map(function (l) { return l.trim(); }).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// 「複製乾淨旁白稿」與寬鬆解析共用的核心清理函式：從任何一段貼回內容（不管有沒有照嚴格格式），
// 抓出只給配音用的乾淨旁白文字——拿掉所有全形括號區塊標題、[開場][中段][結尾] 這類場次標記、
// 上面定義的非旁白標籤行，以及 Markdown 符號。
function extractCleanNarrationText(rawContent) {
  if (!rawContent) return '';
  let text = stripTrailingMetaSections(rawContent);
  text = text.replace(/【[^】]*】/g, '');
  text = text.replace(/[\[［(（]\s*(開場|中段|結尾|過渡|轉場)\s*[\]］)）]/g, '');
  text = stripNonNarrationLabels(text);
  return normalizeCleanedWhitespace(text);
}

// 寬鬆解析（CEO 真人驗收 Bug #1 的修正核心）：嚴格格式解析不到時使用。辨認常見的
// [開場]/[中段]/[結尾] 場次括號標記來切成多幕；完全沒有這類標記時，整段視為單一幕，
// 不強迫使用者重新排版。overview 各欄位（目的／主軸等）在這個路徑下不強制要求要有值——
// 舊版輸出本來就不會有這些標籤，畫面顯示端本來就有「（無）」「（未設定）」的預設文字。
function parseMasterScriptLenient(content) {
  const scriptOnly = stripTrailingMetaSections(content).replace(/【[^】]*】/g, '');
  const markerRegex = /[\[［(（]\s*(開場|中段|結尾|過渡|轉場)\s*[\]］)）]/g;
  const marks = [];
  let mm;
  while ((mm = markerRegex.exec(scriptOnly)) !== null) {
    marks.push({ name: mm[1], start: mm.index, contentStart: mm.index + mm[0].length });
  }

  // 舊格式常見的「字卡重點：……」通常是整段共用的一句重點，不是逐幕分開標記——抓出來後
  // 廣播給每一幕的 subtitle 欄位，確保這份資訊「保留」下來供後續畫面使用（剪輯交接／逐幕
  // 卡片都會讀 scene.subtitle），不會因為寬鬆解析就直接消失（CEO 核准的驗收條件第 3 點）。
  const cardLabels = ['字卡重點', '字卡', '字幕'];
  const cardMatch = scriptOnly.match(new RegExp('^(?:' + cardLabels.join('|') + ')[：:]\\s*(.+)$', 'm'));
  const sharedSubtitle = cardMatch ? cardMatch[1].trim() : '';

  const scenes = [];
  if (marks.length > 0) {
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1].start : scriptOnly.length;
      const narration = normalizeCleanedWhitespace(stripNonNarrationLabels(scriptOnly.slice(marks[i].contentStart, end)));
      if (narration) scenes.push({ sceneNo: scenes.length + 1, sceneName: marks[i].name, narration: narration, subtitle: sharedSubtitle, visualIntent: '', estimatedSeconds: '', mood: '', materialNeeds: '', imagePrompt: '', videoPrompt: '' });
    }
  }
  // 完全沒有 [開場][中段][結尾] 這類場次標記時，只有在內容本身至少帶有可辨識的腳本區塊
  // 標題（例如舊版慣用的【腳本】）才視為單一幕接受——避免使用者貼回完全沒有照任何格式輸出的
  // 內容（例如純聊天訊息、答非所問）時，被寬鬆解析誤判成「有效」，這樣仍會保留 Stage A
  // 「完全沒有格式的內容必須判定為無效」這條既有防呆規則，寬鬆解析只放寬「格式不是嚴格新版
  // 但看得出來是腳本」的情況，不是完全不驗證。
  if (scenes.length === 0 && /【(腳本|完整影片文案|旁白稿)/.test(content)) {
    const narration = normalizeCleanedWhitespace(stripNonNarrationLabels(scriptOnly));
    if (narration) scenes.push({ sceneNo: 1, sceneName: '', narration: narration, subtitle: sharedSubtitle, visualIntent: '', estimatedSeconds: '', mood: '', materialNeeds: '', imagePrompt: '', videoPrompt: '' });
  }
  if (scenes.length === 0) return { valid: false };

  const fullNarrationScript = extractCleanNarrationText(content);
  if (!narrationConsistentWithFullScript(scenes, fullNarrationScript)) return { valid: false };

  return {
    valid: true, fullNarrationScript: fullNarrationScript,
    purpose: '', audience: '', lengthRange: '', mainThread: '', narrativeTone: '', characterProfile: '', musicDirection: '',
    scenes: scenes
  };
}

// 解析「配音與字幕」步驟的正式輸出。格式：【第1幕】\n配音稿：……\n配音語氣：……\n語速與停頓：……\n字幕：……
// 幕數必須完整涵蓋目前 Master Script 的每一幕（多幕沒關係，忽略多出來的；少幕視為不完整）。
function parseVoiceoverAndSubtitles(content, masterScript) {
  if (!content || !masterScript || !masterScript.scenes || masterScript.scenes.length === 0) return { valid: false };
  const scenes = [];
  const sceneRegex = /【第(\d+)幕[^】]*】([\s\S]*?)(?=【第\d+幕|$)/g;
  let m;
  while ((m = sceneRegex.exec(content)) !== null) {
    const block = m[2];
    const scene = { sceneNo: parseInt(m[1], 10) };
    VOICEOVER_SCENE_FIELDS.forEach(function (f) { scene[f.key] = extractLabeledField(block, f.label); });
    scenes.push(scene);
  }
  if (scenes.length === 0) return { valid: false };
  const allValid = scenes.every(function (s) { return s.voiceoverScript; });
  if (!allValid) return { valid: false };
  const sceneNos = scenes.map(function (s) { return s.sceneNo; });
  const allScenesCovered = masterScript.scenes.every(function (s) { return sceneNos.indexOf(s.sceneNo) !== -1; });
  if (!allScenesCovered) return { valid: false };
  return { valid: true, scenes: scenes };
}

// Style Anchor＝呈現形式／敘事調性／視覺風格／人物設定／色調／光線／畫面比例／畫面節奏／
// 配音性格／語速／音樂方向／避免事項 12 項的集合，刻意不建立第二套資料——全部從既有的
// work.videoType／work.imageRatio／creativePreferences（含這次新增的配音性格／語速兩類）
// ＋隨 Master Script 一起產出的 3 個文字欄位（敘事調性／人物設定／音樂方向）組成。
//
// CEO 核准的最終校準：Master Script 確認成功的當下，必須把「當下」的 Style Anchor 完整
// 凍結存進 work.masterScript.styleAnchorSnapshot，往後圖片/影片 Prompt、配音與字幕、
// 單幕重做、剪輯交接一律讀這份快照，不得讀取當下可能已被使用者改掉的即時 Creative
// Preferences——否則使用者事後調整偏好設定，會讓已確認的影片內容被悄悄改變語氣或風格。
function buildStyleAnchorSnapshot(work, masterScriptFields) {
  return {
    videoType: work.videoType || null,
    imageRatio: work.imageRatio || null,
    creativePreferences: resolveCreativePreferences(work),
    narrativeTone: masterScriptFields.narrativeTone || '',
    characterProfile: masterScriptFields.characterProfile || '',
    musicDirection: masterScriptFields.musicDirection || '',
    capturedAt: new Date().toISOString()
  };
}

// 把快照組成一段文字，注入下游 Prompt。所有下游步驟一律呼叫這個函式（透過
// getConfirmedStyleAnchorText()），不得直接呼叫 buildCreativePreferencesText() 或直接讀
// work.videoType／work.imageRatio，避免繞過快照讀到之後被改掉的即時設定。
function buildStyleAnchorText(snapshot) {
  if (!snapshot) return '（尚未建立風格設定快照）';
  const typeInfo = VIDEO_TYPES.find(function (t) { return t.id === snapshot.videoType; });
  const ratioInfo = VIDEO_RATIO_OPTIONS.find(function (r) { return r.id === snapshot.imageRatio; });
  const categories = CREATIVE_PREFERENCE_CATEGORIES.video;
  const prefLines = categories.map(function (cat) {
    const chosenId = snapshot.creativePreferences && snapshot.creativePreferences[cat.key];
    if (!chosenId) return null;
    const opt = cat.options.find(function (o) { return o.id === chosenId; });
    return opt ? '・' + cat.label + '：' + opt.label : null;
  }).filter(Boolean);

  let text = '這支影片已確認的 Style Anchor（全片共用，往後每一幕都要沿用同一組設定，不得自行更改）：\n';
  text += '・呈現形式：' + (typeInfo ? typeInfo.label : '（未設定）') + '\n';
  text += '・畫面比例：' + (ratioInfo ? ratioInfo.label : '（未設定）') + '\n';
  if (prefLines.length) text += prefLines.join('\n') + '\n';
  if (snapshot.narrativeTone) text += '・敘事調性：' + snapshot.narrativeTone + '\n';
  if (snapshot.characterProfile) text += '・主要人物設定：' + snapshot.characterProfile + '\n';
  if (snapshot.musicDirection) text += '・音樂方向：' + snapshot.musicDirection + '\n';
  if (snapshot.creativePreferences && snapshot.creativePreferences.custom && snapshot.creativePreferences.custom.trim()) {
    text += '・使用者自訂偏好：' + snapshot.creativePreferences.custom.trim() + '\n';
  }
  return text.trim();
}

// Correction Proposal Stage C：Phase A／Phase B 畫面上的「Style Anchor 摘要」區塊，跟
// buildStyleAnchorText() 同一份資料，只是這裡輸出給使用者看的 HTML（會 escHtml），不是給
// AI 的純文字 Prompt 內容——兩者刻意分開，不要共用同一個字串，避免以後其中一邊要調整措辭時
//互相牽動。
function buildStyleAnchorSummaryHtml(snapshot) {
  if (!snapshot) return '<div class="line">（尚未建立風格設定快照）</div>';
  const typeInfo = VIDEO_TYPES.find(function (t) { return t.id === snapshot.videoType; });
  const ratioInfo = VIDEO_RATIO_OPTIONS.find(function (r) { return r.id === snapshot.imageRatio; });
  const categories = CREATIVE_PREFERENCE_CATEGORIES.video;
  const prefLines = categories.map(function (cat) {
    const chosenId = snapshot.creativePreferences && snapshot.creativePreferences[cat.key];
    if (!chosenId) return null;
    const opt = cat.options.find(function (o) { return o.id === chosenId; });
    return opt ? '<div class="line">・' + escHtml(cat.label) + '：' + escHtml(opt.label) + '</div>' : null;
  }).filter(Boolean).join('');

  let html = '<div class="line">・呈現形式：' + escHtml(typeInfo ? typeInfo.label : '（未設定）') + '</div>';
  html += '<div class="line">・畫面比例：' + escHtml(ratioInfo ? ratioInfo.label : '（未設定）') + '</div>';
  html += prefLines;
  if (snapshot.narrativeTone) html += '<div class="line">・敘事調性：' + escHtml(snapshot.narrativeTone) + '</div>';
  if (snapshot.characterProfile) html += '<div class="line">・主要人物設定：' + escHtml(snapshot.characterProfile) + '</div>';
  if (snapshot.musicDirection) html += '<div class="line">・音樂方向：' + escHtml(snapshot.musicDirection) + '</div>';
  if (snapshot.creativePreferences && snapshot.creativePreferences.custom && snapshot.creativePreferences.custom.trim()) {
    html += '<div class="line">・使用者自訂偏好：' + escHtml(snapshot.creativePreferences.custom.trim()) + '</div>';
  }
  return html;
}

// 唯一負責把「腳本」步驟的正式 Result 同步成結構化 work.masterScript 的地方。
// 呼叫時機：submitPasteBack() 確認一筆新的合法內容時、以及 getMasterScript() 發現目前
// 指向的正式 Result 跟 work.masterScript 記錄的來源對不上時（自我校正）。解析失敗時
// 完全不動 work.masterScript（保留上一個合法版本，或維持 null）——這個函式本身只負責
// 「同步」，不負責「擋流程」，擋流程的判斷交給呼叫端（submitPasteBack）。
//
// allowLenient 只能由「使用者主動重新貼回」的呼叫端（submitPasteBack()）明確傳入 true；
// getMasterScript() 的被動自我校正、單幕重做後的版本對齊，都省略此參數（等同 false／
// 嚴格解析），確保被動讀取舊資料的路徑永遠不會觸發寬鬆解析、不會把舊格式資料靜默升級。
function syncMasterScriptFromResult(work, result, allowLenient) {
  const parsed = parseMasterScript(result.content, allowLenient);
  if (!parsed.valid) return false;
  const snapshot = buildStyleAnchorSnapshot(work, parsed);
  work.masterScript = {
    sourceResultId: result.id,
    sourceVersion: result.version,
    fullNarrationScript: parsed.fullNarrationScript,
    purpose: parsed.purpose, audience: parsed.audience, lengthRange: parsed.lengthRange, mainThread: parsed.mainThread,
    narrativeTone: parsed.narrativeTone, characterProfile: parsed.characterProfile, musicDirection: parsed.musicDirection,
    scenes: parsed.scenes,
    styleAnchorSnapshot: snapshot,
    voiceoverSourceResultId: null, voiceoverSourceVersion: null
  };
  return true;
}

// 同步「配音與字幕」步驟的正式 Result 到 work.masterScript.scenes[].voiceover。
// 防止舊配音字幕內容被誤套在重新產生過的新版 Master Script 上：只接受
// result.masterScriptResultId（配音字幕成果保存當下記錄的來源母稿 id）跟目前
// work.masterScript.sourceResultId 完全相同的成果，對不上就視為「這一版母稿還沒有
// 對應的配音字幕」，不強行套用——這不是完整的連動追蹤系統，只是單一個版本標記比對，
// 使用者重新確認腳本後，需要自己重新做一次配音與字幕（MVP 範圍明確排除自動連動）。
// Correction Proposal Stage C 必要最小補充（非 Stage A／B 範圍內的既有函式修改）：Stage B
// 的配音與字幕模板已經要求 AI 先輸出【完整配音稿】前導區塊，Stage C 需要把它單獨顯示＋複製，
// 但 parseVoiceoverAndSubtitles() 的合法性判斷（幕數是否對應、每幕是否有 voiceoverScript）
// 完全不需要也沒有修改——這裡只是額外多讀一個純展示用的區塊，不影響任何既有驗證規則或行為。
function extractFullVoiceoverScript(content) {
  const m = content.match(/【完整配音稿】([\s\S]*?)(?=【第\d+幕|$)/);
  return m ? m[1].trim() : '';
}

function syncVoiceoverFromResult(work, result) {
  if (!work.masterScript) return false;
  if (result.masterScriptResultId !== work.masterScript.sourceResultId) return false;
  const parsed = parseVoiceoverAndSubtitles(result.content, work.masterScript);
  if (!parsed.valid) return false;
  work.masterScript.scenes.forEach(function (scene) {
    const voice = parsed.scenes.find(function (s) { return s.sceneNo === scene.sceneNo; });
    if (voice) scene.voiceover = { voiceoverScript: voice.voiceoverScript, tone: voice.tone, paceNotes: voice.paceNotes, subtitle: voice.subtitle };
  });
  work.masterScript.voiceoverSourceResultId = result.id;
  work.masterScript.voiceoverSourceVersion = result.version;
  work.masterScript.fullVoiceoverScript = extractFullVoiceoverScript(result.content);
  return true;
}

// 下游（圖片/影片 Prompt 顯示、配音與字幕、單幕重做、剪輯交接）一律呼叫這個函式讀取
// Master Script，不直接讀 work.masterScript——這裡會先確認目前指向的正式 Result
// 有沒有變動，變動就自我校正重新同步一次，保證讀到的永遠是「腳本」步驟目前確認的
// 最新版本，不會有下游讀到舊版本的風險（比照還原交易的 fingerprint 比對精神）。
//
// CEO 產品決策（寬鬆解析生效範圍採方案 B）：這裡是「被動」讀取路徑——使用者可能只是
// 打開既有影片工作、重新整理頁面、或切換畫面回來，並沒有主動重新貼回任何內容。刻意
// 省略 syncMasterScriptFromResult() 的 allowLenient 參數（等同 false），只用嚴格解析
// 自我校正；舊格式資料嚴格解析不到時，work.masterScript 維持 null，畫面照舊走原本的
// 三段式 legacy fallback 顯示，不會被靜默升級成新版 Master Script 介面，也不會改寫、
// 搬移或改變任何舊工作內容。
function getMasterScript(work) {
  if (!work || work.flowId !== 'video') return null;
  const scriptIdx = FLOWS.video.steps.findIndex(function (s) { return s.name === '腳本'; });
  const scriptResultId = work.stepResultIds[scriptIdx];
  const scriptResult = scriptResultId ? state.results.find(function (r) { return r.id === scriptResultId; }) : null;
  if (scriptResult && (!work.masterScript || work.masterScript.sourceResultId !== scriptResult.id)) {
    syncMasterScriptFromResult(work, scriptResult);
  }
  if (!work.masterScript) return null;

  const voiceIdx = FLOWS.video.steps.findIndex(function (s) { return s.name === '配音與字幕'; });
  if (voiceIdx >= 0) {
    const voiceResultId = work.stepResultIds[voiceIdx];
    const voiceResult = voiceResultId ? state.results.find(function (r) { return r.id === voiceResultId; }) : null;
    if (voiceResult && work.masterScript.voiceoverSourceResultId !== voiceResult.id) {
      syncVoiceoverFromResult(work, voiceResult);
    }
  }
  return work.masterScript;
}

function getConfirmedStyleAnchorText(work) {
  const ms = getMasterScript(work);
  if (!ms) return '（尚未確認影片母稿與風格設定）';
  return buildStyleAnchorText(ms.styleAnchorSnapshot);
}

// 給「創作偏好」設定畫面用：使用者在 Master Script 已確認之後又調整了 Creative
// Preferences／影片類型／畫面比例時，回傳 true——只用來顯示提醒，不自動改變已確認的
// 影片內容，使用者要套用新偏好必須重新產生或重新確認「腳本」步驟，才會建立新的快照。
function styleAnchorOutOfSync(work) {
  const ms = getMasterScript(work);
  if (!ms || !ms.styleAnchorSnapshot) return false;
  const snap = ms.styleAnchorSnapshot;
  const live = resolveCreativePreferences(work);
  const snapPrefs = snap.creativePreferences || {};
  const prefsChanged = Object.keys(live).some(function (k) { return live[k] !== snapPrefs[k]; });
  const typeChanged = (work.videoType || null) !== snap.videoType;
  const ratioChanged = (work.imageRatio || null) !== snap.imageRatio;
  return prefsChanged || typeChanged || ratioChanged;
}

// 把 work.masterScript 重新組成「腳本」步驟原本要求的正式格式文字。單幕重做（見
// submitSceneRegenerate()）不直接改 work.masterScript 那一個欄位——會先合併新內容，
// 再整份重新產生文字、存成「腳本」這一步的新版本、重新走一次 syncMasterScriptFromResult()，
// 確保 state.results[].content 永遠是唯一正式來源，work.masterScript 只是它的衍生索引
// （CEO 核准的「單一主資料」原則），不會出現母稿跟正式成果內容對不起來的狀況。
//
// CEO 真人驗收 Blocker #2 追查時發現的既有潛在問題（連帶修正，不是新增功能）：這份文字
// 產生後會整份丟回 parseMasterScriptStrict() 重新驗證（見 syncMasterScriptFromResult()），
// 但 parseMasterScriptStrict() 要求 purpose／mainThread 兩個欄位非空才算合法——寬鬆解析
// （Bug #1 修正）建立的 work.masterScript 這兩個欄位本來就是空字串，導致任何從寬鬆解析
// 而來的母稿，只要走一次這個「機器重新產生文字→重新解析」的迴圈（單幕重做、或本次新增的
// 「產生圖片指令」），就會在還原驗證時靜默失敗、work.masterScript 悄悄跟正式成果內容脫鉤。
// 這裡只在「機器自己重新組字」這個動作補一個不影響顯示的預設值，不改動
// parseMasterScriptStrict() 本身的驗證規則，也不影響使用者主動貼回內容時的判斷標準。
function renderMasterScriptText(ms) {
  let text = '【完整影片文案／旁白稿】\n' + (ms.fullNarrationScript || '') + '\n\n';
  text += '【總覽】\n';
  MASTER_SCRIPT_OVERVIEW_FIELDS.forEach(function (f) {
    let val = ms[f.key] || '';
    if (!val && (f.key === 'purpose' || f.key === 'mainThread')) val = '（沿用原始腳本內容，未另行填寫）';
    text += f.label + '：' + val + '\n';
  });
  ms.scenes.forEach(function (scene) {
    text += '\n【第' + scene.sceneNo + '幕｜' + (scene.sceneName || '') + '】\n';
    MASTER_SCRIPT_SCENE_FIELDS.forEach(function (f) { text += f.label + '：' + (scene[f.key] || '') + '\n'; });
  });
  return text.trim();
}

// 舊資料相容（Correction Proposal Stage A）：Stage 0-6 時期已確認的 work.masterScript 沒有
// fullNarrationScript 欄位。畫面顯示完整文案時一律呼叫這個函式，不要直接讀
// ms.fullNarrationScript——沒有的話用逐幕旁白依序組合顯示，並誠實標記
// isFallbackAssembled，讓畫面加註「非原始完整文案」，不假裝是使用者當初產生的原生完整稿。
function getDisplayFullNarrationScript(ms) {
  if (ms.fullNarrationScript) return { text: ms.fullNarrationScript, isFallbackAssembled: false };
  const assembled = (ms.scenes || []).map(function (s) { return s.narration || ''; }).filter(Boolean).join('\n');
  return { text: assembled, isFallbackAssembled: true };
}

// 同樣的舊資料相容道理，用在完整配音稿：配音與字幕還沒確認過、或是 Stage C 之前確認的
// 舊資料（沒有 fullVoiceoverScript）時，用逐幕配音稿依序組合顯示，一樣誠實標記
// isFallbackAssembled。完全沒有任何一幕確認過配音時，text 會是空字串，畫面端應該直接
// 隱藏這個區塊，不要顯示空白卡片。
function getDisplayFullVoiceoverScript(ms) {
  if (ms.fullVoiceoverScript) return { text: ms.fullVoiceoverScript, isFallbackAssembled: false };
  const assembled = (ms.scenes || []).map(function (s) { return (s.voiceover && s.voiceover.voiceoverScript) || ''; }).filter(Boolean).join('\n');
  return { text: assembled, isFallbackAssembled: true };
}

// 同樣道理，把 work.masterScript.scenes[].voiceover 重新組成「配音與字幕」步驟的正式格式文字。
function renderVoiceoverText(ms) {
  let text = '';
  ms.scenes.forEach(function (scene) {
    text += '【第' + scene.sceneNo + '幕】\n';
    VOICEOVER_SCENE_FIELDS.forEach(function (f) { text += f.label + '：' + ((scene.voiceover && scene.voiceover[f.key]) || '') + '\n'; });
    text += '\n';
  });
  return text.trim();
}

// 單幕重做（MVP 邊界，CEO 核准範圍）：只解析「這一幕＋這個面向」的小範圍回應，
// 不要求使用者重貼整份母稿。格式：
// 圖片／影片：【第N幕｜圖片 Prompt】或【第N幕｜影片 Prompt】＋內容
// 配音與字幕：【第N幕｜配音與字幕】＋VOICEOVER_SCENE_FIELDS 格式
function parseSceneRegenerateResponse(content, sceneNo, aspect) {
  if (!content) return { valid: false };
  const label = aspect === 'image' ? '圖片 Prompt' : aspect === 'video' ? '影片 Prompt' : '配音與字幕';
  const re = new RegExp('【第' + sceneNo + '幕｜' + label + '】([\\s\\S]*)');
  const m = content.match(re);
  if (!m) return { valid: false };
  const block = m[1].trim();
  if (aspect === 'voiceover') {
    const scene = {};
    VOICEOVER_SCENE_FIELDS.forEach(function (f) { scene[f.key] = extractLabeledField(block, f.label); });
    if (!scene.voiceoverScript) return { valid: false };
    return { valid: true, voiceover: scene };
  }
  if (!block) return { valid: false };
  return { valid: true, text: block };
}

// ── Tool Companion（Sprint 3）─────────────────────────────────
// Kling 的完整引導從 Video Flow Sprint 2 起改由 renderToolGuide()／VIDEO_TOOL_GUIDE 直接顯示
// 在畫面上（工具介紹＋7 步流程＋完成提醒都不用多點一次），這裡的 Companion 步驟不再使用；
// 原本依影片類型的清單（VIDEO_TYPE_TOOL_RECOMMENDATIONS）保留當作「其他影片工具」的內容。
// 固定格式：每一步都是「現在請：……」單一動作，不教工具功能、不列選單，只陪使用者做完。
// 誠實記錄：這些步驟是依各工具常見的操作模式（登入→操作→下載）寫的通用引導，
// 不是逐一登入各工具核對現在畫面長相寫出來的——工具介面會改版，這點提醒 Sprint 之後維護要注意。
const TOOL_COMPANIONS = {
  chatgpt: {
    name: 'ChatGPT',
    steps: [
      '打開 ChatGPT，登入你的帳號（沒有帳號可以先免費註冊）。',
      '把剛剛複製的圖片描述貼上，傳送出去，請它幫你生成圖片。',
      '滿意的話，把圖片下載保存到手機或電腦。'
    ]
  },
  capcut: {
    name: 'CapCut（剪映）',
    steps: [
      '打開 CapCut，登入你的帳號（沒有帳號可以先免費註冊）。',
      '新增專案，把你的圖片或影片素材依序拖進時間軸剪接。',
      '完成後點選「匯出」，把成品下載保存到手機或電腦。'
    ]
  }
};

let activeToolCompanionId = null;
let toolCompanionReturnScreen = 'screen-work-detail';

function openToolCompanion(toolId, returnScreen) {
  activeToolCompanionId = toolId;
  toolCompanionReturnScreen = returnScreen;
  showScreen('screen-tool-companion');
}
function closeToolCompanion() { showScreen(toolCompanionReturnScreen); }

function renderToolCompanion() {
  const companion = TOOL_COMPANIONS[activeToolCompanionId];
  if (!companion) { closeToolCompanion(); return; }
  document.getElementById('tc-title').textContent = companion.name + ' 使用步驟';
  document.getElementById('tc-steps').innerHTML = companion.steps.map(function (step, i) {
    return '<div class="card"><div class="section-label">Step ' + (i + 1) + '</div><div style="font-size:15px;color:var(--text)">現在請：' + escHtml(step) + '</div></div>';
  }).join('');
  // Correction Proposal Stage D：TOOL_COMPANIONS 的 key（chatgpt／capcut）本身就是
  // tools-catalog.json 的工具 id，直接查同一套共用機制即可，不需要在 TOOL_COMPANIONS 裡
  // 另外重複寫一次網址；查不到就隱藏按鈕（安全降級，不留空白連結）。
  const openBtn = document.getElementById('tc-open-tool-btn');
  const url = getToolUrlById(activeToolCompanionId);
  if (url) {
    openBtn.style.display = '';
    openBtn.href = url;
    openBtn.textContent = '🔗 開啟 ' + companion.name;
  } else {
    openBtn.style.display = 'none';
  }
}

// 共用的「這一步適合的工具」卡片渲染：只推薦一個 ⭐ 預設，其餘收在「查看更多工具」，
// 不要一次列很多選項（AI 協作六大原則第 4 條：收斂原則）。有寫好 Companion 步驟的工具
// 才會出現「查看使用步驟」按鈕，其餘工具目前只有名稱＋推薦理由。
// Phase 1B（Official Recommendation Center）：找不到官方建議時顯示固定誠實文案，不留空白；
// 主要建議固定標「⭐ 名稱（官方建議）」，其餘方案在「查看更多工具」裡列成「其他可選方案」。
function renderToolRecommendationCard(elementId, toolChain, returnScreen, primaryLabel, suppressPrimaryBadge) {
  const toolsBox = document.getElementById(elementId);
  if (!toolChain || !toolChain.length) {
    toolsBox.innerHTML = '<div class="notice">' + escHtml(NO_OFFICIAL_RECOMMENDATION_MESSAGE) + '</div>';
    return;
  }

  function toolRow(item, isPrimary) {
    const tool = getMyToolById(item.toolId);
    const label = tool ? tool.name : item.toolId;
    const companion = TOOL_COMPANIONS[item.toolId];
    // Correction Proposal Stage D：每個工具列都可以直接開啟（同一套 buildToolOpenLinkHtml()
    // 共用機制），沒有網址時安全降級成不顯示連結，不會出現空白頁或死連結。
    const openLink = buildToolOpenLinkHtml(item.toolId, '開啟 ' + label);
    const btn = companion ? '<button class="btn outline" style="margin-top:8px" onclick="openToolCompanion(\'' + item.toolId + '\', \'' + returnScreen + '\')">📖 查看使用步驟</button>' : '';
    const nameLine = isPrimary ? '⭐ ' + escHtml(label) + '（官方建議）' : escHtml(label);
    return '<div class="tool-suggest-row"><b>' + nameLine + '</b>　<span class="reason">' + escHtml(item.reason || '') + '</span></div>' + openLink + btn;
  }

  // suppressPrimaryBadge：這個卡片本身就是「其他／替代工具」的次要清單時使用（例如影片依類型的
  // 其他工具清單，正式的⭐官方建議已經在同畫面另一張卡片顯示過了），這時不要把清單第一項也標成
  // 「官方建議」，避免同一畫面出現兩個「官方建議」互相矛盾。
  const primary = toolChain[0];
  const rest = toolChain.slice(1);
  let html = (primaryLabel ? '<div class="section-label">' + escHtml(primaryLabel) + '</div>' : '') + toolRow(primary, !suppressPrimaryBadge);
  if (rest.length) {
    html += '<details class="ai-why" style="margin-top:14px"><summary>查看更多工具／其他可選方案</summary><div class="ai-why-body">' +
      rest.map(function (item) { return toolRow(item, false); }).join('<div style="margin-top:10px"></div>') + '</div></details>';
  } else {
    html += '<div class="tool-suggest-note" style="margin-top:8px">這只是起點，你也可以用自己熟悉的工具。</div>';
  }
  toolsBox.innerHTML = html;
}

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
// 商品行銷 Flow 全面修正（2026-07-17）：拿掉 'product'——這條舊版 7 步流程沒有真正的完成路徑
// （最後一步「成效回填」只是文字步驟，不會產出真正的成品），使用者選到它就是 CEO 實測感受到「沒有真正
// 交付成品」的那條路徑。真正能走完的「行銷海報」子流程只從 screen-product-category 進，不受這裡影響
// （openAddWork() 對 project.type === 'product' 的特判優先於這份清單）。FLOWS.product／PROJECT_TYPES.product
// 保留不刪，只是不再讓使用者從「換一個流程」選到這個死路。
const ALL_FLOW_IDS = ['material', 'video', 'poster', 'social', 'course', 'website', 'ebook', 'song', 'research', 'customer_reply', 'custom'];

const CATEGORY_LIST = ['教材', '影片', '文章', '商品', '社群貼文', '圖片', '海報', '腳本', '電子書', '課程', '歌曲', '研究', '論文', '文獻整理', '其他'];
// 成果庫列表／詳情標題前綴用的分類 icon（Sprint 4：成果庫要能一眼看出「這是什麼」，例如 🎬 留快樂給自己 MV）
const CATEGORY_EMOJI = { '教材': '📚', '影片': '🎬', '文章': '📝', '商品': '🛍️', '社群貼文': '📱', '圖片': '🖼️', '海報': '🖼️', '腳本': '📜', '電子書': '📖', '課程': '🎤', '歌曲': '🎵', '研究': '🧪', '論文': '🧪', '文獻整理': '🧪', '其他': '✍️' };
function categoryEmoji(category) { return CATEGORY_EMOJI[category] || ''; }

// 發布助手：各通路文案模板（純樣板文字，不串接任何平台、不自動發布）
const PUBLISH_CHANNELS = ['YouTube', 'Facebook', 'IG', 'Threads', 'LINE'];

// ── 作品打磨：修改方向 ─────────────────────────────────────────
const GENERIC_DIRECTIONS = ['更清楚', '更簡短', '更有溫度', '更專業', '更幽默', '更有畫面', '更有記憶點', '更適合發布'];
const FLOW_DIRECTIONS = {
  song: ['副歌更洗腦', '情緒更飽滿', '句子更好唱', '更適合音樂工具', '更有台灣味'],
  material: ['更適合初學者', '多一點例子', '步驟更清楚', '練習題更實用', '老師講解更自然'],
  video: ['開頭更吸引人', '節奏更快', '更短影音感', '更有爆點', '字幕更好切']
};
// 特定步驟的專屬打磨方向：改善「目前這一版」，不是重新寫一份，比流程層級的方向更精準
// （Mission：歌曲創作體驗優化，2026-07-09，依 CEO 實測回饋新增歌詞專屬打磨方向）
const STEP_DIRECTIONS = {
  '歌名＋歌詞': ['更口語', '更押韻', '更有畫面', '更洗腦', '更有台灣味', '更療癒', '更感人', '更簡潔'],
  // 「完成海報」重新生成的修改方向（2026-07-17，商品行銷 Flow 全面修正）：對應的是海報成品本身，
  // 不是文字內容，所以用「修改文字／顏色／版面／照片」這種具體可執行的方向，不是 GENERIC_DIRECTIONS 那種文字語氣調整。
  '完成海報': ['修改文字', '修改顏色', '修改版面', '更換照片', '補充資料']
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

// A/B 打磨模式（Product Blueprint Version 1.6，永久規則）：所有創作型 Prompt Template 共用同一套收尾規則，
// 不要在每個模板裡各自重複打字，避免以後改規則要一個個模板找——第一次回覆固定產出兩個完整正式版本
// （不是草稿/方向/分析），只問 A/B/重新產生；使用者選定後立即重新輸出完整版本＋📋貼回提醒。
// versionRequirement：每個 Version 內部要滿足的格式要求（沿用各模板既有的具體規則，例如 Suno 格式）。
// copyBackHint：貼回提醒裡要複製「什麼」的白話說法（例如「完整歌詞」「Style」）。
// Prompt 2.0 Blocking Fix（技術長 Approve after Fix，2026-07-31）：AI 成果內容跟工作台操作
// 指引要真正拆開——不再要求 AI 在完整成果最後加上「📋 請複製…貼回 AI 工作台」，那句話是
// App 的責任（screen-paste-back 的標題／pb-notice-text／保存按鈕已經各自獨立提供這個指引，
// 不依賴 AI 輸出），不該混進 AI 該交付的正式內容裡。copyBackHint 參數因此移除（原本只用來
// 組那句提醒），呼叫端已同步拿掉第二個參數。stripCopyBackReminderLine() 仍保留在
// submitPasteBack()，作為舊 Prompt／舊對話／AI 偶發仍輸出這句話時的安全防線，不是主要機制。
function abPolishModeBlock(versionRequirement) {
  return '\n\n請直接完成兩個完整、正式、可以直接使用的版本，不是草稿、不是方向、不是分析、不是教學：\n\n' +
    '## Version A\n' + versionRequirement + '\n\n' +
    '## Version B\n（格式跟 Version A 完全一樣，內容給使用者第二個選擇；不能只寫「同上」或局部改一兩個字帶過，要重新完整寫出一個真正不同的版本）\n\n' +
    '兩個版本都完成後，最後只需要輸出：\n\n請選擇你最喜歡的版本：\n\n○ Version A\n\n○ Version B\n\n○ 都不喜歡（重新產生）\n\n' +
    '不要再多問其他問題，不要在這之前就先問使用者的偏好。\n\n' +
    '接下來使用者只會回覆「A」「B」或「重新產生」：\n' +
    '- 收到「A」或「B」：請直接重新輸出使用者選的那個版本的完整內容，就是那個版本的正式成果本身（不要摘要、不要只講差異、不要重新分析、不要局部修改），不要額外加上任何提醒文字或操作說明——複製與貼回工作台的操作方式已經顯示在畫面上，不需要你在內容裡提醒。\n' +
    '- 收到「重新產生」：請重新完成兩個新的 Version A／Version B，格式跟上面一樣，直到使用者選定為止。';
}

function buildDefaultPromptTemplates() {
  var now = new Date().toISOString();
  var id = 1;
  function tpl(type, role, flowType, stepName, name, content) {
    return { id: id++, name: name, type: type, role: role || null, flowType: flowType || null, stepName: stepName || null, version: 1, content: content, isDefault: true, updatedAt: now };
  }

  var list = [];

  // ── 1. Global Role Templates（8 個角色各一份）──
  list.push(tpl('global_role', '規劃師', null, null, '規劃師・全域模板',
    '你是本工作的規劃師。\n\n請根據以下工作背景，直接完成這一步需要的正式規劃內容。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出一份可以直接使用的正式規劃結果（不是討論方向，是實際定案的內容），內容需涵蓋這一步該有的重點與需要注意的限制或風險。若目前資訊已經足夠，請直接完成；只有在缺少完成規劃所需的關鍵資訊時，才提出最少必要的問題。'));

  list.push(tpl('global_role', '研究員', null, null, '研究員・全域模板',
    '你是本工作的研究員。\n\n請根據以下工作背景，直接完成本步驟需要的資料整理、案例蒐集與重點分析。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出一份可以直接使用的正式整理結果。不確定或無法查證的部分請明確標記「需要查證」，不要捏造。若目前資訊已經足夠，請直接完成；只有在缺少完成任務所需的關鍵資訊時，才提出最少必要的問題。'));

  list.push(tpl('global_role', '寫作師', null, null, '寫作師・全域模板',
    '你是本工作的寫作師。\n\n請根據以下內容，直接完成本步驟需要的正式文字內容。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出一份完整、可以直接使用、複製、回填的正式版本，不是草稿或多個選項讓使用者挑選。若目前資訊已經足夠，請直接完成；只有在缺少完成內容所需的關鍵資訊時，才提出最少必要的問題。'));

  list.push(tpl('global_role', '潤稿師', null, null, '潤稿師・全域模板',
    '你是本工作的潤稿師。\n\n請根據以下內容，直接完成本步驟的文字潤飾。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出潤稿後的完整正式版本，可以直接使用。完成後簡短說明主要調整了哪些地方即可，不需要額外討論或列出更多選項。'));

  list.push(tpl('global_role', '設計師', null, null, '設計師・全域模板',
    '你是本工作的設計師。\n\n請根據以下內容，直接完成本步驟需要的視覺或畫面構想。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出一份可以直接使用的正式版本：具體的畫面說明＋可直接拿去生成圖片／影像的 Prompt，不是多個方向讓使用者挑選。若目前資訊已經足夠，請直接完成；只有在缺少完成構想所需的關鍵資訊時，才提出最少必要的問題。'));

  list.push(tpl('global_role', '工程師', null, null, '工程師・全域模板',
    '你是本工作的工程師。\n\n請根據以下內容，直接完成本步驟需要的技術規格或建置說明。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出一份可以直接使用的正式技術規格或設定內容。若目前資訊已經足夠，請直接完成；只有在缺少完成任務所需的關鍵資訊時，才提出最少必要的問題。'));

  list.push(tpl('global_role', '審查員', null, null, '審查員・全域模板',
    '你是本工作的審查員。\n\n請根據以下內容，直接完成本步驟的檢查，判斷成果是否完整、正確。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出明確的檢查結論：哪裡有問題、建議怎麼修正、哪裡沒問題可以放心。這是一份可以直接使用的正式檢查報告，不是開放式討論。'));

  list.push(tpl('global_role', '發布助手', null, null, '發布助手・全域模板',
    '你是本工作的發布助手。\n\n請根據以下內容，直接完成本步驟需要的發布版本。\n\n專案：{{project_name}}\n工作：{{work_name}}\n流程：{{flow_name}}\n目前步驟：{{step_name}}\n工作目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出一份可以直接使用、直接發布的正式內容（含標題／摘要）。若目前資訊已經足夠，請直接完成；只有在缺少完成內容所需的關鍵資訊時，才提出最少必要的問題。'));

  // ── 2. Flow-Specific Templates（覆蓋 Global Role，依 flowType + role + stepName 精準比對）──
  list.push(tpl('flow_specific', '規劃師', 'song', '主題', '歌曲創作／主題發想',
    '你是歌曲創作流程中的主題發想夥伴。\n\n請根據使用者這次想寫的歌，快速幫忙定調，不要過度規劃——這一步的目的是快速抓到方向，馬上進入歌名與歌詞創作，不是寫企劃書。\n\n歌曲／工作名稱：{{work_name}}\n\n已有成果：\n{{previous_results}}\n\n每個版本都要包含：\n1. 這首歌的核心主題（1-2句話講清楚就好）\n2. 適合的情緒基調\n3. 一個可能的故事情境或畫面（簡短即可，不用寫完整故事）\n\n每個版本整體控制在 150 字以內，目標是盡快進入下一步（歌名與歌詞），不是把主題想到完美。兩個版本請給不同的切角，不要只是換幾個字。' +
    abPolishModeBlock('（依上面三點格式輸出，150 字以內）')));

  // Mission：歌曲Flow「歌名＋歌詞」一體化（2026-07-13）——AI第一次直接交兩版完整歌詞，
  // 每版附3個歌名選項（含⭐推薦一個），使用者在同一輪對話裡選定版本與歌名，不新增獨立的選歌名步驟。
  // 這是完全客製化的模板（不用 abPolishModeBlock 共用函式），因為收尾規則比一般 A/B 複雜：
  // 「歌名都不喜歡」時只重做歌名、不重寫歌詞，需要獨立的多輪歌名重選規則。
  list.push(tpl('flow_specific', '寫作師', 'song', '歌名＋歌詞', '歌曲創作／作詞師（歌名＋歌詞）',
    '你是歌曲創作流程中的作詞師，同時負責提出正式歌名——歌名與歌詞在這一步一起完成，讓使用者可以在同一輪對話裡選定歌名與歌詞，不需要另外開一個步驟。\n\n' +
    '歌曲／工作名稱（管理用途）：{{work_name}}\n目前步驟：{{step_name}}\n歌曲主題：{{goal}}\n\n' +
    '%%SONG_IDEA_BLOCK%%已有成果：\n{{previous_results}}\n\n' +
    '請依據以下優先順序創作：歌曲靈感（創作素材，若使用者有留下）→ 已確認主題 → 創作偏好 → 前面成果 → 工作名稱（僅供管理參考，排在最後，不是創作依據）。工作名稱只是方便管理工作，不要直接把工作名稱當歌名；如果上面有【歌曲靈感】，請根據歌曲靈感創作真正適合作品的歌名與歌詞——工作名稱 ≠ 歌名，歌曲靈感 ≠ 歌詞，歌曲靈感只是創作來源，可以自由發展，不要拘泥於靈感裡的文字本身。\n\n' +
    '創作偏好（唱腔／情緒／節奏／樂器／避免／自訂偏好，詳見上方「創作偏好」段落）請同時套用在歌詞與歌名的產生上，不是只影響之後的音樂風格。\n\n' +
    '請直接完成兩個完整、正式、可以直接使用的版本，不是草稿、不是方向、不是分析、不是教學：\n\n' +
    '【Version A】\n\n【歌名選項】\nA1.《……》⭐ 推薦\nA2.《……》\nA3.《……》\n\n【完整歌詞】\n[Verse 1]\n……\n\n[Chorus]\n……\n（含 [Verse]、[Pre-Chorus]、[Chorus]、[Bridge]、[Outro] 等段落標記，這是 Suno 慣用的段落標記方式）\n\n---\n\n' +
    '【Version B】\n（歌詞要用不同的切角或意象，不能只是換幾個字讓兩版看起來很像；不能只寫「同上」帶過，格式跟 Version A 完全一樣）\n\n【歌名選項】\nB1.《……》⭐ 推薦\nB2.《……》\nB3.《……》\n\n【完整歌詞】\n……\n\n---\n\n' +
    '請注意：\n' +
    '- 只寫歌詞本身，不要在這裡描述音樂風格，風格會在下一步單獨處理\n' +
    '- 歌詞要好唱、自然、有畫面，不要過度文青、不要太抽象\n' +
    '- 完整歌詞盡量控制在 3000 字（約 40-60 行）以內，這是 Suno 目前建議的實際甜蜜點，太長容易被系統壓縮或搶拍\n' +
    '- 每個版本固定提供 3 個歌名選項，並標記一個「⭐ 推薦」；歌名要從已確認主題、完整歌詞內容、副歌核心句、創作偏好與作品情緒畫面裡自然產生，不要把專案名稱、工作名稱或工作目標機械地當成歌名，工作名稱只能當參考\n' +
    '- 歌名要自然、容易記住、適合歌曲內容，不要過度文青、不要過度抽象、不要像報告標題；同一版裡的 3 個歌名要有實際差異，不要只換一兩個字\n\n' +
    '兩版都完成後，最後只需要輸出：\n\n請選擇你最喜歡的版本與歌名：\n\n○ Version A＋A1\n○ Version A＋A2\n○ Version A＋A3\n○ Version B＋B1\n○ Version B＋B2\n○ Version B＋B3\n○ 歌詞喜歡，但歌名都不喜歡\n○ 都不喜歡（重新產生）\n\n' +
    '不要再多問其他問題，不要在這之前就先問使用者的偏好。\n\n' +
    '接下來使用者只會回覆上面其中一種情況，請依照對應規則處理：\n\n' +
    '1. 收到「Version X＋X某」（例如「Version A＋A2」）：直接輸出選定的正式成果，固定格式如下，不要摘要、不要分析、不要重新輸出其他版本或其他歌名，不要額外加上任何提醒文字或操作說明：\n\n【歌名】\n選定的正式歌名（不要書名號，不要多餘空白）\n\n【歌詞】\n選定版本的完整歌詞正文\n\n' +
    '2. 收到「歌詞喜歡，但歌名都不喜歡」：不要重寫歌詞。先確認使用者要保留哪一版歌詞（如果使用者已經在同一句話裡講清楚是哪一版，就直接保留該版，不用再多問）；接著只提供 5 個全新歌名，格式：\n\n【新的歌名選項｜第 2 輪】\n\n1.《……》⭐ 推薦\n2.《……》\n3.《……》\n4.《……》\n5.《……》\n\n請選擇：\n\n○ 1\n○ 2\n○ 3\n○ 4\n○ 5\n○ 都不喜歡，再提供新的 5 個歌名\n\n新一輪歌名必須：保留原歌詞、不重寫歌詞、避免只換近義詞、優先提供跟上一輪不同的命名方向、不重複上一輪已經出現過的歌名。\n\n' +
    '3. 收到「都不喜歡，再提供新的 5 個歌名」：重複第 2 點「只提供 5 個全新歌名」的規則，格式跟上面一樣，繼續下一輪，直到使用者選定為止，每一輪只處理歌名，不重新輸出或改寫歌詞。\n\n' +
    '4. 收到單一數字（例如「2」）：代表使用者從最新一輪的歌名選項裡選定了那一個，直接輸出第 1 點說明的正式格式（【歌名】＋【歌詞】，歌詞使用已經確認保留的那一版），一樣不要額外加上任何提醒文字或操作說明。\n\n' +
    '5. 收到「都不喜歡（重新產生）」：代表兩個版本的歌詞都不滿意，重新完成兩個新的 Version A／Version B（含各自 3 個全新歌名），格式跟最上面完全一樣，不能重複上一輪的主要歌詞方向與歌名，直到使用者選定為止。'
  ));

  list.push(tpl('flow_specific', '工程師', 'song', '音樂風格', '歌曲創作／音樂風格設計師',
    '你是歌曲創作流程中的音樂風格設計師。\n\n請根據以下歌曲主題與歌詞，直接完成兩個完整、正式、可以直接使用的音樂風格版本，不是草稿、不是分析。\n\n歌曲名稱：{{song_title}}\n歌曲主題：{{goal}}\n\n已有成果（含歌名與歌詞）：\n{{previous_results}}\n\n每個版本都要包含四個區塊，目標不是教使用者音樂理論，而是讓使用者知道「這個風格適合什麼作品，並且可以直接拿去做歌」：\n\n1. 中文風格名稱（白話好懂，例如：溫暖療癒流行）\n2. 中文風格說明（一句話描述聽起來的感覺，例如：像老朋友陪伴聊天，溫暖舒服，旋律容易記住）\n3. 適合情境（列點，例如：✅ 品牌歌曲　✅ 旅行影片　✅ 日常生活　✅ 療癒歌曲　✅ 容易傳唱）\n4. Style（可以直接貼到 Suno「Style of Music」欄位的英文風格字串——依序思考曲風與次曲風／節奏BPM／情緒能量／主要樂器與製作質感／唱腔特色這五個面向，但最終濃縮成「一行」逗號分隔的關鍵字字串，不要編號、不要加「曲風：」這類標籤文字；請用英文或 Suno 慣用關鍵字，每個標籤盡量精簡（1-3個字最好），整體抓 4-7 個重點標籤，最重要的放最前面，嚴格控制在 200 字以內，不要寫成一整段小作文）\n\n請直接依照這個格式輸出：\n\n## 🎵 Version A\n### 中文風格名稱\n……\n### 中文說明\n……\n### 適合情境\n……\n### Style（直接貼 Suno）\n……\n\n## 🎵 Version B\n（格式跟 Version A 完全一樣，給使用者第二個選擇，風格方向要有明顯差異；不能只寫「同上」或只換幾個形容詞帶過，要重新完整寫出一個真正不同的版本）\n\n兩個版本都完成後，最後只需要輸出：\n\n請選擇你最喜歡的版本：\n\n○ Version A\n\n○ Version B\n\n○ 都不喜歡（重新產生）\n\n不要再多問其他問題。\n\n接下來使用者只會回覆「A」「B」或「重新產生」：\n- 收到「A」或「B」：請直接重新輸出使用者選的那個版本的完整四個區塊內容（不要摘要、不要只講差異），不要額外加上任何提醒文字或操作說明。\n- 收到「重新產生」：請重新完成兩個新的 Version A／Version B，直到使用者選定為止。'));

  list.push(tpl('flow_specific', '寫作師', 'material', '教材撰寫', '教材出版／教材作者',
    '你是教材出版流程中的教材作者。\n\n請根據以下教材規劃與前一步成果，直接完成正式教材內文，讓使用者可以直接使用，不是草稿。\n\n教材／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n教材目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n每個版本都要包含完整教材內文，包含適合初學者的舉例，以及練習題或反思問題。用詞要白話、避免術語堆疊，讓沒有背景的讀者也看得懂。兩個版本請用不同的切入角度或例子，不要只是換幾個字。' +
    abPolishModeBlock('（依上面要求輸出完整教材內文）')));

  list.push(tpl('flow_specific', '寫作師', 'product', '文案', '商品行銷／文案師',
    '你是商品行銷流程中的文案師。\n\n請根據以下商品資訊與賣點分析，直接完成正式商品文案，讓使用者可以直接使用，不是草稿。\n\n商品／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n行銷目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n每個版本都要包含完整商品文案：主打文案（1-2句）、完整商品描述、適合社群發布的短版本。文案要真誠、有畫面，不要浮誇或誇大不實。兩個版本請用不同的主打角度，不要只是換幾個形容詞。' +
    abPolishModeBlock('（依上面要求輸出完整商品文案）')));

  // 商品行銷工作區重整（第一個子工作，2026-07-14）：行銷海報獨立成自己的 Flow，
  // 「海報文案」比一般商品文案更精簡（要能印在海報上），「視覺設計」比照影片腳本的
  // 【圖片描述建議】做法，直接產出一句完整的圖片生成請求，使用者整段複製就能貼去圖片工具。
  list.push(tpl('flow_specific', '寫作師', 'poster', '海報文案', '行銷海報／文案師',
    '你是商品行銷流程中的海報文案師。\n\n請根據以下商品資訊與工作 Brief（若有），直接完成一份完整、可以直接使用的海報文案正式版，不是草稿。\n\n商品／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n行銷目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n每個版本都要包含：主標題、副標題（若需要）、必須出現的資訊（例如價格、活動時間、聯絡方式，若工作 Brief 有提到）、一句 CTA（呼籲行動）。文字要精簡有力，適合印在海報上，不要寫成一整段文章。兩個版本請用不同的主打角度，不要只是換幾個字。' +
    abPolishModeBlock('（依上面要求輸出完整海報文案：主標題／副標題／必要資訊／CTA）')));

  list.push(tpl('flow_specific', '設計師', 'poster', '視覺設計', '行銷海報／視覺設計師',
    '你是商品行銷流程中的海報視覺設計師。\n\n請根據以下已完成的海報文案，直接完成一份完整、可以直接使用的視覺設計內容，讓使用者可以直接帶去圖片工具生成海報。\n\n商品／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n\n已有成果（含海報文案）：\n{{previous_results}}\n\n每個版本都務必依照以下兩個區塊格式輸出，保留【】標題文字（這是為了讓使用者的工作台能自動分開顯示，請勿省略或改變標題文字）：\n\n【圖片生成請求】\n**直接寫成一句完整的圖片生成請求，開頭就要是「請直接生成一張海報」這種明確要求動手生成的語氣，不是描述或建議**（例如「請直接生成一張海報：主標題『……』、副標題『……』，暖色調背景，簡約排版，把文字清楚放進畫面裡」），把海報文案的主標題／副標題／必要資訊明確寫進這句請求裡。這句話之後會被使用者原封不動貼給另一個 AI 或工具，如果那個 AI／工具本身具備生成圖片的能力，看到這句話就應該直接動手生成海報圖片，而不是回覆文字描述、方向建議或排版說明；如果不具備生成圖片能力，這句話仍然要清楚到可以直接複製貼進 Canva、Gemini 等其他工具使用。讓使用者能整段複製，不需要自己補充或重新組織文字。\n\n【風格建議】\n用 1-2 句話描述適合這張海報的整體視覺風格（例如色調、排版、氛圍），可以直接附加在圖片生成請求後面一起使用。\n\n這份內容會直接被使用者帶去圖片工具製作，內容要具體到可以直接生成，不是抽象的方向建議。兩個版本請給不同的視覺切角，不要只是換幾個字。' +
    abPolishModeBlock('（依上面兩個【】區塊格式完整輸出）')));

  // Video Workflow vNext（CEO 核准）：「主題」步驟改為引導式協作——不是丟開放式問題
  // 讓使用者自己想，而是 AI 先判斷目的／觀眾，資訊足夠就直接給 2-3 組「文案方向＋
  // 影片風格」組合（各附差異／適用情境／短範例），使用者在同一個外部對話裡選擇、
  // 混搭或微調，最後只回填一次「確定方向」。這整段漸進協作發生在外部 AI 對話視窗
  // 裡（比照既有「歌名＋歌詞」模板的多輪對話設計），不是在工作台內新增好幾個確認
  // 畫面——App 畫面數量不因為引導式協作而增加。
  list.push(tpl('flow_specific', '規劃師', 'video', '主題', '影片製作／方向顧問',
    '你是影片製作流程中的方向顧問。\n\n請根據使用者這次想拍的影片，先判斷目的與觀眾，再直接給出方向，不要用一堆開放式問題讓使用者自己想清楚。\n\n影片／工作名稱：{{work_name}}\n已有成果／工作 Brief（若有）：\n{{previous_results}}\n\n請依序完成：\n\n' +
    '1. 先用 1-2 句話判斷這支影片可能的「目的」（例如：分享生活／推廣商品／記錄回憶／品牌宣傳）與「觀眾」（例如：親友／潛在客戶／一般大眾）。如果現有資訊已經足夠判斷，直接寫出你的判斷，不要用問句；只有目的或觀眾完全無法判斷時，才用最多 1-2 個問題請使用者補充，不要為了想更完整就一直追問。\n\n' +
    '2. 接著直接提供 2-3 組「文案方向＋影片風格」組合，每組都要包含：\n   - 方向名稱（例如：溫馨陪伴／輕快活力／專業質感）\n   - 核心主軸（1-2句話）\n   - 適合情境（例如：適合想營造親近感的品牌／適合節奏明快的商品介紹）\n   - 簡短範例（1-2句實際的文案語氣範例，讓使用者感受差異，不是抽象形容詞堆砌）\n\n' +
    '3. 完成後只需要輸出：\n\n請選擇你最喜歡的方向，也可以直接說「混合 A 跟 B」或提出微調想法：\n\n○ 方向 A\n○ 方向 B\n○ 方向 C（若有）\n○ 都不滿意（重新產生）\n\n不要再多問其他問題。\n\n' +
    '接下來使用者可能：直接選一個方向、要求混搭（例如「A 的主軸但 B 的語氣」）、提出微調想法、或「都不滿意」。請依使用者的回覆調整，直到使用者明確確認一個最終方向為止。使用者確認後，請直接輸出定案內容，固定格式：\n\n' +
    '【確定方向】\n目的：……\n觀眾：……\n文案方向／敘事調性：……（1-2句話講清楚就好）\n初步風格傾向：……（1-2句話，例如色調、氛圍）\n\n不要在使用者還沒明確確認前就輸出這個格式，也不要在確認後才附加其他版本或分析，也不要額外加上任何提醒文字或操作說明。'));

  // Video Workflow vNext（CEO 核准）：「腳本」步驟改成一次產出完整「影片母稿」
  // （Master Script）——總覽＋逐幕內容，且每一幕直接附帶圖片／影片 Prompt，不再是
  // 三段扁平文字。這是唯一一步要求 AI 一次產出較多內容的步驟，因為圖片／影片 Prompt
  // 需要跟逐幕內容共用同一次生成的風格判斷，不需要另開一次對話重新餵一次風格設定。
  // 標記格式（【總覽】／【第N幕｜名稱】）由 parseMasterScript() 解析，解析失敗時
  // submitPasteBack() 會擋下、不推進步驟（見該函式與 CEO 核准的「單一主資料」原則）。
  //
  // Correction Proposal Stage B（CEO 核准，真人測試發現逐幕各自發想旁白會斷裂、看不出
  // 整體故事是否流暢）：改成先寫一篇完整、連貫、可以直接朗讀的「完整影片文案／旁白稿」，
  // 再依這篇文案切分逐幕，逐幕旁白只能是原文片段、不能重寫，跟 parseMasterScript() 在
  // Stage A 就已經要求的【完整影片文案／旁白稿】必要區塊＋narrationConsistentWithFullScript()
  // 一致性驗證完全對應——這裡是讓 AI 實際產出 Stage A 解析器已經要求的格式。影片 Prompt
  // 額外要求固定加入「排除聲音」限制文字，避免圖生影片工具自行加上旁白/對嘴/配樂。
  list.push(tpl('flow_specific', '寫作師', 'video', '腳本', '影片製作／腳本統籌',
    '你是影片製作流程中的腳本統籌。\n\n請根據已確定的文案方向與風格設定，先完成一篇從頭到尾完整連貫、可以直接朗讀的「完整影片文案／旁白稿」，再依這篇文案切分成逐幕內容——**逐幕旁白只能是這篇完整文案的對應片段，不能重新發想、改寫、新增或刪減內容**，圖片與影片指令則依逐幕旁白、畫面意圖與風格設定衍生，不是另外發想新故事。這一步要一次產出後續所有步驟都能直接引用的正式內容，不是草稿。\n\n' +
    '影片／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n影片目標：{{goal}}\n\n已有成果（含確定方向）：\n{{previous_results}}\n\n目前的風格設定（色調／光線／畫面節奏／配音性格／語速等，若使用者在創作偏好調整過，以下面設定為準）：\n{{creative_preferences}}\n\n' +
    '請注意：這一步是延伸「已確定方向」的具體化，不是重新發想新的主軸或風格——如果前面已經有「確定方向」的內容，完整文案與風格必須沿著那個方向具體化，不能另闢新的主題或語氣。\n\n' +
    '請依序完成：\n\n' +
    '1. 先寫一篇完整、連貫、從頭到尾可以直接朗讀的影片文案，包含開場鉤子、核心內容、情緒或故事推進、結尾收束，以及適合的行動邀請，不用分幕、不用標記幕次，就是一篇完整文案。\n\n' +
    '2. 再把這篇完整文案依畫面轉換的地方切分成幾幕（通常 3-6 幕，不要為了長度硬湊幕數），每一幕的「旁白／文案」必須是完整文案裡對應的那一段原文，不可以重寫、精簡、擴寫或調整用字——如果切分後唸起來稍微不順，寧可調整幕的切法，也不要改動文字本身。\n\n' +
    '3. 每一幕的圖片生成指令，必須依據這一幕的旁白內容、畫面意圖，以及上面的風格設定（色調、光線、人物設定等）產生，不能脫離完整文案另外發展新的畫面故事。\n\n' +
    '4. 每一幕的影片生成指令，目的只是讓這一幕已經完成的圖片自然動起來（例如鏡頭推近／拉遠／平移、人物微動作、環境動態、轉場），**必須在指令裡完整加入以下限制文字，一字不漏**：「只生成無聲畫面。不要旁白。不要人物說話或對嘴。不要字幕。不要背景音樂。不要額外音效。聲音、旁白、字幕與配樂將在後製階段統一加入。」\n\n' +
    '每個版本都務必依照以下格式輸出，保留【】標題文字，區塊之間空一行（這是為了讓使用者的工作台能自動解析內容，請勿省略或改變標題文字，也不要用 Markdown 的 ** 或 # 包住標題）：\n\n' +
    '【完整影片文案／旁白稿】\n（從第一句到最後一句，完整連貫、可以直接朗讀的一篇文案，不要分幕、不要加入幕次標記）\n\n' +
    '【總覽】\n目的：（1句話）\n觀眾：（1句話）\n長度：（例如：30-60秒）\n主軸：（1-2句話，這支影片最核心想傳達的一句話）\n敘事調性：（1句話，例如：陪伴分享／故事敘事／直接介紹）\n主要人物設定：（若影片有主要人物或角色，1-2句話描述；沒有明確人物就寫「無特定人物」）\n音樂方向：（1句話，例如：溫暖木吉他伴奏／輕快節奏電子樂）\n\n' +
    '【第1幕｜幕名稱】\n旁白／文案：（必須是上面完整文案裡的對應原文片段，逐字引用，不能改寫、精簡或擴寫）\n字幕：（跟旁白對應，適合螢幕呈現的簡短版本，如果跟旁白幾乎一樣可以直接寫「同旁白」）\n畫面意圖：（這一幕想呈現的畫面，具體到場景、主體、動作、氛圍）\n預估秒數：（例如：8秒）\n情緒與語氣：（1句話）\n素材需求：（例如：1張人物特寫圖）\n圖片 Prompt：（直接寫成一句完整的圖片生成請求，開頭就是「請直接生成一張……的圖片」這種明確要求動手生成的語氣，把這一幕的旁白內容、畫面意圖、風格設定的色調／光線／人物設定都寫進這句話裡，使用者要能整段複製直接貼給圖片工具）\n影片 Prompt：（直接寫成一句完整的圖生影片請求，說明這張圖要怎麼動起來，把畫面節奏也寫進去，並且完整包含上面第 4 點規定的無聲限制文字，使用者要能整段複製直接貼給影片工具）\n\n' +
    '【第2幕｜幕名稱】\n（格式跟第1幕完全一樣，繼續下一幕，旁白一樣必須是完整文案的對應片段）\n\n……（依「長度」設定的合理幕數繼續，通常 3-6 幕，不要為了長度硬湊幕數）\n\n完整文案、總覽與所有幕都完成後，才進入下面的版本選擇規則。\n\n' +
    '請直接完成兩個完整、正式、可以直接使用的版本，不是草稿、不是方向、不是分析：\n\n## Version A\n（依上面完整格式輸出【完整影片文案／旁白稿】＋【總覽】＋所有幕）\n\n## Version B\n（格式跟 Version A 完全一樣，但敘事切角要有實際差異，不能只換幾個字；兩版的完整文案與幕數都可以不同）\n\n' +
    '兩個版本都完成後，最後只需要輸出：\n\n請選擇你最喜歡的版本：\n\n○ Version A\n\n○ Version B\n\n○ 都不喜歡（重新產生）\n\n不要再多問其他問題。\n\n' +
    '接下來使用者只會回覆「A」「B」或「重新產生」：\n- 收到「A」或「B」：請直接重新輸出使用者選的那個版本的完整內容（只要【完整影片文案／旁白稿】＋【總覽】＋所有幕本身，不要包含「## Version A」這種版本標題，不要摘要、不要局部修改），不要額外加上任何提醒文字或操作說明。\n- 收到「重新產生」：請重新完成兩個新的 Version A／Version B，直到使用者選定為止。'));

  // Video Workflow vNext（CEO 核准，本輪真人測試明確要求的必做項目）：「配音與字幕」
  // 逐幕產出正式配音稿／配音語氣／語速與停頓／字幕，內容必須直接引用上一步「影片母稿」
  // 裡每一幕的旁白／文案，不得重新創作或改寫內容本身——這是本輪跟「腳本」不一樣的地方：
  // 「腳本」是產出新內容，「配音與字幕」是把已經定案的文字轉換成適合口白／字幕的格式，
  // 不是重新發展一套新的文案。標記格式（【第N幕...】）由 parseVoiceoverAndSubtitles() 解析，
  // 幕數必須完整對應 Master Script，解析失敗時 submitPasteBack() 會擋下、不推進步驟。
  //
  // Correction Proposal Stage B：跟腳本同樣道理，先產出完整配音稿（只加斷句/呼吸/停頓/
  // 語速/情緒提示，不改寫內容），再對應回逐幕，避免文案被逐幕切碎後各自加油添醋。這裡沒有
  // 改動 parseVoiceoverAndSubtitles() 的解析規則——該函式原本就是用 /【第(\d+)幕[^】]*】/
  // 這種寬鬆比對抓幕次標記，「【第1幕配音對照】」一樣能正確比對到 sceneNo=1；【完整配音稿】
  // 這個新區塊排在所有幕次標記之前，解析時會被當成前導文字略過，不影響逐幕解析，也不會被
  // 誤判成某一幕的內容（已用 test_master_script_vnext.js 實際測試驗證，非僅推論）。
  list.push(tpl('flow_specific', '寫作師', 'video', '配音與字幕', '影片製作／配音與字幕指導',
    '你是影片製作流程中的配音與字幕指導。\n\n請根據下面「影片母稿」裡已經定案的完整影片文案／旁白稿，先完成一份【完整配音稿】——**只能加入斷句、呼吸、停頓、語速與情緒提示，絕對不能改寫、精簡、擴寫或調整完整文案的用字與內容**，再把這份完整配音稿對應回每一幕，方便使用者剪輯時定位使用。\n\n' +
    '影片／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n\n已有成果（含影片母稿，完整文案與逐幕旁白請直接引用，不要改寫內容）：\n{{previous_results}}\n\n目前的風格設定（配音性格／語速等）：\n{{creative_preferences}}\n\n' +
    '請依序完成：\n\n' +
    '1. 先產出【完整配音稿】：把母稿裡的完整影片文案／旁白稿，加上斷句、呼吸、停頓標記、語速與情緒提示，內容必須跟原文完全一致，不能有任何一句被改寫、精簡、擴寫或新增。\n\n' +
    '2. 再依照每一幕，把完整配音稿對應回去，產出逐幕配音對照，方便使用者跟每一幕的畫面／剪輯對照使用。\n\n' +
    '請針對母稿裡的**每一幕**（幕數要完全對應，不能少幕），依照以下格式輸出，保留【】標題文字，區塊之間空一行（這是為了讓使用者的工作台能自動解析，請勿省略或改變標題文字）：\n\n' +
    '【完整配音稿】\n（完整文案加上斷句／呼吸／停頓／語速／情緒提示後的版本，內容必須跟原文完全一致，不是重寫）\n\n' +
    '【第1幕配音對照】\n配音稿：（這一幕對應的配音稿片段，跟上面完整配音稿一致，只是對應這一幕的部分；內容意思必須跟原本旁白一致，只能調整標點、停頓與口語化語氣，不能改變原意或加入新內容）\n配音語氣：（1句話，例如：溫暖、稍微放慢，像在跟朋友分享）\n語速與停頓：（具體標註，例如：整體語速中等；在「……」這句之後停頓約 0.5 秒，加強情緒）\n字幕：（適合螢幕呈現的簡短版本，跟配音稿意思一致；如果字數需要拆成兩行請直接換行呈現）\n\n' +
    '【第2幕配音對照】\n（格式相同，繼續下一幕，直到涵蓋母稿的所有幕）\n\n' +
    '全部幕都完成後，才進入下面的確認規則。\n\n' +
    '完成後只需要輸出上面內容，不要額外加上任何提醒文字或操作說明，不要多問其他問題，不要提供多個版本選擇（這一步是把已定案內容轉換格式，不需要 A／B 版本挑選）。'));

  list.push(tpl('flow_specific', '寫作師', 'ebook', '撰寫', '電子書／內文作者',
    '你是電子書流程中的內文作者。\n\n請根據以下大綱與蒐集的資料，直接完成正式電子書內文，讓使用者可以直接使用，不是草稿。\n\n電子書／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n電子書目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n每個版本都要包含完整章節內文，用詞要白話、避免術語堆疊，讓讀者不用查資料就看得懂。兩個版本請用不同的敘事語氣或切入角度，不要只是換幾個字。' +
    abPolishModeBlock('（依上面要求輸出完整章節內文）')));

  // Prompt 2.0（Official Flow Prompt Review Report，2026-07-31 CEO 核准）：course／website
  // 兩個 Official Flow 原本 0% 覆蓋，全部退回通用模板，從沒具體說過成果該長什麼樣子。
  // 這裡比照 material／ebook 已驗證有效的模式，補上創作型步驟的專屬模板（Pattern 1／
  // 完整雙版本 A/B），不動這兩個 Flow 的步驟結構本身。
  list.push(tpl('flow_specific', '規劃師', 'course', '大綱', '課程設計／課程架構師',
    '你是課程設計流程中的課程架構師。\n\n請根據以下課程主題，直接完成一份完整、可以直接使用的課程大綱，不是草稿或討論方向。\n\n課程／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n課程目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n每個版本都要包含：課程目標（1-2句話）、適合對象、建議總長度或堂數、逐堂／逐模組安排（每堂列出：主題名稱、學習重點、預估時間）。安排要循序漸進，從基礎到進階，讓沒有背景的學員也跟得上。兩個版本請用不同的切入角度或編排順序，不要只是換幾個字。' +
    abPolishModeBlock('（依上面要求輸出完整課程大綱）')));

  list.push(tpl('flow_specific', '寫作師', 'course', '內容撰寫', '課程設計／課程講師',
    '你是課程設計流程中的課程講師。\n\n請根據以下課程大綱，直接完成正式課程內容，讓使用者可以直接拿去授課或錄製，不是草稿。\n\n課程／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n課程目標：{{goal}}\n\n已有成果（含課程大綱）：\n{{previous_results}}\n\n每個版本都要包含完整課程內文，依大綱逐堂／逐模組撰寫，包含適合初學者的舉例、實作練習或反思問題。用詞要白話、避免術語堆疊。兩個版本請用不同的敘事語氣或舉例方式，不要只是換幾個字。' +
    abPolishModeBlock('（依上面要求輸出完整課程內容）')));

  list.push(tpl('flow_specific', '寫作師', 'website', '內容整理', '建立網站／網站文案師',
    '你是建立網站流程中的網站文案師。\n\n請根據以下網站規劃，直接完成正式網站文字內容，讓使用者可以直接放上網站，不是草稿。\n\n網站／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n網站目標：{{goal}}\n\n已有成果（含網站規劃）：\n{{previous_results}}\n\n每個版本都要包含各頁面的完整文字內容，依網站規劃逐頁撰寫（例如首頁、關於我們、服務或商品介紹、聯絡方式，實際頁面請依規劃內容決定），每一頁請標明頁面名稱。文字要清楚、有說服力，符合網站目標。兩個版本請用不同的語氣或切入角度，不要只是換幾個字。' +
    abPolishModeBlock('（依上面要求輸出各頁面完整文字內容）')));

  list.push(tpl('flow_specific', '設計師', 'website', '頁面設計', '建立網站／網站視覺設計師',
    '你是建立網站流程中的網站視覺設計師。\n\n請根據以下已完成的網站文字內容，直接完成一份完整、可以直接使用的頁面設計說明，讓使用者可以直接帶去網站建置工具或請工程師動手做。\n\n網站／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n\n已有成果（含網站文字內容）：\n{{previous_results}}\n\n每個版本都務必依照以下兩個區塊格式輸出，保留【】標題文字（這是為了讓使用者的工作台能自動分開顯示，請勿省略或改變標題文字）：\n\n【頁面設計說明】\n逐頁列出版面配置，每一頁請包含：頁面名稱、區塊順序（例如：頂部導覽→主視覺Banner→服務介紹→客戶見證→聯絡表單→頁尾）、每個區塊要放的內容重點、建議的視覺呈現方式（例如圖片、圖示、按鈕）。內容要具體到可以直接告訴建置工具或工程師怎麼做，不是抽象的方向建議。\n\n【風格建議】\n用 1-2 句話描述整體視覺風格（例如色調、字體調性、排版氛圍），可以直接附加在頁面設計說明後面一起使用。\n\n兩個版本請給不同的版面配置或視覺切角，不要只是換幾個字。' +
    abPolishModeBlock('（依上面兩個【】區塊格式完整輸出）')));

  list.push(tpl('flow_specific', '研究員', 'research', '文獻蒐集', '研究員／文獻蒐集',
    '你是研究與論文寫作流程中的研究員，這一步是文獻蒐集。\n\n請根據以下研究背景，直接完成與主題相關的文獻蒐集結果。\n\n研究／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n研究目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出：相關文獻方向與核心概念、重要關鍵字、可能的研究缺口。\n\n請注意：\n- 請標註資料來源\n- 不確定的地方請直接標記「需要查證」，不要捏造文獻、作者、年份或 DOI'));

  list.push(tpl('flow_specific', '研究員', 'research', '文獻整理', '研究員／文獻整理',
    '你是研究與論文寫作流程中的研究員，這一步是文獻整理。\n\n請根據以下已蒐集的文獻資料，直接完成整理歸納的正式結果。\n\n研究／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n研究目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請用表格直接輸出，這是可以直接使用的正式版本：\n| 作者／年份 | 主題 | 方法 | 發現 | 可用處 |\n|---|---|---|---|---|\n\n請注意：\n- 不確定的作者、年份、來源請標記「需要查證」或「尚無來源」，不要捏造'));

  list.push(tpl('flow_specific', '寫作師', 'research', '初稿撰寫', '寫作師／論文初稿',
    '你是研究與論文寫作流程中的寫作師，這一步是初稿撰寫。\n\n請根據以下研究架構與大綱，直接完成論文段落初稿，這是可以直接使用的正式版本，不是討論或大綱。\n\n研究／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n研究目標：{{goal}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出完整初稿段落。\n\n請注意：\n- 語氣正式、邏輯清楚\n- 避免未經查證的斷言，不確定處請標記「需要查證」，不要捏造引用或數據'));

  list.push(tpl('flow_specific', '審查員', 'research', '引用與參考資料', '審查員／引用檢查',
    '你是研究與論文寫作流程中的審查員，這一步是引用與參考資料檢查。\n\n請根據以下內容，直接完成檢查，輸出明確的檢查結論。\n\n研究／工作名稱：{{work_name}}\n目前步驟：{{step_name}}\n\n已有成果：\n{{previous_results}}\n\n請直接輸出：「需要補證據」的段落清單、「建議修改」的段落清單、引用格式是否一致、整體檢查結論。這是一份可以直接使用的正式檢查報告。\n\n請注意：\n- 不確定的引用來源請標記「需要查證」，不要幫忙捏造來源'));

  // ── 3. Polish Template（作品打磨，Polish Studio 的修正指令唯一來源）──
  list.push(tpl('polish', null, null, null, '作品打磨教練',
    '你是作品打磨教練。\n\n請根據使用者選擇的修改方向，直接完成修改後的正式版本，這是可以直接使用、回填的成果，不是討論。\n\n工作：{{work_name}}\n目前步驟：{{step_name}}\n使用角色：{{role_name}}\n使用 AI：{{ai_name}}\n\n上一版成果：\n{{current_result}}\n\n使用者想修改的方向：\n{{revision_direction}}\n\n請保留原本作品的優點，針對修改方向調整，不要偏離原本主題。請直接輸出修改後的完整版本，完成後簡短說明修改了哪些地方即可，不需要額外討論。'));

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
// 修正（Phase 1A，Research Prompt Matching Bug）：找不到精準 stepName 比對時，不能隨便回傳
// 同角色的第一個 flow_specific 模板——這在只有 1 個同角色 flow_specific 模板的 Flow 不會有事，
// 但 research 角色下有多個模板（研究員/審查員/寫作師各自 >=1 個），沒有精準比對就必須直接
// 退回 global_role，否則會把不相干步驟的模板誤套到別的步驟上（例如「論文大綱」誤用「初稿撰寫」的指令）。
function resolveAiInstructionTemplate(flowId, role, stepName) {
  var flowSpecific = state.promptTemplates.filter(function (t) { return t.type === 'flow_specific' && t.flowType === flowId && t.role === role; });
  var exact = flowSpecific.find(function (t) { return t.stepName === stepName; });
  if (exact) return exact;
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

// ★ Official Prompt Engine 修正（最高優先，CEO 指令）：
// 所有 Official Flow 的指令都共用這個 Context Pack，是加入「Deliverable Mode」
// 共通規則最合適的地方——不用個別去改每一份模板，一次生效，且因為這是常數
// （不像個別模板存在 localStorage），對現有使用者也立即生效，不需要資料遷移。
const CONTEXT_PACK_TEMPLATE =
  '# 專案背景\n\n' +
  '## 專案\n{{project_name}}\n\n' +
  '## 工作\n{{work_name}}\n\n' +
  '## 工作目標\n{{goal}}\n\n' +
  '## 工作 Brief（若有）\n{{work_brief}}\n\n' +
  '## 使用流程\n{{flow_name}}\n\n' +
  '## 目前步驟\n{{step_name}}\n\n' +
  '## 目前角色\n{{role_name}}\n\n' +
  '## 建議使用 AI\n{{ai_name}}\n\n' +
  '## 已完成步驟\n{{completed_steps}}\n\n' +
  '## 前面累積成果\n{{previous_results}}\n\n' +
  '## 目前成果庫相關成果\n{{related_assets}}\n\n' +
  '## 創作偏好\n{{creative_preferences}}\n\n' +
  '## 工作模式（重要）\n' +
  '你只負責完成目前這個步驟，不可以自行跳到其他工作，也不可以岔開成教學或延伸討論。\n' +
  '你的任務不是陪使用者討論，而是直接完成這一步需要交付的正式成果（Deliverable）；只有在缺少完成成果所需的關鍵資訊時，才提出最少必要的問題，且最多一次問 1 至 3 題，不得用大量提問拖延產出。\n' +
  '不要：反覆分析、列出很多方向或選項、要求使用者想清楚更多、討論已經足夠的資訊、寫成說明文件或教學。每一步只完成一件事——這一步該交付的那個成果（除非下面「本次任務」明確要求 A/B 兩個版本，那是刻意設計的打磨模式，不算違反這條原則）。\n' +
  '完成後的成果必須能直接複製、貼上使用、交給下一位協作者或下一個工具，不是一份討論紀錄；如果這個成果之後要貼到別的工具（例如 Suno、ChatGPT、Kling）才能繼續，請直接產出那個工具可以直接使用的正式內容，讓使用者只需要微調，不需要自己重新整理或改寫格式。內容不得過度簡略到無法支援下一步（一句話、幾個關鍵字或空泛結論都不算完成），也不要過度解釋，優先交付成果，說明簡短即可。請保持跟「工作 Brief」「前面累積成果」「創作偏好」一致，不要擅自改變核心方向。\n\n' +
  '## 本次任務\n{{step_instruction}}\n\n' +
  '## 請輸出格式\n{{output_format}}\n\n' +
  // Prompt 2.0 Blocking Fix（技術長 Approve after Fix，2026-07-31）：AI 成果內容要跟工作台
  // 操作指引真正拆開——原本「貼回提醒」段落與「回答前請確認」第 6 點都在暗示 AI 應該在
  // 成果裡加一句提醒使用者複製貼回的話，這件事已經由 screen-paste-back 的標題／說明文字／
  // 保存按鈕獨立負責，不該讓 AI 覺得自己也要顧到這件事。這裡只留「格式要清楚、方便直接
  // 使用」這個純粹跟成果品質有關的要求，拿掉「貼回」這個工作台操作概念。
  '## 格式提醒\n請確保內容分段清楚，是可以直接使用的正式成果，不需要使用者自己整理格式。\n\n' +
  '## 回答前請確認\n' +
  '1. 是否直接完成目前步驟？\n' +
  '2. 是否使用了使用者提供的真實資訊？\n' +
  '3. 成果是否足以進入下一步？\n' +
  '4. 是否避免岔題、空泛與過度解釋？\n' +
  '5. 是否輸出清楚的正式成果區塊，沒有多餘的操作提醒或說明文字？\n' +
  '若任一項不符合，請先補足再輸出。';

const AUDIENCE_BY_FLOW = {
  material: '初學者、一般讀者', course: '初學者、一般讀者', product: '潛在客戶', poster: '潛在客戶',
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
  const others = state.results.filter(function (r) { return r.projectId === projectId && r.workId !== workId && r.isFinal && !r.isBriefDraft; });
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
      '## 寫作風格\n請維持這個工作目前的語氣與風格，跟前面已完成的內容一致、不要互相矛盾（前面的成果已經列在上方「前面累積成果」，這裡不重複貼一次）。\n\n' +
      '## 目標讀者\n{{audience}}',
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
  // 歌曲一旦選定正式歌名（work.songTitle），Context Pack 的「工作」欄位改顯示正式歌名，
  // 不再顯示工作名稱（管理用途）——工作名稱用來管理工作，正式歌名要從歌詞與作品內容中誕生
  const workDisplayName = (work.flowId === 'song' && work.songTitle) ? work.songTitle : work.name;

  const vars = {
    project_name: project ? project.name : '',
    work_name: workDisplayName,
    song_title: work.songTitle || work.name,
    goal: work.name,
    work_brief: work.brief || '',
    flow_name: flow.name,
    step_name: step.name,
    role_name: step.role,
    ai_name: suggestedToolForStep(work.flowId, step.role, step.name).name,
    completed_steps: flow.steps.slice(0, work.currentStepIndex).map(function (s) { return s.name; }).join('、') || '（尚未完成任何步驟）',
    previous_results: buildPreviousResults(workId),
    related_assets: buildRelatedAssets(work.projectId, workId),
    // Video Workflow vNext：「腳本」步驟確認之後的每一步（配音與字幕、製作影片…），一律讀取
    // 該次 Master Script 確認當下凍結的 Style Anchor 快照，不讀即時的 Creative Preferences——
    // 避免使用者事後調整偏好設定，讓已確認的影片內容被悄悄改變語氣或風格（CEO 明確要求）。
    // 「腳本」步驟本身、以及其他 Flow，都還是讀即時設定，不受影響。
    creative_preferences: (function () {
      if (work.flowId === 'video') {
        const scriptIdx = FLOWS.video.steps.findIndex(function (s) { return s.name === '腳本'; });
        if (work.currentStepIndex > scriptIdx && getMasterScript(work)) return getConfirmedStyleAnchorText(work);
      }
      return buildCreativePreferencesText(work);
    })(),
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
  if (work.flowId === 'product' || work.flowId === 'poster') {
    return fillTemplate(
      '## ⚠️ 不可虛構商品資訊提醒\n' +
      '以下資訊只能使用「工作 Brief」或「前面累積成果」裡使用者實際提供的內容，絕對不得自行虛構或猜測：商品／活動名稱、品牌名稱、價格、優惠或贈品金額、日期、時間、地點、聯絡方式、報名或購買網址、商品規格與功能、講師或主辦單位、認證與數據。\n' +
      '如果上述任一項目是完成本步驟所必要的關鍵資訊，但使用者沒有提供，請用「【請填入：＿＿＿】」的方式標記空白，或依「工作模式」規則只提出最少必要的問題，不要自己編一個看起來合理的答案。\n' +
      '可以由你自由發想、但完成後需標明是建議、讓使用者確認的部分：主標／副標／文案措辭、CTA 呼籲行動的說法、視覺風格方向、排版建議。',
      vars
    );
  }
  if (work.flowId === 'customer_reply') {
    return fillTemplate(
      '## ⚠️ 不可虛構客戶事實提醒（本 Flow 直接面向真實客戶，優先於其他 Flow 處理）\n' +
      '以下內容只能使用使用者實際提供的內容，絕對不得自行虛構或猜測：已經完成的處理進度、可以提供的補償或退費金額、承諾的時間點、訂單或帳務細節、公司政策與規定、任何對客戶的具體承諾。\n' +
      '如果使用者沒有明確說明「已經做了什麼」或「可以提供什麼」，請用最少必要的問題確認，不要自己編一個聽起來合理的處理方式或承諾——這類內容一旦發送給客戶就是實際的承諾，錯誤的虛構會直接造成信任問題或糾紛。\n' +
      '可以由你自由發想的部分：措辭方式、情緒安撫的說法、語氣的正式或親切程度。',
      vars
    );
  }
  return null;
}

// Phase 1A（乾淨生成指令獨立區塊，見全域契約「乾淨指令」原則）：把「這一步真正要交付什麼」
// 的純指令文字，從「背景脈絡」裡拆出來成獨立函式，兩者原本就是概念上不同的兩塊（Context Pack
// 回答「這是什麼情況」，這裡回答「現在要做什麼」），只是過去合併在一個函式裡直接組字串，
// 沒有讓「乾淨指令」單獨可以被複製使用。
function buildCleanInstructionText(workId) {
  const work = getWork(workId);
  const step = currentStep(work);
  const template = resolveAiInstructionTemplate(work.flowId, step.role, step.name);
  const workDisplayName = (work.flowId === 'song' && work.songTitle) ? work.songTitle : work.name;

  const vars = {
    project_name: getProject(work.projectId) ? getProject(work.projectId).name : '',
    work_name: workDisplayName,
    song_title: work.songTitle || work.name,
    flow_name: FLOWS[work.flowId].name,
    step_name: step.name,
    role_name: step.role,
    ai_name: suggestedToolForStep(work.flowId, step.role, step.name).name,
    goal: work.name,
    previous_results: buildPreviousResults(workId)
  };

  let templateText = template ? fillTemplate(template.content, vars) : ('請協助完成「' + step.name + '」這個步驟。');
  // 歌曲靈感只出現在「歌名＋歌詞」這一步的模板裡（模板內容含 %%SONG_IDEA_BLOCK%% 標記），
  // 不透過 fillTemplate 的一般變數代換（那套機制對空字串會補「（無）」，不是我們要的「整段不出現」），
  // 用專屬字串標記手動插入／移除；其他模板內容沒有這個標記，.replace() 對它們是無效果的安全操作。
  return templateText.replace('%%SONG_IDEA_BLOCK%%', buildSongIdeaBlock(work));
}

// 指令母模 + 專案內容包 → 完整指令（先給背景，再給任務與輸出要求）
function buildAiInstructionFromTemplate(workId) {
  return buildContextPack(workId) + '\n\n---\n\n' + buildCleanInstructionText(workId);
}

// 歌曲靈感（Song Inspiration Hotfix，2026-07-13）：選填，使用者建立歌曲工作時可以先留下創作素材
// （一句話／關鍵字／畫面／回憶），只出現在「歌名＋歌詞」這一步的 Prompt 裡，不透過 Context Pack
// 傳給其他步驟——歌名需要一路往後傳（work.songTitle），但歌曲靈感只是這一步的創作起點，用完即止，
// 避免每一步的 Prompt 越來越長。沒有留靈感時整段不出現，不留下「（無）」這類提示字樣。
function buildSongIdeaBlock(work) {
  if (!work.songIdea || !work.songIdea.trim()) return '';
  return '【歌曲靈感】\n' + work.songIdea.trim() + '\n\n';
}

// Google Drive Backup MVP：schemaVersion 逐版遞增轉換（R14：舊 schemaVersion 處理）。
// 目前 CURRENT_SCHEMA_VERSION 是 1，是第一個有這個欄位的版本，沒有更早的結構需要轉換，
// 這個函式目前是空轉但保留逐版 if 的骨架——之後版本 2、3...才需要在這裡逐一補轉換規則，
// 不會因為現在沒有事情做就省略這個函式，避免之後新增版本時要臨時重建這個機制。
function migrateSchema(s) {
  // if (s.schemaVersion < 2) { ...v1→v2 轉換... s.schemaVersion = 2; }
  if (s.schemaVersion > CURRENT_SCHEMA_VERSION) {
    // 備份檔的 schemaVersion 比這個 App 版本認得的還新（例如之後小版本先在別的裝置更新過），
    // 不強行降級處理資料，只註記，避免程式碼對「看不懂的新結構」做出錯誤假設。
    s.schemaVersionNewerThanApp = true;
  }
}

// 既有 localStorage（Mission 019 之前建立）可能沒有這些欄位，載入後自動補齊，不影響既有資料
function ensureNewFields(s) {
  if (!s.promptTemplates) s.promptTemplates = buildDefaultPromptTemplates();
  // ★ Official Prompt Engine 修正（最高優先，CEO 指令）：把系統預設模板的內容
  // 更新成 Deliverable Mode 版本。個別模板存在 localStorage 裡，只改
  // buildDefaultPromptTemplates() 本身不會影響「已經在用」的使用者（例如已經
  // 累積很多工作紀錄的帳號），要靠這段依名稱比對、覆蓋內容才會真的生效。
  // 目前 Prompt Library 還沒有「使用者自訂模板」的編輯功能，isDefault 永遠是 true，
  // 所以覆蓋是安全的，不會蓋掉使用者自己修改過的版本（這個功能還不存在）。
  if (s.promptTemplates && s.promptTemplates.length) {
    var latestDefaults = buildDefaultPromptTemplates();
    var latestByName = {};
    latestDefaults.forEach(function (t) { latestByName[t.name] = t; });
    var existingNames = {};
    s.promptTemplates.forEach(function (t) {
      existingNames[t.name] = true;
      if (!t.isDefault) return;
      var latest = latestByName[t.name];
      if (latest && latest.content !== t.content) {
        t.content = latest.content;
        t.version = (t.version || 1) + 1;
        t.updatedAt = new Date().toISOString();
      }
    });
    // 全新增加的預設模板（例如這輪新增的電子書 A/B 模板）不會自動出現在既有使用者的清單裡，
    // 補進去時用「這個使用者現有資料裡最大 id + 1」，不能直接沿用 latestDefaults 重新產生的 id——
    // buildDefaultPromptTemplates() 的 id 是依 push 順序累加，這輪在陣列中間插入新模板會讓後面
    // 所有模板的 id 整批往後挪，沿用會跟使用者舊資料裡「不同名稱、剛好同一個 id」的模板撞號
    var maxId = s.promptTemplates.reduce(function (max, t) { return Math.max(max, t.id || 0); }, 0);
    latestDefaults.forEach(function (t) {
      if (!existingNames[t.name]) {
        maxId += 1;
        s.promptTemplates.push(Object.assign({}, t, { id: maxId }));
      }
    });
  }
  if (s.gasWebhookUrl === undefined) s.gasWebhookUrl = '';
  if (!s.myTools) s.myTools = buildDefaultMyTools();
  // 常用 AI（Preferred AI）：既有使用者不強迫補做第一次的引導畫面，直接視為「已詢問過」，
  // 之後隨時可以自己去「我的工作台 → 我的常用 AI」設定，不會打斷正在使用的人
  if (!s.myAiList) s.myAiList = [];
  if (s.preferredAiOnboarded === undefined) s.preferredAiOnboarded = true;
  if (!s.mutedCapabilityHints) s.mutedCapabilityHints = [];
  // 官方工具目錄新增工具時，既有使用者的清單也同步補上（預設啟用），這樣新工具才推薦得到，不用使用者自己手動加
  TOOLS_CATALOG.forEach(function (t) {
    if (!s.myTools.some(function (mt) { return mt.id === t.id; })) {
      s.myTools.push({ id: t.id, name: t.name, category: t.category, emoji: t.emoji, enabled: true, isCustom: false });
    }
  });
  s.results.forEach(function (r) { if (r.cloudStatus === undefined) r.cloudStatus = 'none'; });
  // Workspace Trust Sprint 1：舊資料沒有這些欄位時安全補上。
  // dataSafetyOnboarded 刻意預設 false（不是 true）——新舊使用者都要看過一次資料安全提醒，
  // 這點跟其他 onboarded 類欄位（例如 preferredAiOnboarded）的既有慣例不同，是 CEO 明確核准的決定。
  if (s.lastBackupAt === undefined) s.lastBackupAt = null;
  if (s.resultsCountAtLastBackup === undefined) s.resultsCountAtLastBackup = 0;
  if (s.dataSafetyOnboarded === undefined) s.dataSafetyOnboarded = false;
  // Google Drive Backup MVP：舊資料沒有 schemaVersion 一律視為版本 1（這是第一個
  // 有這個欄位的版本，沒有更早的結構需要轉換）；舊資料沒有雲端相關欄位時安全補上。
  if (!Number.isInteger(s.schemaVersion) || s.schemaVersion <= 0) s.schemaVersion = 1;
  migrateSchema(s);
  if (s.driveAccountEmail === undefined) s.driveAccountEmail = null;
  if (s.driveAccountSub === undefined) s.driveAccountSub = null;
  if (s.driveLastBackupAt === undefined) s.driveLastBackupAt = null;
  if (!Array.isArray(s.driveBackupTimestamps)) s.driveBackupTimestamps = [];
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
    myAiList: [],
    preferredAiOnboarded: false,
    mutedCapabilityHints: [],
    nextProjectId: 1, nextWorkId: 1, nextResultId: 1, nextPublishId: 1,
    // Workspace Trust Sprint 1：資料安全相關欄位。
    // dataSafetyOnboarded 新舊使用者一律預設 false（刻意跟 preferredAiOnboarded 的
    // 「舊帳號直接視為已詢問過」慣例不同）——資料遺失風險對所有使用者一視同仁，
    // 不分先來後到，見 ensureNewFields() 的對應處理。
    lastBackupAt: null,
    resultsCountAtLastBackup: 0,
    dataSafetyOnboarded: false,
    // Google Drive Backup MVP：CURRENT_SCHEMA_VERSION 是「本機／備份檔資料結構」的版本號，
    // 不是 App 版本號——之後資料結構有不相容變動時，這裡才需要遞增，並在 migrateSchema()
    // 補上對應的轉換規則。目前是第一版，所有既有欄位都算 schemaVersion 1。
    schemaVersion: CURRENT_SCHEMA_VERSION,
    // driveAccountEmail／driveAccountSub：Google 帳號防呆用（CEO 核准方案 A）。
    // sub 是 OIDC 穩定識別碼，程式邏輯（例如「這次選的帳號是不是跟上次備份時同一個」）
    // 一律比對 sub；email 只當畫面上給人看的標籤，不參與任何判斷邏輯。
    driveAccountEmail: null,
    driveAccountSub: null,
    driveLastBackupAt: null,
    // 備份節流用：只記錄「成功」備份的時間戳記（失敗重試不算），捲動視窗判斷
    // 每小時/每日上限，見 canStartDriveBackup()。定期修剪超過 24 小時的紀錄，避免無限增長。
    driveBackupTimestamps: []
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
  const finalCategory = flow.id === 'video' ? '影片' : flow.id === 'ebook' ? '電子書' : flow.id === 'course' ? '課程' : flow.id === 'material' ? '教材' : flow.id === 'product' ? '商品' : flow.id === 'poster' ? '海報' : flow.id === 'social' ? '社群貼文' : flow.id === 'song' ? '歌曲' : flow.id === 'research' ? '論文' : '其他';
  const final = {
    id: s.nextResultId++,
    title: work.name + '（最終成品）',
    projectId: project.id, projectName: project.name,
    workId: work.id, workName: work.name,
    flowId: flow.id, flowName: flow.name,
    stepName: '最終成品', role: '—', ai: aiUsed,
    content: pieces, category: finalCategory,
    completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isFinal: true,
    cloudStatus: 'none'
  };
  s.results.push(final);
  return final;
}

// Workspace Trust Sprint 1（Task 7）：修正既有風險——資料存在但損毀時（不是被清除，
// 是壞掉），以前的行為是靜默 catch、直接用示範假資料覆蓋，使用者完全不會被告知。
// 現在：先把損毀的原始內容備份到另一個 key（保留還原的可能性，不是馬上蓋掉），
// 設一個旗標讓 startApp() 導向明確的告知畫面，而不是讓使用者以為這就是自己的資料。
//
// Blocking 1（技術長複審修正）：偵測到損毀時，絕對不能呼叫 saveState()——
// 原本的寫法在建立示範資料後仍然存回主 key，等於損毀的原始內容被合法示範資料
// 覆蓋掉，下次重新啟動時 localStorage 讀到的已經是「看起來正常」的示範資料，
// 不會再偵測到損毀、也不會再顯示告知畫面。現在的行為：主 key 原封不動保留損毀內容，
// 只在記憶體裡建立暫時的預設 state 讓畫面能運作，不主動寫回任何地方；使用者按
// 「繼續使用」後，除非透過既有的正常操作（新增專案、還原備份等）觸發原本就存在的
// saveState() 呼叫，否則主 key 不會被這個復原流程本身順便蓋掉。
let dataCorruptionDetected = false;
function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      state = JSON.parse(raw);
      ensureNewFields(state);
      saveState();
      return;
    } catch (e) {
      backupCorruptedRawIfNeeded(raw);
      dataCorruptionDetected = true;
      state = defaultState();
      seedDemoData(state);
      return;
    }
  }
  state = defaultState();
  seedDemoData(state);
  saveState();
}

// 損毀內容備份成獨立 key；同一段損毀內容重複偵測到時（例如使用者反覆重新整理，
// 但一直沒有採取行動救回或覆蓋），不重複建立新的備份 key，避免 localStorage
// 被無限累積的備份 key 塞滿——這是「不會形成死循環」要求的具體落地。
function backupCorruptedRawIfNeeded(raw) {
  const existingBackupKeys = Object.keys(localStorage).filter(function (k) { return k.indexOf(STORAGE_KEY + '_corrupted_backup_') === 0; });
  const alreadyBackedUp = existingBackupKeys.some(function (k) { return localStorage.getItem(k) === raw; });
  if (alreadyBackedUp) return;
  try { localStorage.setItem(STORAGE_KEY + '_corrupted_backup_' + Date.now(), raw); } catch (e) { /* 空間也滿了，放棄備份損毀內容，但仍然要告知使用者 */ }
}

// Blocking 3（技術長複審修正）：回傳 true/false，讓呼叫端（尤其是 Restore 流程）
// 能明確知道這次寫入到底有沒有真的成功，不能假設「呼叫了就一定成功」。
// 既有呼叫點都沒有讀回傳值，這是純增量、不影響既有行為。
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
  catch (e) { showToast('保存失敗，可能是這台裝置空間不足'); return false; }
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
// 夾在有效範圍內：Flow 的步驟數如果之後被縮短（例如這輪把歌曲 Flow 從 7 步收斂成 4 步），
// 既有工作停留的 currentStepIndex 可能會超出新的陣列長度，直接回傳 undefined 會讓所有呼叫端
// （renderWorkDetail／renderHome／createFinalProduct…）都爆炸，夾住範圍讓舊資料至少能繼續顯示
function currentStep(work) {
  const steps = FLOWS[work.flowId].steps;
  return steps[Math.min(work.currentStepIndex, steps.length - 1)];
}

// Phase 1A 共用能力收斂：同一個「是否完成」判斷式原本在 4 個地方各自重複
// （satisfactionGood／製作歌曲存檔／製作影片存檔／完成海報存檔），語意一致但各自維護，
// 收斂成單一函式，之後任何一個 Flow 的完成判斷邏輯要改，只用改這裡一處。
function isWorkComplete(work, stepIdx) {
  return stepIdx + 1 >= FLOWS[work.flowId].steps.length;
}

let selectedVideoType = null;

// ── 前置協作與流程防呆（Official Flow Sprint，2026-07-14）─────────────
// 這輪先只在四個試點 Flow 套用：歌曲創作、行銷海報、電子書、影片創作。驗證過可重複套用後，
// 才依 CEO 指示套用到其他 Official Flow，這輪不主動擴大範圍。
// 商品行銷工作區重整（同一天，緊接著的子工作）：「海報」子流程正式拆出來後（見 FLOWS.poster），
// 試點鍵值從 'product' 改成 'poster'——欄位內容不變，只是現在真的有一個對應的獨立 Flow。
const PILOT_BRIEF_FLOWS = ['song', 'poster', 'ebook', 'video'];

// 「直接開始」模式的最少必要欄位，同時也是「先一起討論」模式裡提示 AI 要蒐集哪些資訊的清單
// ——兩個模式共用同一份問題清單，不用維護兩份重複的內容。
const DIRECT_START_FIELDS = {
  song: [
    { key: 'mood', label: '想表達的心情、故事或一句話', required: true },
    { key: 'audience', label: '想寫給誰', required: false },
    { key: 'feeling', label: '希望聽完的感受', required: true }
  ],
  poster: [
    { key: 'purpose', label: '商品／活動名稱', required: true },
    { key: 'coreSellingPoint', label: '核心賣點或內容（這個商品/活動是什麼、有什麼特別）', required: true },
    { key: 'audience', label: '想給誰看', required: true },
    { key: 'price', label: '價格／費用（沒有可留空，AI 不會幫你亂編）', required: false },
    { key: 'datetimeLocation', label: '日期、時間、地點（若適用，沒有可留空）', required: false },
    { key: 'promotion', label: '優惠或贈品（沒有可留空）', required: false },
    { key: 'cta', label: '行動方式（報名連結、聯絡方式或購買網址，沒有可留空）', required: false },
    { key: 'existing', label: '品牌風格或已有素材（已有品牌資料、照片、Logo 等）', required: false }
  ],
  ebook: [
    { key: 'topic', label: '想寫什麼', required: true },
    { key: 'audience', label: '寫給誰', required: true },
    { key: 'takeaway', label: '希望讀者得到什麼', required: true },
    { key: 'existing', label: '已有素材', required: false }
  ],
  video: [
    { key: 'message', label: '想傳達什麼', required: true },
    { key: 'audience', label: '觀看對象', required: true },
    { key: 'length', label: '預計長度', required: true },
    { key: 'existing', label: '已有文字、圖片或歌曲', required: false }
  ]
};

// 「先一起討論」模式，AI 依工作切換的角色（前置討論固定任務只負責收斂方向，不長篇上課）
const DISCUSS_ROLE_BY_FLOW = { song: '音樂製作人', poster: '美術總監', ebook: '出版總編輯', video: '導演' };

// 只有試點 Flow、還沒有 Brief、也還沒有任何步驟成果的「全新工作」才會看到這個選擇畫面——
// 已經在進行中的既有工作不會被追加這個畫面，避免打斷正在做的事。
function shouldShowBriefChoice(work) {
  if (PILOT_BRIEF_FLOWS.indexOf(work.flowId) === -1) return false;
  if (work.brief) return false;
  if (work.briefDiscussing) return false;
  const hasAnyResult = work.stepResultIds && work.stepResultIds.some(Boolean);
  if (hasAnyResult) return false;
  return true;
}

function renderBriefChoice() {
  const work = getActiveWork();
  document.getElementById('bc-flow-name').textContent = FLOWS[work.flowId].name;
}

function chooseDirectStart() { showScreen('screen-brief-direct-form'); }

// pendingDirectFormAnswers 在「填表單」與「資料確認」兩個畫面之間暫存答案，確認前都不寫入 work.brief，
// 讓使用者按「返回修改」時，表單能帶回剛剛填過的內容，不用重打一次（對應 CEO 第六節：資料未確認前不直接產生成果）。
let pendingDirectFormAnswers = [];

function renderBriefDirectForm() {
  const work = getActiveWork();
  const fields = DIRECT_START_FIELDS[work.flowId] || [];
  document.getElementById('bdf-fields').innerHTML = fields.map(function (f, i) {
    const prev = pendingDirectFormAnswers[i] ? escHtml(pendingDirectFormAnswers[i].value) : '';
    return '<div class="field"><label>' + escHtml(f.label) + (f.required ? '' : '（選填）') + '</label>' +
      '<textarea id="bdf-field-' + i + '" maxlength="300" style="min-height:70px">' + prev + '</textarea></div>';
  }).join('');
}

function confirmBriefDirectForm() {
  const work = getActiveWork();
  const fields = DIRECT_START_FIELDS[work.flowId] || [];
  const answers = fields.map(function (f, i) {
    return { field: f, value: (document.getElementById('bdf-field-' + i).value || '').trim() };
  });
  const missing = answers.filter(function (a) { return a.field.required && !a.value; });
  if (missing.length > 0) { showToast('請先填寫：' + missing.map(function (a) { return a.field.label; }).join('、')); return; }

  pendingDirectFormAnswers = answers;
  showScreen('screen-brief-direct-confirm');
}

function renderBriefDirectConfirm() {
  document.getElementById('bdc-summary').innerHTML = pendingDirectFormAnswers.map(function (a) {
    return '<div class="line" style="margin-bottom:8px"><b>' + escHtml(a.field.label) + '</b><br>' +
      (a.value ? escHtml(a.value) : '<span style="opacity:0.5">（未填寫，AI 需要時會再詢問，不會自己編）</span>') + '</div>';
  }).join('');
}

function backToBriefDirectForm() { showScreen('screen-brief-direct-form'); }

function confirmBriefDirectFinal() {
  const work = getActiveWork();
  work.brief = pendingDirectFormAnswers.map(function (a) { return a.field.label + '：\n' + (a.value || '（無）'); }).join('\n\n');
  work.entryMode = 'direct';
  saveState();
  pendingDirectFormAnswers = [];
  showToast('已記錄，開始第一步。');
  showScreen('screen-work-detail');
}

function chooseDiscussMode() {
  const work = getActiveWork();
  work.briefDiscussing = true;
  work.entryMode = 'discuss';
  saveState();
  showScreen('screen-copy-to-ai');
}

// 「先一起討論」的指令：跟其他步驟一樣是自成一段的完整指令，不透過指令母模中心（那套系統是
// 依「角色＋步驟」比對的 8 個 Official 角色，前置討論的角色會依 Flow 換人，不是固定角色，
// 直接寫成獨立函式最簡單，不用為了這一個用途擴充模板比對邏輯）。
function buildBriefDiscussionPrompt(work) {
  const project = getProject(work.projectId);
  const flow = FLOWS[work.flowId];
  const role = DISCUSS_ROLE_BY_FLOW[work.flowId] || '顧問';
  const fields = DIRECT_START_FIELDS[work.flowId] || [];
  const fieldList = fields.map(function (f) { return '・' + f.label; }).join('\n');

  return '# 前置討論\n\n' +
    '## 專案\n' + (project ? project.name : '') + '\n\n' +
    '## 工作\n' + work.name + '\n\n' +
    '## 使用流程\n' + flow.name + '\n\n' +
    '## 你的角色\n請你先扮演「' + role + '」，協助使用者把這次工作的方向想清楚，再開始正式製作。\n\n' +
    '## 前置討論固定任務（請依序完成）\n' +
    '1. 理解使用者想完成什麼。\n' +
    '2. 找出目前缺少的關鍵資訊，特別是以下幾點：\n' + fieldList + '\n' +
    '3. 用簡單問題引導使用者補充，避免一次丟出大量問題，一次最多問 1 至 3 題。\n' +
    '4. 根據回答整理出明確方向。\n' +
    '5. 給出一份可以直接使用的工作 Brief（格式見下方）。\n\n' +
    '## 重要原則\n這是有目標的資訊蒐集與方向收斂，不是自由聊天。角色只協助收斂方向，不可以長篇上課或講解知識。\n\n' +
    '## Brief 完成後，請輸出以下完整結論（不得只說「已了解」「可以開始了」「接下來建議」「方向很好」這類話），' +
    // Prompt 2.0 Blocking Fix（技術長 Approve after Fix，2026-07-31）：不再要求 AI 在 Brief
    // 最後加上「請貼回工作台」這句提醒——工作台自己的貼回畫面已經會顯示「現在請：把 AI
    // 最後輸出的『本次工作 Brief』完整貼回來」，不需要 AI 自己再重複一次。
    '輸出完 Brief 內容本身就結束，不要額外加上任何提醒文字或操作說明：\n\n' +
    '【本次工作 Brief】\n\n' +
    '工作目標：\n＿＿＿＿＿＿\n\n' +
    '目標對象：\n＿＿＿＿＿＿\n\n' +
    '核心內容：\n＿＿＿＿＿＿\n\n' +
    '希望呈現的感受／風格：\n＿＿＿＿＿＿\n\n' +
    '必須保留：\n＿＿＿＿＿＿\n\n' +
    '應避免：\n＿＿＿＿＿＿\n\n' +
    '本次預計完成的成果：\n＿＿＿＿＿＿';
}

// Brief 討論稿沿用既有的「滿意度／版本歷程」機制（satisfactionGood／satisfactionRevise／
// satisfactionLater／screen-revise-direction 全部原封不動重用），不是重新做一套平行的
// 草稿狀態機——Brief 討論稿是 state.results 裡一筆特殊記錄（isBriefDraft:true、stepIndex:-1，
// 不放進 work.stepResultIds／work.stepVersions，不會被算成任何一個 Flow 步驟的正式成果），
// 用獨立的 work.briefVersions 記錄版本歷程，避免污染真正步驟的版本序號。
function makeBriefResult(s, work, project, content) {
  if (!work.briefVersions) work.briefVersions = [];
  const version = work.briefVersions.length + 1;
  const step = currentStep(work);
  const r = {
    id: s.nextResultId++,
    title: work.name + '｜前置討論 Brief',
    projectId: project.id, projectName: project.name,
    workId: work.id, workName: work.name,
    flowId: work.flowId, flowName: FLOWS[work.flowId].name,
    stepName: '前置討論 Brief', role: DISCUSS_ROLE_BY_FLOW[work.flowId] || '顧問', stepIndex: -1,
    ai: suggestedToolForStep(work.flowId, step.role, step.name).name,
    content: content, category: step.category,
    completedAt: new Date().toISOString(), isFinal: false,
    version: version, satisfaction: '很滿意',
    cloudStatus: 'none', isBriefDraft: true
  };
  s.results.push(r);
  work.briefVersions.push(r.id);
  return r;
}

// ── 商品行銷工作區重整（第一個子工作，2026-07-14）───────────────────
// 「商品行銷」不是一條包辦所有事情的大流程，而是一組以明確成果分類的工作入口——
// 這輪只做出「行銷海報」一個真正能走完的子流程（CEO 明確表示想先真人測試這一個），
// 其餘子分類先列出來讓你看到完整的分類設計，但先標示「即將推出」，不接可用的 Flow，
// 避免顯示打不開的假入口。之後每完成一個子工作，正式通到這裡就好，不用大改這個畫面。
const PRODUCT_CATEGORIES = [
  { emoji: '🎯', label: '商品定位', desc: '完成商品賣點與目標客群的定位方向', flowId: null },
  { emoji: '📝', label: '商品介紹文案', desc: '完成一份可以直接使用的商品介紹', flowId: null },
  { emoji: '🖼️', label: '行銷海報', desc: '完成一張可以直接分享的商品海報', flowId: 'poster' },
  { emoji: '📱', label: '社群貼文', desc: '完成一則可以直接發布的社群貼文', flowId: null },
  { emoji: '🎨', label: '商品視覺素材', desc: '完成商品主圖／Banner 等視覺素材', flowId: null },
  { emoji: '📣', label: '行銷活動規劃', desc: '完成一份行銷活動執行方案', flowId: null }
];

function renderProductCategory() {
  document.getElementById('pc-category-grid').innerHTML = PRODUCT_CATEGORIES.map(function (c) {
    if (c.flowId) {
      return '<div class="pick-card" onclick="chooseProductCategory(\'' + c.flowId + '\')">' +
        '<div class="emoji">' + c.emoji + '</div><div class="label">' + escHtml(c.label) + '</div>' +
        '<div class="option-sub" style="margin-top:4px">' + escHtml(c.desc) + '</div></div>';
    }
    return '<div class="pick-card" style="opacity:0.45;cursor:default" onclick="showToast(\'即將推出，敬請期待\')">' +
      '<div class="emoji">' + c.emoji + '</div><div class="label">' + escHtml(c.label) + '</div>' +
      '<div class="option-sub" style="margin-top:4px">即將推出</div></div>';
  }).join('');
}

function chooseProductCategory(flowId) {
  pendingFlowId = flowId;
  selectedVideoType = null;
  showScreen('screen-add-work');
}

function openAddWork() {
  const project = getActiveProject();
  // 商品行銷專案先進分類選擇畫面，其他專案類型維持原本行為不變
  if (project.type === 'product') { showScreen('screen-product-category'); return; }
  pendingFlowId = PROJECT_TYPES[project.type] ? PROJECT_TYPES[project.type].flowId : 'custom';
  selectedVideoType = null;
  showScreen('screen-add-work');
}

function chooseFlow(flowId) {
  pendingFlowId = flowId;
  selectedVideoType = null;
  render();
}

function chooseVideoType(id) {
  selectedVideoType = id;
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
  if (pendingFlowId === 'video' && selectedVideoType) work.videoType = selectedVideoType;
  if (pendingFlowId === 'song') {
    const songIdeaInput = document.getElementById('new-work-song-idea-input');
    const songIdea = (songIdeaInput.value || '').trim();
    if (songIdea) work.songIdea = songIdea;
    songIdeaInput.value = '';
  }
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
  if (work && work.briefDiscussing) { showScreen('screen-copy-to-ai'); return; }
  if (work && shouldShowBriefChoice(work)) { showScreen('screen-brief-choice'); return; }
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
// Phase 1A（乾淨生成指令＋Context Pack 獨立複製，見全域契約「乾淨指令」四區塊原則）：
// 「複製給 AI」維持不變（複製 Context Pack + 乾淨指令的完整組合，這是既有主要路徑，不動預設行為）；
// 這兩個是新增的獨立複製選項，給想只帶脈絡去新對話、或想單獨拿指令貼進其他工具的使用者。
function copyContextPackOnly() {
  const work = getActiveWork();
  copyPlainText(buildContextPack(work.id), '已複製 Context Pack，可以貼給任何 AI 接手這件工作');
}
function copyCleanInstructionOnly() {
  const work = getActiveWork();
  copyPlainText(buildCleanInstructionText(work.id), '已複製乾淨指令，可以直接貼上使用');
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); showToast('已複製！'); } catch (e) { showToast('複製失敗，請手動選取文字複製'); }
  document.body.removeChild(ta);
}

// ── 貼回成果 ──────────────────────────────────────────────────
// A/B 未選定成果防呆：只在按下保存的當下檢查一次（不是每個字都跳提示），最小文字偵測，
// 不呼叫 AI、不做語意分析。單一詞彙（例如作品裡剛好出現「版本 A」）不算數，
// 必須同時命中至少兩項特徵，才判定「使用者可能還在 AI 那邊選版本，還沒貼最終內容回來」，
// 避免正常成果（只選了一版、歌詞裡剛好有 A/B 字母、單獨提到「重新產生」）被誤擋。
// Hotfix：原本用「命中幾種正則」計分，會讓同一個語意（例如「Version A」跟「○ Version A」都只是在講 A）
// 被算成兩個獨立訊號，造成誤判。改成四個語意群組，只有「同時有 A 又有 B，而且看起來像在問要選哪個
// 或可以重新產生」才算數——單純同時提到 A 跟 B（例如比較兩個版本的正式文章）不會被擋。
function looksLikeUnselectedABResult(text) {
  if (!text) return false;
  const hasVersionA = /version\s*a\b|版本\s*a\b|○\s*(?:version\s*)?a\b/i.test(text);
  const hasVersionB = /version\s*b\b|版本\s*b\b|○\s*(?:version\s*)?b\b/i.test(text);
  const hasChoicePrompt = /請選(?:擇|一個)[^\n]{0,10}(?:最喜歡|喜歡)[^\n]{0,10}版本/.test(text) ||
    /請直接回覆[:：][^\n]{0,10}a[^\n]{0,6}或[^\n]{0,6}b/i.test(text);
  const hasRegenerateOption = /重新產生/.test(text);
  return hasVersionA && hasVersionB && (hasChoicePrompt || hasRegenerateOption);
}

// Prompt 2.0（Official Flow Prompt Review Report，成果純淨性）：幾乎所有創作型模板
// （A/B 打磨模式與 video 主題／腳本／配音與字幕）都要求 AI 在完整成果最後另起一行加上
// 「📋 請複製……，貼回 AI 工作台。」方便使用者知道貼完了——但這行文字本身是操作提醒，
// 不是正式成果的一部分。使用者複製 AI「完整」回覆貼回來時，這一行會逐字跟著貼進來，
// 之前沒有任何地方剝離它，導致它被存進正式成果、又被 buildPreviousResults() 塞進後面
// 每一步的「前面累積成果」，造成污染。這裡只找「內容最後一個非空白行」是否為這類提醒
// （📋＋貼回＋工作台三個關鍵字都要同時出現），只在最後一行才動手，不會誤刪內容中段
// 剛好提到這幾個字的正常文字。找不到就原樣返回，不強行改動內容。
function stripCopyBackReminderLine(content) {
  if (!content) return content;
  const trimmed = content.replace(/\s+$/, '');
  const lastNewlineIdx = trimmed.lastIndexOf('\n');
  const lastLine = lastNewlineIdx === -1 ? trimmed : trimmed.slice(lastNewlineIdx + 1);
  if (/📋/.test(lastLine) && /貼回/.test(lastLine) && /工作台/.test(lastLine)) {
    return (lastNewlineIdx === -1 ? '' : trimmed.slice(0, lastNewlineIdx)).replace(/\s+$/, '');
  }
  return content;
}

// 歌名＋歌詞格式檢查（Mission：歌曲 Flow「歌名＋歌詞」一體化，2026-07-13）——嚴格版，
// 只給「使用者要保存這一步的正式成果」這個時機用：必須同時看到有內容的【歌名】跟【歌詞】兩個區塊，
// 少一個都要擋下來，訊息依照缺哪一個給不同提醒，不會自動用工作名稱補歌名。
function validateSongTitleLyricsPaste(text) {
  const titleMatch = text.match(/【歌名】\s*\n?([\s\S]*?)(?=【歌詞】|$)/);
  const lyricsMatch = text.match(/【歌詞】\s*\n?([\s\S]*)/);
  const hasTitle = titleMatch && titleMatch[1].trim().length > 0;
  const hasLyrics = lyricsMatch && lyricsMatch[1].trim().length > 0;
  if (!hasTitle) return { valid: false, message: '這份內容還沒有正式歌名。請先回到 AI 選定歌名，再將「歌名＋完整歌詞」一起貼回來。' };
  if (!hasLyrics) return { valid: false, message: '這份內容還沒有完整歌詞。請將 AI 最後輸出的「歌名＋完整歌詞」一起貼回來。' };
  return { valid: true, title: titleMatch[1].trim().replace(/^《|》$/g, '').trim() };
}

// Prompt 2.0（完成條件 Tier 2／輕量檢查）：poster「視覺設計」模板固定要求輸出
// 【圖片生成請求】＋【風格建議】兩個區塊，這裡只確認兩個區塊都存在且非空，不像 video
// 逐幕解析那樣深入解析內容結構——這一步不需要程式後續解析每個欄位，只要保證使用者不會
// 把還在討論、缺區塊的內容誤存成正式成果即可，符合 Tier 2「有清楚固定格式、但下游不需要
// 程式解析」的分級原則，不是每一步都要做到 video 那種 Tier 1 強制 Gate。
function validatePosterVisualDesignPaste(text) {
  if (!/【圖片生成請求】/.test(text)) return { valid: false, message: '這份內容還沒有看到「【圖片生成請求】」這個區塊。請確認格式並重新貼回。' };
  if (!/【風格建議】/.test(text)) return { valid: false, message: '這份內容還沒有看到「【風格建議】」這個區塊。請確認格式並重新貼回。' };
  const reqMatch = text.match(/【圖片生成請求】\s*\n?([\s\S]*?)(?=【風格建議】|$)/);
  if (!reqMatch || !reqMatch[1].trim()) return { valid: false, message: '「【圖片生成請求】」目前是空的。請確認內容完整後重新貼回。' };
  return { valid: true };
}

// 寬鬆版：給「顯示已經保存的資料」用（例如製作歌曲畫面要把歌詞複製到 Suno），
// 舊資料（這輪之前保存、沒有【歌名】【歌詞】標記的歌詞）優雅降級——整段內容當作歌詞，歌名留空，
// 不報錯、不阻擋，跟 Creative Preferences 當初「舊資料沒有欄位時直接用預設值」同一套防呆哲學。
function parseSongTitleAndLyrics(content) {
  if (!content) return { title: '', lyrics: '' };
  const titleMatch = content.match(/【歌名】\s*\n?([\s\S]*?)(?=【歌詞】|$)/);
  const lyricsMatch = content.match(/【歌詞】\s*\n?([\s\S]*)/);
  const hasTitle = titleMatch && titleMatch[1].trim().length > 0;
  const hasLyrics = lyricsMatch && lyricsMatch[1].trim().length > 0;
  if (!hasLyrics) return { title: hasTitle ? titleMatch[1].trim().replace(/^《|》$/g, '').trim() : '', lyrics: content.trim() };
  return { title: hasTitle ? titleMatch[1].trim().replace(/^《|》$/g, '').trim() : '', lyrics: lyricsMatch[1].trim() };
}

function showPasteBackWarning(html) {
  document.getElementById('pb-warning-text').innerHTML = html;
  document.getElementById('pb-ab-warning').style.display = 'block';
}
const AB_UNSELECTED_WARNING_HTML = '<b>這看起來還是 AI 提供的兩個版本。</b><br>請先回到 AI，選擇 A 或 B，等 AI 輸出完整最終版本後，再貼回這裡。';

function goPasteBack() { showScreen('screen-paste-back'); }
function submitPasteBack() {
  const work = getActiveWork();
  const project = getProject(work.projectId);
  const step = currentStep(work);
  const textarea = document.getElementById('paste-back-textarea');
  // Prompt 2.0（成果純淨性）：先剝離「📋 請複製…貼回工作台」這類操作提醒行，再進行任何
  // 後續判斷／解析——這樣 video 的逐幕解析、song 的歌名歌詞檢查，都不會被這行文字污染到
  // 最後一個欄位，最終存進正式成果的內容也一律是乾淨的，適用所有 Flow，不是只有 video。
  const content = stripCopyBackReminderLine((textarea.value || '').trim());
  if (!content) { showToast('請先貼上 AI 給你的內容'); return; }

  if (looksLikeUnselectedABResult(content)) {
    showPasteBackWarning(AB_UNSELECTED_WARNING_HTML);
    return;
  }

  if (work.briefDiscussing) {
    const briefResult = makeBriefResult(state, work, project, content);
    textarea.value = '';
    saveState();
    lastSubmittedResultId = briefResult.id;
    showScreen('screen-satisfaction');
    return;
  }

  let parsedSongTitle = null;
  if (work.flowId === 'song' && step.name === '歌名＋歌詞') {
    const validation = validateSongTitleLyricsPaste(content);
    if (!validation.valid) {
      showPasteBackWarning(escHtml(validation.message));
      return;
    }
    parsedSongTitle = validation.title;
  }

  // Prompt 2.0（完成條件 Tier 2）：poster「視覺設計」固定要求輸出兩個區塊，這裡只做
  // 輕量存在檢查，不像 video 逐幕解析那樣深入——詳見 validatePosterVisualDesignPaste()。
  if (work.flowId === 'poster' && step.name === '視覺設計') {
    const validation = validatePosterVisualDesignPaste(content);
    if (!validation.valid) {
      showPasteBackWarning(escHtml(validation.message));
      return;
    }
  }

  // Video Workflow vNext（CEO 核准的最終校準）：「腳本」步驟的貼回內容必須先驗證能不能
  // 解析成合法的逐幕 Master Script，才可以：①指向正式 stepResultId ②同步 work.masterScript
  // ③建立 Style Anchor 快照 ④標記完成 ⑤允許進入下一步。解析失敗時，內容仍然保存下來
  // （避免使用者的輸入遺失），但不指向正式成果、不推進步驟、不動先前合法的 work.masterScript，
  // 不允許下游用無效版本繼續——這是 CEO 明確要求「不得發生正式 Result 指向新無效內容，
  // 但 work.masterScript 仍指向上一個合法版本」的直接落實。
  if (work.flowId === 'video' && step.name === '腳本') {
    // allowLenient=true：這裡是使用者「主動重新貼回」的當下，是唯一允許寬鬆解析生效的
    // 時機（CEO 產品決策，寬鬆解析生效範圍採方案 B）。
    const parsed = parseMasterScript(content, true);
    if (!parsed.valid) {
      saveUnconfirmedVideoDraft(work, project, step, content, 'isMasterScriptDraft');
      showPasteBackWarning(escHtml('內容已保留，但尚未成功建立逐幕影片母稿。請確認格式並重新貼回，完成後才能進入下一步。'));
      return;
    }
  }
  // 「配音與字幕」步驟同樣的道理：必須逐幕對應到目前的 Master Script，且不得改寫旁白內容
  // 本身（Prompt 已要求 AI 只能調整成口白／字幕格式，這裡只驗證格式與幕數是否完整對應）。
  if (work.flowId === 'video' && step.name === '配音與字幕') {
    const ms = getMasterScript(work);
    const parsed = ms ? parseVoiceoverAndSubtitles(content, ms) : { valid: false };
    if (!parsed.valid) {
      saveUnconfirmedVideoDraft(work, project, step, content, 'isVoiceoverDraft');
      showPasteBackWarning(escHtml('內容已保留，但尚未成功建立逐幕配音與字幕。請確認格式並重新貼回，完成後才能進入下一步。'));
      return;
    }
  }

  const r = makeResult(state, work, project, work.currentStepIndex, content, false);
  work.stepResultIds[work.currentStepIndex] = r.id;
  if (parsedSongTitle) work.songTitle = parsedSongTitle;
  if (work.flowId === 'video' && step.name === '腳本') syncMasterScriptFromResult(work, r, true);
  if (work.flowId === 'video' && step.name === '配音與字幕' && work.masterScript) {
    r.masterScriptResultId = work.masterScript.sourceResultId;
    syncVoiceoverFromResult(work, r);
  }
  textarea.value = '';
  saveState();

  lastSubmittedResultId = r.id;
  showScreen('screen-satisfaction');
}

// 貼回內容格式不符時，仍保存為未確認草稿（不遺失使用者輸入），但刻意不呼叫 makeResult()
// （不進 work.stepVersions 版本歷程、不動 work.stepResultIds），避免草稿被任何既有機制
// 誤認成正式版本。flagKey 是 'isMasterScriptDraft' 或 'isVoiceoverDraft'，跟既有的
// isBriefDraft 是同一種「草稿標記」慣例，成果庫／相關成果等既有清單只要延伸同一種
// 排除寫法（!r.isBriefDraft）就能一併排除，不需要另外新增判斷邏輯。
function saveUnconfirmedVideoDraft(work, project, step, content, flagKey) {
  const draft = {
    id: state.nextResultId++,
    title: work.name + '｜' + step.name + '（格式待確認）',
    projectId: project.id, projectName: project.name,
    workId: work.id, workName: work.name,
    flowId: work.flowId, flowName: FLOWS[work.flowId].name,
    stepName: step.name, role: step.role, stepIndex: work.currentStepIndex,
    ai: suggestedToolForStep(work.flowId, step.role, step.name).name,
    content: content, category: step.category,
    completedAt: new Date().toISOString(), isFinal: false,
    version: 0, satisfaction: null, cloudStatus: 'none'
  };
  draft[flagKey] = true;
  state.results.push(draft);
  saveState();
  return draft;
}
function pasteBackGoChooseVersion() {
  document.getElementById('pb-ab-warning').style.display = 'none';
  showScreen('screen-copy-to-ai');
}
function pasteBackDismissAbWarning() {
  document.getElementById('pb-ab-warning').style.display = 'none';
}

// ── 作品打磨（滿意度 → 修改方向 → 修正指令 → 貼回修改版 → 版本歷程）──
let lastSubmittedResultId = null;
let selectedDirections = [];

function satisfactionGood() {
  const r = getResult(lastSubmittedResultId);
  r.satisfaction = '很滿意';
  saveState();

  const work = getActiveWork();
  if (r.isBriefDraft) {
    work.brief = r.content;
    work.briefDiscussing = false;
    saveState();
    showToast('Brief 已確認，開始第一步。');
    showScreen('screen-work-detail');
    return;
  }

  const project = getProject(work.projectId);
  if (isWorkComplete(work, work.currentStepIndex)) {
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
  regenerateDirectionsOverride = null;
  showScreen('screen-revise-direction');
}

// Official Flow 共通規則（Flow Engine，非 Prompt）：本步驟完成確認的第三個選項。
// 這個結果已經在 submitPasteBack() 保存成這一步的正式成果了，「稍後再繼續」不需要
// 額外處理資料，只是不推進 currentStepIndex，讓使用者先離開，之後回到這個工作
// 還是看到同一步，不強迫馬上決定要繼續還是修改。
function satisfactionLater() {
  const r = getResult(lastSubmittedResultId);
  r.satisfaction = '稍後再繼續';
  saveState();
  showToast('已保存，這一步先留著，之後回來可以繼續。');
  showScreen('screen-work-detail');
}

// ── 製作歌曲（歌曲 Production Flow MVP）──────────────────────
// 「製作歌曲」是歌曲創作流程專屬步驟：Suno 生成的是歌曲檔案，不是文字回答，
// 不能沿用「交給AI → 貼回成果 → 滿意度」的通用路徑，改成
// 「複製歌詞／音樂風格分別貼到 Suno → 歌曲完成確認 → 保存這首歌 → 接下來想做什麼」，
// 且完成後不強迫線性推進，讓使用者自己決定要先做封面、做 MV，還是先到這裡就好。
let lastMakeSongLyrics = '';
let lastMakeSongStyle = '';

function copyPlainText(text, message) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast(message); }).catch(function () { fallbackCopy(text); });
  } else { fallbackCopy(text); }
}
function copyMakeSongLyrics() { copyPlainText(lastMakeSongLyrics, '已複製歌詞，貼到 Lyrics 吧'); }
function copyMakeSongStyle() { copyPlainText(lastMakeSongStyle, '已複製音樂風格，貼到 Style of Music 吧'); }

// ── 工具使用流程引導（Song Tool Guide MVP，2026-07-13）─────────────
// Mission：第一次使用者不該只拿到 Prompt，還要有「怎麼真正把它變成作品」的完整操作引導
// （工具介紹＋固定製作流程＋第一次使用提醒＋一鍵開啟工具），符合 People First／Deliverable First。
// renderToolGuide() 是純 UI 版型，不碰 Prompt／Flow／資料結構，之後影片（Kling/Runway/Veo）、
// 圖片（ChatGPT Images/Midjourney）、網站（Claude Code/Codex）等 Flow 都可以呼叫同一個函式、
// 換一份 config 就能沿用同樣的引導體驗——這輪只接歌曲的 Suno，不提前做其他 Flow。
// 目前唯一已驗證的音樂生成工具，Udio 等替代方案團隊尚未實測，依全域契約「Tool Profile」
// 原則（docs/workspace-global-contracts.md）不列入未驗證工具，避免宣稱未查證的能力或限制。
const SONG_TOOL_GUIDE = {
  toolName: 'Suno',
  rating: 5,
  fitFor: '第一次製作 AI 歌曲、想快速聽到成品',
  toolIntro: '適合第一次製作 AI 歌曲。',
  toolFeatures: ['AI 自動作曲', 'AI 演唱', '支援中文', '新手容易上手'],
  steps: ['複製歌詞', '開啟 Suno', '貼上歌詞（Lyrics）', '貼上音樂風格（Style）', '產生歌曲', '滿意後，先在 Suno 下載歌曲或複製分享連結，再回到工作台按「完成了」'],
  // 完成提醒（2026-07-13 補強）：不保證所有帳號都能下載特定格式，不寫死 WAV／MP3 這類容易過期的格式名稱，
  // 不新增上傳音訊／貼連結／雲端保存功能，也不把下載／分享拆成新的 Flow 步驟——純粹是這一步的文字提醒。
  completionReminder: {
    title: '完成後記得保存',
    items: [
      '想保留在手機或電腦：在 Suno 下載歌曲檔案。',
      '想傳給朋友或分享到社群：複製歌曲分享連結。',
      '完成後回到 AI 工作台，按「完成了」。'
    ]
  },
  firstTimeReminder: '第一次使用不用擔心。跟著上面的流程，大約幾分鐘就可以完成第一首歌曲。',
  extraTip: '💡 小提醒：第一次可以先設定約 1 分鐘的長度，比較容易完成第一首作品。',
  openToolLabel: '🎵 開啟 Suno',
  openToolUrl: 'https://suno.com'
};
const STEP_NUMERALS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
// CEO 回饋：工具推薦要加星等，初學者才不用猜。1-5 星，超出範圍夾在 1-5 之間，避免資料填錯時整排壞掉。
function starString(rating) {
  const n = Math.max(1, Math.min(5, Math.round(rating)));
  return '⭐'.repeat(n);
}
// Phase 1B（Official Recommendation Center）：主要建議一律標「⭐ 名稱（官方建議）」，不是
// 「預設推薦」或「唯一最佳」——使用者永遠可以在下面的替代工具或「我的工具」自由更換，
// 這裡的星等是額外的品質快速判斷，跟「⭐」這個官方建議徽章是兩件事，不要混在一起看。
// config.noOfficialRecommendation 為真時（Center 目前沒有這一步的資料），顯示固定的誠實文案，
// 不強行湊一個看起來像推薦的內容出來。
function renderToolGuide(containerId, buttonId, config) {
  const box = document.getElementById(containerId);
  if (config.noOfficialRecommendation) {
    box.innerHTML =
      '<div class="card">' +
        '<div class="section-label">' + escHtml(config.toolSectionLabel || '🛠️ 建議工具') + '</div>' +
        '<div class="notice">' + escHtml(config.noRecommendationMessage || NO_OFFICIAL_RECOMMENDATION_MESSAGE) + '</div>' +
      '</div>';
    const fallbackBtn = document.getElementById(buttonId);
    if (fallbackBtn) { fallbackBtn.style.display = 'none'; }
    return;
  }
  box.innerHTML =
    '<div class="card">' +
      '<div class="section-label">' + escHtml(config.toolSectionLabel || '🎵 建議工具') + '</div>' +
      '<h3 style="font-size:17px;margin-bottom:4px">⭐ ' + escHtml(config.toolName) + '（官方建議）' + (config.rating ? '　' + starString(config.rating) : '') + '</h3>' +
      (config.positioning ? '<div class="line" style="color:var(--gold)">' + escHtml(config.positioning) + '</div>' : '') +
      (config.fitFor ? '<div class="line" style="color:var(--gold)">適合：' + escHtml(config.fitFor) + '</div>' : '') +
      '<div class="line">' + escHtml(config.toolIntro) + '</div>' +
      '<div class="line" style="margin-top:6px">特色：</div>' +
      config.toolFeatures.map(function (f) { return '<div class="line">・' + escHtml(f) + '</div>'; }).join('') +
      // Correction Proposal Stage E：為什麼推薦／手機操作／費用提醒／注意事項，只在有值時才顯示
      // （既有其他 Flow 的 TOOL_GUIDE 沒有填這些欄位時，畫面完全不受影響）。
      (config.whyRecommended ? '<div class="line" style="margin-top:6px">為什麼推薦：' + escHtml(config.whyRecommended) + '</div>' : '') +
      (config.mobileExperience ? '<div class="line">手機操作：' + escHtml(config.mobileExperience) + '</div>' : '') +
      (config.pricingNote ? '<div class="line">費用提醒：' + escHtml(config.pricingNote) + '</div>' : '') +
      (config.caution ? '<div class="line">注意：' + escHtml(config.caution) + '</div>' : '') +
      (config.altTools && config.altTools.length ?
        '<details class="ai-why" style="margin-top:14px"><summary>查看替代工具（不想用預設工具時可以參考）</summary><div class="ai-why-body">' +
          config.altTools.map(function (t) {
            return '<div class="line" style="margin-top:8px"><b>' + escHtml(t.name) + '</b>' + (t.rating ? '　' + starString(t.rating) : '') +
              (t.positioning ? '<br><span style="color:var(--gold)">' + escHtml(t.positioning) + '</span>' : '') +
              (t.fitFor ? '<br><span style="color:var(--gold)">適合：' + escHtml(t.fitFor) + '</span>' : '') +
              '<br>' + escHtml(t.reason) +
              (t.mobileExperience ? '<br>手機操作：' + escHtml(t.mobileExperience) : '') +
              (t.pricingNote ? '<br>費用提醒：' + escHtml(t.pricingNote) : '') +
              (t.caution ? '<br>注意：' + escHtml(t.caution) : '') +
              '</div>';
          }).join('') +
        '</div></details>' : '') +
    '</div>' +
    '<div class="card">' +
      '<div class="section-label">製作流程</div>' +
      config.steps.map(function (s, i) {
        const arrow = i < config.steps.length - 1 ? '<div class="line" style="text-align:center;color:var(--text-dim)">↓</div>' : '';
        return '<div class="line">' + (STEP_NUMERALS[i] || (i + 1) + '.') + ' ' + escHtml(s) + '</div>' + arrow;
      }).join('') +
    '</div>' +
    (config.completionReminder ?
      '<div class="card">' +
        '<div class="section-label">' + escHtml(config.completionReminder.title) + '</div>' +
        config.completionReminder.items.map(function (item) { return '<div class="line">・' + escHtml(item) + '</div>'; }).join('') +
      '</div>' : '') +
    '<div class="notice">' + escHtml(config.firstTimeReminder) + (config.extraTip ? '<br><br>' + escHtml(config.extraTip) : '') + '</div>';

  const openBtn = document.getElementById(buttonId);
  openBtn.style.display = '';
  openBtn.textContent = config.openToolLabel;
  // Correction Proposal Stage D：網址優先查 tools-catalog.json（config.toolId 是
  // withOfficialRecommendation() 帶進來的「實際被推薦工具的 id」），查不到才退回 config
  // 本身寫的 openToolUrl——保留這個 fallback 是為了讓 renderToolGuide() 繼續能用任意自訂
  // config 呼叫（例如既有測試直接傳一組完全沒有 toolId 的假資料），不因為這次改動而變得
  // 只能被本專案的官方工具清單牽著走。
  openBtn.href = (config.toolId && getToolUrlById(config.toolId)) || config.openToolUrl;
}

// ── 工具使用流程引導（Video Tool Guide MVP，Video Flow Sprint 2）─────
// 沿用 renderToolGuide() 既有版型（Song Tool Guide 已驗證有效），但內容依 Phase B 實際路徑重寫，
// 不是直接複製歌曲版六步文案：跟歌曲「複製文字貼上」不同，這裡的核心動作是「上傳圖片」——
// 圖片本身在 Phase A（screen-make-video）已經請使用者準備好，這裡只提醒要先保存/下載。
// Runway／Pika／Luma 目前已在「其他影片工具」（VIDEO_IMAGE_TOOL_RECOMMENDATIONS／
// getVideoTypeToolRecommendations）以不同 UI 呈現，這裡先不重複整併，避免這輪低風險收斂
// 擴大成兩套機制的合併決策——留待 Phase 2 影片試點時一併評估是否收斂成同一套。
// Correction Proposal Stage E：官方優先推薦依「AI Collaboration Workspace 使用經驗（持續校準）」
// 改成 Gemini（Veo）——不是排行榜或市場聲量。Canva／Kling 隨 collaboration-templates.json
// category:video 的官方推薦鏈一起調整，變成 withOfficialRecommendation() 動態帶入的
// altTools（「查看替代工具」），這裡的固定教學步驟因此改寫成 Gemini 的操作流程；Kling 原本的
// 步驟寫法留作範本沿用（登入→上傳→生成→下載→回工作台），沒有實際逐一核對 Gemini 目前畫面
// 長相寫出來，跟 Suno／Kling 原本的寫法基準一致，工具介面日後改版要留意維護。
// Runway／Pika 依然留在「其他影片工具」（VIDEO_TYPE_TOOL_RECOMMENDATIONS），沒有被這次校準動到。
const VIDEO_TOOL_GUIDE = {
  toolSectionLabel: '🎬 建議工具',
  toolName: 'Gemini',
  rating: 5,
  fitFor: '第一次嘗試圖生影片、想反覆練習整個工作流程',
  toolIntro: '這類工具可以把你準備好的圖片變成有動態感的完整影片。',
  toolFeatures: ['圖生影片，操作步驟清楚', '適合第一次嘗試圖生影片的人', '適合反覆練習整個工作流程', '手機操作方便'],
  steps: [
    '先確認圖片已經下載或保存',
    '開啟 Gemini',
    '上傳要製作成影片的圖片',
    '貼上腳本或畫面描述，當作影片內容的補充說明（非必填）',
    '產生影片並確認效果',
    '滿意後，先在 Gemini 下載影片或複製分享連結',
    '回到工作台，按「下一步：確認影片進度」'
  ],
  completionReminder: {
    title: '完成後記得保存',
    items: [
      '想保留在手機或電腦：在 Gemini 下載影片檔案。',
      '想傳給朋友或分享到社群：複製影片分享連結。',
      '完成後回到工作台，按「下一步：確認影片進度」。'
    ]
  },
  firstTimeReminder: '第一次使用不用擔心。先選一張圖片試做，照著步驟完成第一小段影片即可。',
  openToolLabel: '🎬 開啟 Gemini',
  openToolUrl: 'https://gemini.google.com'
};

function renderMakeSong() {
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];
  const lyricsIdx = flow.steps.findIndex(function (s) { return s.name === '歌名＋歌詞'; });
  const styleIdx = flow.steps.findIndex(function (s) { return s.name === '音樂風格'; });
  const lyricsResult = state.results.find(function (r) { return r.id === work.stepResultIds[lyricsIdx]; });
  const styleResult = state.results.find(function (r) { return r.id === work.stepResultIds[styleIdx]; });
  // 「歌名＋歌詞」步驟保存的完整內容是【歌名】+【歌詞】兩個區塊，複製給 Suno 的 Lyrics 欄位
  // 只需要純歌詞，不要連歌名標記一起貼過去；舊資料（沒有標記）優雅降級成整段當歌詞。
  const parsed = parseSongTitleAndLyrics(lyricsResult ? lyricsResult.content : '');
  lastMakeSongLyrics = parsed.lyrics;
  lastMakeSongStyle = styleResult ? styleResult.content : '';
  document.getElementById('ms-song-title').textContent = '🎵 《' + (work.songTitle || work.name) + '》';
  renderToolGuide('ms-tool-guide', 'ms-open-tool-btn', withOfficialRecommendation(TOOL_GUIDES.song, 'song', '工程師', '製作歌曲'));
  document.getElementById('ms-lyrics-content').textContent = lastMakeSongLyrics || '（還沒有歌詞內容）';
  document.getElementById('ms-style-content').textContent = lastMakeSongStyle || '（還沒有音樂風格內容）';
}

function goSongConfirm() { showScreen('screen-song-confirm'); }
// 「我還要重新生成」優先局部修改（比照 poster 這輪的作法），讓使用者選要改歌詞、曲風、唱腔，
// 還是真的整份重來，不要每次都整份重寫。
function songConfirmRegenerate() {
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];
  const lyricsIdx = flow.steps.findIndex(function (s) { return s.name === '歌名＋歌詞'; });
  const styleIdx = flow.steps.findIndex(function (s) { return s.name === '音樂風格'; });
  if (!work.stepResultIds[lyricsIdx] || !work.stepResultIds[styleIdx]) {
    showToast('找不到歌詞或音樂風格內容，請先完成前面步驟'); showScreen('screen-make-song'); return;
  }
  songRegenerateMode = true;
  regenerateDirectionsOverride = ['改歌詞', '改曲風', '改唱腔', '重新生成'];
  selectedDirections = [];
  showScreen('screen-revise-direction');
}
function songConfirmLater() {
  showToast('已保存，之後回來可以繼續。');
  showScreen('screen-work-detail');
}
function songConfirmDone() { showScreen('screen-save-song'); }

let lastSongFileName = '';
function copySongFileName() { copyPlainText(lastSongFileName, '已複製建議檔名'); }

function renderSaveSong() {
  const work = getActiveWork();
  const fallbackName = work.songTitle || work.name;
  document.getElementById('save-song-name-input').value = fallbackName;
  document.getElementById('save-song-url-input').value = '';
  document.getElementById('save-song-note-input').value = '';
  lastSongFileName = buildSuggestedFileName(fallbackName, '歌曲');
  document.getElementById('save-song-filename').textContent = lastSongFileName;
}
function confirmSaveSong() {
  const work = getActiveWork();
  const project = getProject(work.projectId);
  const flow = FLOWS[work.flowId];
  const stepIdx = flow.steps.findIndex(function (s) { return s.name === '製作歌曲'; });
  const fallbackName = work.songTitle || work.name;
  const name = (document.getElementById('save-song-name-input').value || fallbackName).trim() || fallbackName;
  const url = (document.getElementById('save-song-url-input').value || '').trim();
  const note = (document.getElementById('save-song-note-input').value || '').trim();
  const content = '歌曲名稱：' + name + '\nSuno 作品網址：' + (url || '（未填寫）') + '\n備註：' + (note || '（無）');
  lastSongFileName = buildSuggestedFileName(name, '歌曲');

  const r = makeResult(state, work, project, stepIdx, content, false, '很滿意');
  work.stepResultIds[stepIdx] = r.id;
  work.songCompleted = true;
  // 歌曲 Flow 只負責完成「歌曲」這一種 Deliverable，「製作歌曲」是最後一步，
  // 保存完就等於整個工作完成了（見 Product Review「歌曲流程正式收斂」）
  if (isWorkComplete(work, stepIdx)) {
    work.status = '已完成';
    work.completedAt = new Date().toISOString();
    createFinalProduct(state, work, project);
  }
  saveState();
  showToast('已保存這首歌！');
  showScreen('screen-song-next');
}

function renderSongNext() {
  const work = getActiveWork();
  document.getElementById('sn-song-title').textContent = work.songTitle || work.name;
  document.getElementById('sn-filename').textContent = lastSongFileName || buildSuggestedFileName(work.songTitle || work.name, '歌曲');
}

// Sprint 1.1/1.2（歌曲 Flow 銜接影片 Flow）：點「製作影片」直接建立／開啟這首歌的 MV 工作，
// 全部由系統決定（Flow／影片類型／專案／工作名稱），不回新增工作畫面、不用重新選。
// sourceWorkId／sourceResultId／sourceType／sourceProjectId 這輪只負責記錄，Sprint 2 才會真的讀取使用。
function getOrCreateVideoProject() {
  let project = state.projects.find(function (p) { return p.type === 'video'; });
  if (!project) {
    project = { id: state.nextProjectId++, type: 'video', emoji: '🎬', name: '我的影片' };
    state.projects.push(project);
  }
  return project;
}
function songNextVideo() {
  const songWork = getActiveWork();
  const songProject = getProject(songWork.projectId);

  // 避免重複建立：搜尋全部工作，不只是目前專案，同一首歌已經有 MV 工作就直接開啟
  const existing = state.works.find(function (w) {
    return w.flowId === 'video' && w.videoType === 'song_mv' && w.sourceWorkId === songWork.id && w.sourceType === 'song';
  });
  const songDisplayName = songWork.songTitle || songWork.name;
  if (existing) {
    activeWorkId = existing.id;
    activeProjectId = existing.projectId;
    saveState();
    showToast('已開啟《' + songDisplayName + '》MV，繼續完成吧。');
    showScreen('screen-work-detail');
    return;
  }

  const videoProject = getOrCreateVideoProject();
  const finalResult = state.results.find(function (r) { return r.workId === songWork.id && r.isFinal; });
  const mvWork = {
    id: state.nextWorkId++, projectId: videoProject.id, name: songDisplayName + ' MV',
    flowId: 'video', videoType: 'song_mv', started: true, currentStepIndex: 0,
    status: '進行中', stepResultIds: [],
    sourceWorkId: songWork.id, sourceResultId: finalResult ? finalResult.id : null,
    sourceType: 'song', sourceProjectId: songProject.id
  };
  state.works.push(mvWork);
  activeWorkId = mvWork.id;
  activeProjectId = videoProject.id;
  saveState();
  showToast('已建立《' + songDisplayName + '》MV，我們開始準備影片。');
  showScreen('screen-work-detail');
}
function songNextLater() {
  showToast('好的，這首歌已經保存好了，之後可以再回來看。');
  showScreen('screen-project');
}

// ── 製作影片（Video Production Studio）──────────────────────────
// 跟「製作歌曲」同一套架構：不是 AI 寫文字，是帶著已完成的內容去外部工具動手做。
// Sprint 2.1（Starter UX）拆成兩個階段，不要一次把「圖片」跟「影片」兩件事混在一起：
// Phase A（screen-make-video）先完成圖片素材，只推薦圖片工具（ChatGPT／Canva／Gemini）；
// 確認圖片做好之後才進 Phase B（screen-video-tools），推薦影片工具（依影片類型），
// 不做特定工具的逐步引導（Sprint 3 Tool Companion）。
let lastMakeVideoScript = '';
let lastMakeVideoImages = '';
// Video Workflow vNext：逐幕圖片／影片 Prompt 複製用，key 是 sceneNo（數字）
let lastSceneImagePrompts = {};
let lastSceneVideoPrompts = {};

function copyMakeVideoScript() { copyPlainText(lastMakeVideoScript, '已複製腳本，帶去你的影片工具吧'); }
function copyMakeVideoImages() { copyPlainText(lastMakeVideoImages, '已複製圖片描述與風格，帶去你的圖片工具吧'); }
// CEO 真人驗收 Blocker #2 空資料防呆（核准的修正標準第三點）：畫面已經改成 imagePrompt
// 為空時按鈕直接 disabled（見 renderMakeVideo()），這裡多一層函式層級的防呆——就算按鈕
// 因為任何原因還是被觸發，也絕不把空字串寫進剪貼簿、絕不顯示「已複製」的成功提示。
function copySceneImagePrompt(sceneNo) {
  const text = lastSceneImagePrompts[sceneNo] || '';
  if (!text.trim()) { showToast('這一幕還沒有圖片生成指令，請先產生'); return; }
  copyPlainText(text, '已複製第' + sceneNo + '幕的圖片生成指令，帶去你的圖片工具吧');
}

function hasValidImagePrompt(scene) { return !!(scene && scene.imagePrompt && scene.imagePrompt.trim()); }

// CEO 真人驗收 Blocker #2（產品定位校準）：把乾淨旁白依句子邊界切成大致等長的 N 段，
// 不是機械式等分字數，也不是隨機切——依標點斷句後，用「累積長度接近平均值就換下一段」
// 的方式分組，避免把一句話從中間切斷。使用者要求的張數如果比實際句子數還多，最多只切到
// 句子數量（不會為了湊數硬生出空白的幕）。
function splitNarrationIntoSceneChunks(narrationText, count) {
  const sentences = (narrationText || '').split(/(?<=[。！？!?])\s*/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (sentences.length === 0) return [];
  const n = Math.max(1, Math.min(count, sentences.length));
  const totalLen = sentences.reduce(function (sum, s) { return sum + s.length; }, 0);
  const targetLen = totalLen / n;
  const chunks = [];
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const remaining = n - i;
    if (remaining === 1) { chunks.push(sentences.slice(idx).join('')); idx = sentences.length; break; }
    let acc = '';
    let accLen = 0;
    while (idx < sentences.length && (accLen === 0 || accLen < targetLen) && (sentences.length - idx) > (remaining - 1)) {
      acc += sentences[idx]; accLen += sentences[idx].length; idx++;
    }
    chunks.push(acc);
  }
  return chunks;
}

// CEO 真人驗收 Blocker #2（產品定位校準第二點）：圖片指令必須根據「這一幕實際的旁白內容」
// 決定人物、場景、動作、情緒與構圖，不是套一句空泛模板——直接把這一幕的旁白原文整段放進
// 指令裡，並明確要求「不要加入旁白沒有提到的重要情節」；再帶入 Style Anchor（風格、人物、
// 敘事調性等）與畫面比例，維持全片人物／場景／風格一致性，最後提醒是第幾幕、共幾幕。
function buildAutoImagePrompt(narration, styleAnchorText, ratioLabel, sceneNo, totalScenes) {
  return '請生成一張圖片，畫面請根據下面這段旁白內容決定人物、場景、動作、情緒與構圖，不要加入旁白沒有提到的重要情節：\n\n' +
    '「' + narration + '」\n\n' +
    styleAnchorText + '\n\n' +
    '這是全片第 ' + sceneNo + ' 幕（共 ' + totalScenes + ' 幕），請維持跟其他幕一致的人物外觀、場景與整體視覺風格，避免同一部影片裡人物或場景忽然變成不同樣貌。\n' +
    '畫面比例：' + ratioLabel + '。\n' +
    '請直接輸出這張圖片，不需要文字說明。';
}

// 把 ms.scenes 目前的內容重新寫回「腳本」步驟的正式成果，並重新走一次
// syncMasterScriptFromResult()，維持「state.results 是唯一正式來源」這條既有原則
// （跟 submitSceneRegenerate() 圖片／影片 Prompt 分支同一套寫回方式）。
function persistMasterScriptScenesChange(work, ms) {
  const project = getProject(work.projectId);
  const flow = FLOWS.video;
  const scriptIdx = flow.steps.findIndex(function (s) { return s.name === '腳本'; });
  const r = makeResult(state, work, project, scriptIdx, renderMasterScriptText(ms), false, '很滿意');
  work.stepResultIds[scriptIdx] = r.id;
  syncMasterScriptFromResult(work, r);
  saveState();
}

// CEO 真人驗收 Blocker #2（重新分鏡範圍採方案一）：只有在「目前所有場景都沒有有效的
// imagePrompt」時才會顯示「選擇圖片張數」入口（見 renderMakeVideo()），這裡才會被呼叫——
// 已經有部分或全部有效 imagePrompt 的既有內容，不會被這個函式覆蓋或整份清空重建。
function generateImagePromptsForAllScenes(count) {
  const work = getActiveWork();
  const ms = getMasterScript(work);
  if (!ms) return;
  const narration = ms.fullNarrationScript || '';
  const chunks = splitNarrationIntoSceneChunks(narration, count);
  if (chunks.length === 0) { showToast('目前沒有可用的旁白內容，無法產生分鏡'); return; }
  // 不直接用 ms.styleAnchorSnapshot——那是「腳本」步驟上一次確認時凍結的快照，這裡是機器
  // 產生新內容的當下，改用「現在」的 work.imageRatio／videoType 現組一份，避免畫面比例
  // 前後兩處（Style Anchor 摘要文字＋下面另外附加的畫面比例那一行）互相矛盾（一邊顯示
  // 「未設定」、一邊顯示「直式」）。persistMasterScriptScenesChange() 之後也會用同一組現值
  // 重新建立正式的 styleAnchorSnapshot，兩邊會保持一致。
  const styleAnchorText = buildStyleAnchorText(buildStyleAnchorSnapshot(work, ms));
  const ratioInfo = VIDEO_RATIO_OPTIONS.find(function (r) { return r.id === work.imageRatio; });
  const ratioLabel = ratioInfo ? ratioInfo.label : '直式';
  const totalScenes = chunks.length;
  ms.scenes = chunks.map(function (text, i) {
    const sceneNo = i + 1;
    return {
      sceneNo: sceneNo, sceneName: '', narration: text, subtitle: '',
      visualIntent: '', estimatedSeconds: '', mood: '', materialNeeds: '',
      imagePrompt: buildAutoImagePrompt(text, styleAnchorText, ratioLabel, sceneNo, totalScenes),
      videoPrompt: ''
    };
  });
  persistMasterScriptScenesChange(work, ms);
  renderMakeVideo();
}

function chooseImageRecoveryCount(count) { generateImagePromptsForAllScenes(count); }

function submitCustomImageRecoveryCount() {
  const input = document.getElementById('mv-image-recovery-custom-count');
  const count = parseInt(input.value, 10);
  if (!count || count < 1) { showToast('請輸入 1 以上的張數'); return; }
  generateImagePromptsForAllScenes(count);
}

// CEO 真人驗收 Blocker #2（重新分鏡範圍第三點）：只有部分場景缺少 imagePrompt 時，保留
// 已完成的內容，只針對這一幕補救——不觸發整份重新分鏡，沿用這一幕既有的旁白（narration
// 不變，只補上這一幕的圖片生成指令）。
function generateImagePromptForScene(sceneNo) {
  const work = getActiveWork();
  const ms = getMasterScript(work);
  if (!ms) return;
  const scene = ms.scenes.find(function (s) { return s.sceneNo === sceneNo; });
  if (!scene) return;
  // 同 generateImagePromptsForAllScenes()：用現在的 work 現值重組，不用可能過期的
  // ms.styleAnchorSnapshot，避免畫面比例前後矛盾。
  const styleAnchorText = buildStyleAnchorText(buildStyleAnchorSnapshot(work, ms));
  const ratioInfo = VIDEO_RATIO_OPTIONS.find(function (r) { return r.id === work.imageRatio; });
  const ratioLabel = ratioInfo ? ratioInfo.label : '直式';
  scene.imagePrompt = buildAutoImagePrompt(scene.narration || '', styleAnchorText, ratioLabel, sceneNo, ms.scenes.length);
  persistMasterScriptScenesChange(work, ms);
  renderMakeVideo();
}
function copySceneVideoPrompt(sceneNo) { copyPlainText(lastSceneVideoPrompts[sceneNo] || '', '已複製第' + sceneNo + '幕的影片生成指令，帶去你的影片工具吧'); }

// 單幕重做（Video Workflow vNext MVP 邊界）：只改指定這一幕的圖片 Prompt／影片 Prompt／
// 配音與字幕其中一項，不影響其他幕的母稿內容，也不需要重貼整份母稿——這是 CEO 核准的
// 「單幕重做」範圍，刻意不做完整素材版本管理／自動連動影響追蹤／自動呼叫外部工具。
let sceneRegenerateState = null; // { sceneNo, aspect: 'image'|'video'|'voiceover', returnScreen }

function openSceneRegenerate(sceneNo, aspect, returnScreen) {
  const work = getActiveWork();
  const ms = getMasterScript(work);
  if (!ms) { showToast('請先完成腳本這一步，才能重做單一幕'); return; }
  sceneRegenerateState = { sceneNo: sceneNo, aspect: aspect, returnScreen: returnScreen };
  showScreen('screen-scene-regenerate');
}

function buildSceneRegenerateInstruction() {
  const work = getActiveWork();
  const ms = getMasterScript(work);
  const state_ = sceneRegenerateState;
  const scene = ms.scenes.find(function (s) { return s.sceneNo === state_.sceneNo; });
  const askLabel = state_.aspect === 'image' ? '圖片 Prompt' : state_.aspect === 'video' ? '影片 Prompt' : '配音與字幕';
  const formatHint = state_.aspect === 'voiceover'
    ? '配音稿：……\n配音語氣：……\n語速與停頓：……\n字幕：……'
    : '（新的' + askLabel + '內容）';
  return '你是影片製作教練，正在協助我只重新生成單一幕的' + askLabel + '，不是重做整支影片。\n\n' +
    getConfirmedStyleAnchorText(work) + '\n\n' +
    '這一幕已經確認、不可更動的內容：\n' +
    '第' + scene.sceneNo + '幕｜' + (scene.sceneName || '') + '\n' +
    '旁白／文案：' + (scene.narration || '') + '\n' +
    '畫面意圖：' + (scene.visualIntent || '') + '\n' +
    '情緒與語氣：' + (scene.mood || '') + '\n\n' +
    '請只產生這一幕的' + askLabel + '，不要更動旁白／文案，也不要輸出其他幕的內容。請完全依照以下格式輸出，方便我直接貼回工作台：\n\n' +
    '【第' + scene.sceneNo + '幕｜' + askLabel + '】\n' + formatHint;
}

function copySceneRegenerateInstructionText() {
  const text = document.getElementById('scene-regen-instruction-box').textContent;
  copyPlainText(text, '已複製修改指令');
}

function cancelSceneRegenerate() {
  const returnScreen = sceneRegenerateState ? sceneRegenerateState.returnScreen : 'screen-work-detail';
  sceneRegenerateState = null;
  showScreen(returnScreen);
}

// 貼回單幕重做結果：只有解析成功（抓得到指定這一幕＋這個面向的內容）才會合併進
// work.masterScript 並產生新版本；解析失敗時原樣保留使用者貼的文字讓他們確認，
// 不動目前合法的母稿版本——比照腳本／配音與字幕整份貼回時同一套「解析失敗不可
// 取代合法正式版本」原則（CEO 核准的第二項校準），只是這裡範圍縮小到單一幕。
function submitSceneRegenerate() {
  const work = getActiveWork();
  const project = getProject(work.projectId);
  const flow = FLOWS.video;
  const content = document.getElementById('scene-regen-paste-input').value.trim();
  const st = sceneRegenerateState;
  const ms = getMasterScript(work);
  const parsed = parseSceneRegenerateResponse(content, st.sceneNo, st.aspect);
  const warnEl = document.getElementById('scene-regen-warning');
  if (!parsed.valid) {
    warnEl.style.display = 'block';
    warnEl.textContent = '內容格式看起來不完整，請確認有沒有照【第' + st.sceneNo + '幕｜...】的格式輸出，重新貼回。';
    return;
  }
  warnEl.style.display = 'none';
  const scene = ms.scenes.find(function (s) { return s.sceneNo === st.sceneNo; });
  if (st.aspect === 'image') scene.imagePrompt = parsed.text;
  if (st.aspect === 'video') scene.videoPrompt = parsed.text;
  if (st.aspect === 'voiceover') scene.voiceover = parsed.voiceover;

  if (st.aspect === 'voiceover') {
    const voiceIdx = flow.steps.findIndex(function (s) { return s.name === '配音與字幕'; });
    const r = makeResult(state, work, project, voiceIdx, renderVoiceoverText(ms), false, '很滿意');
    r.masterScriptResultId = ms.sourceResultId;
    work.stepResultIds[voiceIdx] = r.id;
    syncVoiceoverFromResult(work, r);
  } else {
    // 圖片／影片 Prompt 單幕重做不會動到旁白／文案，所以配音與字幕理論上不需要重做。
    // 但腳本重新同步是整份重新解析（見 syncMasterScriptFromResult()），解析結果不含
    // voiceover 欄位，會讓 work.masterScript.scenes[].voiceover 整批消失；而
    // syncVoiceoverFromResult() 又會因為 masterScriptResultId 對不上新的腳本版本
    // 而拒絕重新套用（這個防呆是刻意設計來擋「舊配音套到新腳本」，見該函式註解）。
    // 所以這裡連同配音與字幕也一起產生一個新版本，內容不變、只是把
    // masterScriptResultId 對齊到新的腳本版本，讓版本鏈維持一致，避免使用者被迫
    // 重做一次完全沒有變動需要的配音與字幕。
    const savedVoiceovers = ms.scenes.map(function (s) { return { sceneNo: s.sceneNo, voiceover: s.voiceover }; });
    const scriptIdx = flow.steps.findIndex(function (s) { return s.name === '腳本'; });
    const r = makeResult(state, work, project, scriptIdx, renderMasterScriptText(ms), false, '很滿意');
    work.stepResultIds[scriptIdx] = r.id;
    syncMasterScriptFromResult(work, r);
    const hadVoiceover = savedVoiceovers.some(function (s) { return s.voiceover && s.voiceover.voiceoverScript; });
    if (hadVoiceover) {
      work.masterScript.scenes.forEach(function (scene) {
        const saved = savedVoiceovers.find(function (s) { return s.sceneNo === scene.sceneNo; });
        if (saved && saved.voiceover) scene.voiceover = saved.voiceover;
      });
      const voiceIdx = flow.steps.findIndex(function (s) { return s.name === '配音與字幕'; });
      const vr = makeResult(state, work, project, voiceIdx, renderVoiceoverText(work.masterScript), false, '很滿意');
      vr.masterScriptResultId = r.id;
      work.stepResultIds[voiceIdx] = vr.id;
      syncVoiceoverFromResult(work, vr);
    }
  }
  saveState();
  showToast('已更新第' + st.sceneNo + '幕的' + (st.aspect === 'image' ? '圖片' : st.aspect === 'video' ? '影片' : '配音與字幕') + '內容');
  const returnScreen = st.returnScreen;
  sceneRegenerateState = null;
  showScreen(returnScreen);
}

function renderSceneRegenerate() {
  const work = getActiveWork();
  const ms = getMasterScript(work);
  const st = sceneRegenerateState;
  const scene = ms.scenes.find(function (s) { return s.sceneNo === st.sceneNo; });
  const askLabel = st.aspect === 'image' ? '圖片生成指令' : st.aspect === 'video' ? '影片生成指令' : '配音與字幕';
  document.getElementById('scene-regen-title').textContent = '重新生成第' + st.sceneNo + '幕的' + askLabel;
  document.getElementById('scene-regen-scene-name').textContent = scene.sceneName ? '（' + scene.sceneName + '）' : '';
  document.getElementById('scene-regen-instruction-box').textContent = buildSceneRegenerateInstruction();
  document.getElementById('scene-regen-paste-input').value = '';
  document.getElementById('scene-regen-warning').style.display = 'none';
}

// Correction Proposal Stage C：Phase A／Phase B 共用的畫面順序（影片總覽→完整影片文案／
// 旁白稿→完整配音稿（若已確認）→Style Anchor 摘要→逐幕分鏡卡片）改成同一個函式產生，
// 避免兩個畫面各自寫一份、之後容易長歪。prefix 是 'mv'（Phase A）或 'vt'（Phase B），
// 對應 index.html 裡各自的 id（例如 mv-full-narration-box／vt-full-narration-box）。
let lastFullNarrationText = '';
let lastFullVoiceoverText = '';
function copyFullNarrationScript() { copyPlainText(lastFullNarrationText, '已複製完整文案'); }
function copyFullVoiceoverScript() { copyPlainText(lastFullVoiceoverText, '已複製完整配音稿'); }
// CEO 真人驗收 Bug #1 附帶需求：純配音用的乾淨旁白稿，跟「完整文案」共用同一份內容，
// 只是額外再跑一次 extractCleanNarrationText()——理想格式（Stage A/B 嚴格解析）下這段本來就
// 已經很乾淨，重跑一次是無害的；寬鬆解析（舊格式貼回）下 fullNarrationScript 本身就是
// extractCleanNarrationText() 的結果，這裡等於再確保一次不殘留任何標籤或 Markdown 符號。
//
// CEO 產品決策（2026-07-30 產品收斂）：Toast 文字依「目前在哪個畫面」而不同——Phase B
// 才提示可貼到開拍，Phase A 維持原本工具中立、不得出現「開拍」字樣。Toast 元件本身是
// 單行圓角膠囊樣式（.toast，border-radius:99px），不適合塞兩行文字，這裡把 CEO 提供的
// 兩行文案（✅ 已複製乾淨旁白稿／可貼到開拍快速產生口播影片）合併成一行顯示，語意不變。
let lastCleanNarrationText = '';
function copyCleanNarrationText() {
  const onPhaseB = document.getElementById('screen-video-tools').classList.contains('active');
  const message = onPhaseB ? '已複製乾淨旁白稿，可貼到開拍快速產生口播影片' : '已複製乾淨旁白稿';
  copyPlainText(lastCleanNarrationText, message);
}

// CEO 核准的下一步引導（僅簡短提示文字＋一個開啟連結，不自動跳轉）：使用者複製完乾淨旁白稿後，
// 讓他知道「這份東西還可以拿去做什麼」，但不強制、不改變任何 Flow 步驟——這一步做完，
// 使用者原本要走的四步流程（主題→腳本→配音與字幕→製作影片）完全不受影響。
//
// CEO 產品決策（開拍提示位置採方案 A）：只在 Phase B（製作影片工具頁，prefix==='vt'）
// 顯示，Phase A（畫面準備頁，prefix==='mv'）維持原本的工具中立原則，不提前點名任何
// 影片輸出工具名稱（含「開拍」）。index.html 的 Phase A 區塊也已移除對應的提示文字容器。
const KAIPAI_NEXT_STEP_HINT = '已完成旁白，可貼到開拍一鍵成片，快速產生口播或短影音。';

function renderMasterScriptHeader(ms, prefix) {
  const narration = getDisplayFullNarrationScript(ms);
  lastFullNarrationText = narration.text;
  lastCleanNarrationText = extractCleanNarrationText(narration.text);
  document.getElementById(prefix + '-full-narration-box').textContent = narration.text || '（尚未有內容）';
  if (prefix === 'vt') {
    document.getElementById(prefix + '-kaipai-hint').textContent = KAIPAI_NEXT_STEP_HINT;
    // 「開啟開拍」一鍵入口：沿用 Stage D 共用的 buildToolOpenLinkHtml()／tools-catalog.json，
    // 沒有寫任何新的開啟邏輯；不自動跳轉，使用者要自己點才會開新分頁。
    document.getElementById(prefix + '-kaipai-open-link').innerHTML = buildToolOpenLinkHtml('kaipai', '🎙️ 開啟開拍');
  }
  const narrationNote = document.getElementById(prefix + '-full-narration-fallback-note');
  if (narration.isFallbackAssembled) {
    narrationNote.style.display = 'block';
    narrationNote.textContent = '（此為系統依逐幕內容組合顯示，非原始完整文案）';
  } else {
    narrationNote.style.display = 'none';
  }

  const voiceover = getDisplayFullVoiceoverScript(ms);
  const voiceoverCard = document.getElementById(prefix + '-full-voiceover-card');
  if (voiceover.text) {
    voiceoverCard.style.display = 'block';
    lastFullVoiceoverText = voiceover.text;
    document.getElementById(prefix + '-full-voiceover-box').textContent = voiceover.text;
    const voiceoverNote = document.getElementById(prefix + '-full-voiceover-fallback-note');
    if (voiceover.isFallbackAssembled) {
      voiceoverNote.style.display = 'block';
      voiceoverNote.textContent = '（此為系統依逐幕配音組合顯示，非原始完整配音稿）';
    } else {
      voiceoverNote.style.display = 'none';
    }
  } else {
    voiceoverCard.style.display = 'none';
  }

  document.getElementById(prefix + '-style-anchor-box').innerHTML = buildStyleAnchorSummaryHtml(ms.styleAnchorSnapshot);
}

// Video Workflow vNext：有 Master Script（新格式，逐幕）時，Phase A 改成逐幕卡片顯示，
// 每一幕都能看到旁白／字幕／畫面意圖／秒數／情緒／素材需求，並各自複製自己的圖片 Prompt。
// 舊影音工作（沒有 work.masterScript，例如這次 Sprint 之前就存在的工作）繼續用舊版
// parseVideoScriptSections() 的三段式扁平顯示，不會打不開、不會白屏——這是 CEO 明確
// 要求的「舊影音工作相容」。
function renderMakeVideo() {
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];

  // Sprint 2：圖片比例／數量，第一次進來依影片類型帶入建議預設值，使用者可以隨時改
  const defaults = videoTypeDefaults(work.videoType);
  if (!work.imageRatio) work.imageRatio = defaults.ratio;
  if (!work.imageCount) work.imageCount = defaults.count;
  saveState();

  const ratioList = document.getElementById('mv-ratio-list');
  ratioList.innerHTML = VIDEO_RATIO_OPTIONS.map(function (opt) {
    const sel = opt.id === work.imageRatio ? ' selected' : '';
    const star = opt.starter ? '⭐⭐⭐⭐⭐ Starter 推薦　·　適合：' + opt.uses : '適合：' + opt.uses;
    return '<div class="option-card' + sel + '" onclick="chooseVideoRatio(\'' + opt.id + '\')">' +
      '<div class="option-title">' + opt.emoji + ' ' + opt.label + '</div>' +
      '<div class="option-sub">' + star + '</div></div>';
  }).join('');

  const countList = document.getElementById('mv-count-list');
  countList.innerHTML = VIDEO_IMAGE_COUNT_OPTIONS.map(function (opt) {
    const sel = opt.count === work.imageCount ? ' selected' : '';
    return '<div class="template-pick' + sel + '" onclick="chooseImageCount(' + opt.count + ')">' + opt.label + '</div>';
  }).join('');

  // Phase 1B：改讀 Official Recommendation Center（collaboration-templates.json 的
  // video／工程師／製作影片／category:image），取代原本寫死在 VIDEO_IMAGE_TOOL_RECOMMENDATIONS 的清單。
  renderToolRecommendationCard('mv-recommended-tools', getRecommendedToolsChain('video', '工程師', '製作影片', 'image'), 'screen-make-video');

  const ms = getMasterScript(work);
  const legacyBlock = document.getElementById('mv-legacy-block');
  const scenesBlock = document.getElementById('mv-scenes-block');
  if (ms) {
    legacyBlock.style.display = 'none';
    scenesBlock.style.display = 'block';
    document.getElementById('mv-overview-summary').textContent =
      '主軸：' + (ms.mainThread || '（無）') + '　｜　長度：' + (ms.lengthRange || '（未設定）') + '　｜　共 ' + ms.scenes.length + ' 幕';
    renderMasterScriptHeader(ms, 'mv');
    lastSceneImagePrompts = {};

    // CEO 真人驗收 Blocker #2（重新分鏡範圍採方案一）：只有「目前所有場景都沒有有效
    // imagePrompt」時，才顯示「選擇圖片張數」的補救入口；只要有任何一幕已經有效，
    // 就不顯示這個入口，避免使用者不小心把已完成的內容整份重切。
    const allMissing = ms.scenes.every(function (s) { return !hasValidImagePrompt(s); });
    const recoveryBlock = document.getElementById('mv-image-recovery-block');
    if (allMissing) {
      recoveryBlock.style.display = 'block';
      document.getElementById('mv-image-recovery-count-list').innerHTML = IMAGE_RECOVERY_COUNT_OPTIONS.map(function (count) {
        return '<div class="template-pick" onclick="chooseImageRecoveryCount(' + count + ')">' + count + ' 張</div>';
      }).join('');
      document.getElementById('mv-scenes-list').innerHTML = '';
      return;
    }
    recoveryBlock.style.display = 'none';

    // Correction Proposal Stage D（每一幕的操作順序：先複製這一幕指令，再開啟推薦工具）：
    // 開啟連結指向這一步「官方推薦」的圖片工具（跟 mv-recommended-tools 卡片同一個推薦結果，
    // 只是多一個更靠近逐幕內容的捷徑）；沒有網址時 buildToolOpenLinkHtml() 直接回傳空字串，
    // 不會渲染出開啟按鈕，也不會有第一顆按鈕還沒按就先把使用者送出工作台的狀況。
    const primaryImageTool = getRecommendedToolsChain('video', '工程師', '製作影片', 'image')[0];
    document.getElementById('mv-scenes-list').innerHTML = ms.scenes.map(function (scene) {
      lastSceneImagePrompts[scene.sceneNo] = scene.imagePrompt || '';
      const openLink = primaryImageTool ? buildToolOpenLinkHtml(primaryImageTool.toolId, '開啟推薦圖片工具') : '';
      // CEO 真人驗收 Blocker #2（空資料防呆第三點）：這一幕缺少 imagePrompt 時，複製按鈕
      // disabled、不得顯示可操作的複製按鈕誤導使用者，改成明確的「產生圖片指令」CTA；
      // 只針對「這一幕」補救，不影響其他已經有效的幕（部分缺失時不整份重建）。
      const missing = !hasValidImagePrompt(scene);
      const copyBtnHtml = missing
        ? '<button class="btn outline" style="margin-top:6px" disabled>📋 複製第' + scene.sceneNo + '幕圖片生成指令</button>' +
          '<div class="notice" style="margin-top:6px">尚未產生這一幕的圖片生成指令。</div>' +
          '<button class="btn" style="margin-top:6px" onclick="generateImagePromptForScene(' + scene.sceneNo + ')">✨ 產生圖片指令</button>'
        : '<button class="btn outline" style="margin-top:6px" onclick="copySceneImagePrompt(' + scene.sceneNo + ')">📋 複製第' + scene.sceneNo + '幕圖片生成指令</button>';
      return '<div class="card" style="margin-top:14px">' +
        '<div class="section-label">第' + scene.sceneNo + '幕' + (scene.sceneName ? '｜' + escHtml(scene.sceneName) : '') + '</div>' +
        '<div class="line"><b>旁白／文案：</b>' + escHtml(scene.narration || '（無）') + '</div>' +
        '<div class="line"><b>畫面意圖：</b>' + escHtml(scene.visualIntent || '（無）') + '</div>' +
        '<div class="line"><b>預估秒數：</b>' + escHtml(scene.estimatedSeconds || '（未設定）') + '　<b>情緒：</b>' + escHtml(scene.mood || '（無）') + '</div>' +
        '<div class="line"><b>素材需求：</b>' + escHtml(scene.materialNeeds || '（無）') + '</div>' +
        '<div class="section-label" style="margin-top:10px;font-size:14px">圖片生成指令</div>' +
        '<div class="copy-box">' + escHtml(scene.imagePrompt || '（還沒有圖片生成指令）') + '</div>' +
        copyBtnHtml +
        openLink +
        '<button class="btn outline" style="margin-top:6px" onclick="openSceneRegenerate(' + scene.sceneNo + ', \'image\', \'screen-make-video\')">🔁 只重新生成這一幕的圖片指令</button>' +
        '</div>';
    }).join('');
    return;
  }

  // 舊格式 fallback
  legacyBlock.style.display = 'block';
  scenesBlock.style.display = 'none';
  const scriptIdx = flow.steps.findIndex(function (s) { return s.name === '腳本'; });
  const scriptResult = state.results.find(function (r) { return r.id === work.stepResultIds[scriptIdx]; });
  const sections = parseVideoScriptSections(scriptResult ? scriptResult.content : '');
  lastMakeVideoScript = sections.script;
  lastMakeVideoImages = [sections.images, sections.style].filter(Boolean).join('\n\n');

  document.getElementById('mv-script-content').textContent = sections.script || '（還沒有腳本內容）';
  document.getElementById('mv-image-desc-content').textContent = sections.images || '（還沒有圖片描述）';
  document.getElementById('mv-style-content').textContent = sections.style || '（還沒有風格建議）';
}

function chooseVideoRatio(id) {
  const work = getActiveWork();
  work.imageRatio = id;
  saveState();
  renderMakeVideo();
}
function chooseImageCount(count) {
  const work = getActiveWork();
  work.imageCount = count;
  saveState();
  renderMakeVideo();
}

// ── 圖片完成確認（Phase A → Phase B 的關卡）──
// CEO 真人驗收 Blocker #2（下一步 Gate 校準）：判斷依據只看「資料是否備齊」——已建立至少
// 一幕、每一幕都有可用的 imagePrompt，不看使用者有沒有點開任何外部工具連結、有沒有用官方
// 推薦的 Gemini（工具推薦是 Recommendation，不是 Gate 條件，維持 Vendor Neutral）。
// 沒有 Master Script 的舊工作（legacy fallback）完全不受這個 Gate 影響，維持原本可以
// 直接繼續的行為，不破壞舊資料相容性。
function goImageConfirm() {
  const work = getActiveWork();
  const ms = getMasterScript(work);
  if (ms) {
    if (ms.scenes.length === 0) { showToast('尚未建立任何場景，請先完成腳本這一步'); return; }
    const missingCount = ms.scenes.filter(function (s) { return !hasValidImagePrompt(s); }).length;
    if (missingCount > 0) { showToast('還有 ' + missingCount + ' 幕缺少圖片生成指令，完成後即可繼續。'); return; }
  }
  showScreen('screen-image-confirm');
}
// Phase A（圖片）局部修改：目標是「腳本」步驟裡的圖片描述/風格建議，跟 poster 的視覺設計是同一種情況
// （單一步驟成果，可以直接沿用 buildRevisionInstruction() 的 r.stepIndex 推算邏輯，不用像歌曲另外處理）。
function imageConfirmRegenerate() {
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];
  const scriptIdx = flow.steps.findIndex(function (s) { return s.name === '腳本'; });
  const scriptResult = state.results.find(function (r) { return r.id === work.stepResultIds[scriptIdx]; });
  if (!scriptResult) { showToast('找不到腳本內容，請先完成腳本這一步'); showScreen('screen-make-video'); return; }
  lastSubmittedResultId = scriptResult.id;
  videoImageRegenerateMode = true;
  regenerateDirectionsOverride = ['換照片', '改比例', '改風格', '補充描述'];
  selectedDirections = [];
  showScreen('screen-revise-direction');
}
function imageConfirmLater() {
  showToast('已保存，之後回來可以繼續。');
  showScreen('screen-work-detail');
}
function imageConfirmDone() {
  const work = getActiveWork();
  work.imagesCompleted = true;
  saveState();
  showScreen('screen-video-tools');
}

// 開拍任務分工卡片（CEO 核准的最小整合，2026-07-30 產品收斂：改用初學者思考順序分組，
// 不再依工具類型分組）：三組依「使用者此刻手上有什麼、想完成什麼」排列——①已經有圖片、
// 想做影片（Gemini／Kling／Runway／Pika）②已經有旁白、想快速完成影片（開拍）③要剪輯、
// 字幕與完成影片（Canva／CapCut）。開拍跟「圖片轉影片」刻意分開列，避免被誤會成圖生影片
// 工具。跟既有 vt-tool-guide（Gemini 官方推薦）／vt-recommended-tools（依 videoType 的其他
// 影片工具）完全分開、互不取代，只是額外提供一份「依任務找工具」的參考，開啟連結沿用
// Stage D 共用的 buildToolOpenLinkHtml()，沒有另建開啟機制。
//
// CEO 產品收斂（一個功能、一個主要入口）：開拍的「開啟」按鈕已經在「複製乾淨旁白稿」
// 下方（renderMasterScriptHeader() 的 vt-kaipai-open-link），是使用者完成旁白後真正
// 會用到的下一步操作位置；這裡的開拍只負責「介紹」（名稱＋官方推薦＋一句說明），
// 不再重複放第二顆「開啟」按鈕，避免同一個功能出現兩個入口。其餘工具（Gemini／Kling／
// Runway／Pika／Canva／CapCut）在這裡是唯一的開啟入口，維持原本各自的開啟連結。
function buildTaskGroupedToolsHtml() {
  function toolLine(toolId, name, note) {
    const openLink = buildToolOpenLinkHtml(toolId, '開啟 ' + name);
    return '<div class="line" style="margin-top:6px"><b>' + escHtml(name) + '</b>' + (note ? '　' + escHtml(note) : '') + '</div>' + openLink;
  }
  let html = '<div class="line" style="margin-top:8px">我已經有圖片，想做影片</div>';
  html += toolLine('gemini', 'Gemini', '官方推薦');
  html += toolLine('kling', 'Kling', '替代工具');
  html += toolLine('runway', 'Runway', '進階工具');
  html += toolLine('pika', 'Pika', '進階工具');
  html += '<div class="line" style="margin-top:12px">我已經有旁白，想快速完成影片</div>';
  html += '<div class="line" style="margin-top:6px"><b>開拍</b>　官方推薦</div>';
  html += '<div class="line" style="margin-top:4px;font-size:12px;color:var(--text-dim)">已完成旁白，可貼到開拍快速產生口播或短影音。</div>';
  html += '<div class="line" style="margin-top:12px">我要剪輯、字幕與完成影片</div>';
  html += toolLine('canva', 'Canva', '');
  html += toolLine('capcut', 'CapCut', '');
  return html;
}

// Video Flow Sprint 2：Kling 的完整引導改由 renderToolGuide()／VIDEO_TOOL_GUIDE 直接顯示在畫面上
// （工具介紹＋7 步流程＋完成提醒＋開啟工具按鈕），不用再多點一次「查看使用步驟」；
// 依影片類型的其他工具（Runway/Pika/Canva/CapCut）保留在「其他影片工具」，是額外的替代選項。
function renderVideoTools() {
  const work = getActiveWork();
  renderToolGuide('vt-tool-guide', 'vt-open-tool-btn', withOfficialRecommendation(TOOL_GUIDES.video, 'video', '工程師', '製作影片', 'video'));
  // suppressPrimaryBadge=true：Kling 的官方建議已經在上面 vt-tool-guide 卡片顯示過，這裡是依影片
  // 類型的「其他」工具清單，不要讓清單第一項也被標成「⭐官方建議」，避免同畫面出現兩個官方建議。
  renderToolRecommendationCard('vt-recommended-tools', getVideoTypeToolRecommendations(work.videoType), 'screen-video-tools', '其他影片工具', true);
  document.getElementById('vt-task-tools-box').innerHTML = buildTaskGroupedToolsHtml();

  // Video Workflow vNext：有 Master Script 時，逐幕顯示影片 Prompt；舊工作沒有時整段隱藏
  // （Phase B 原本就沒有舊格式的「影片素材指令」顯示，這是全新的逐幕內容，不是取代誰）。
  const ms = getMasterScript(work);
  const scenesBlock = document.getElementById('vt-scenes-block');
  if (ms) {
    scenesBlock.style.display = 'block';
    document.getElementById('vt-overview-summary').textContent =
      '主軸：' + (ms.mainThread || '（無）') + '　｜　長度：' + (ms.lengthRange || '（未設定）') + '　｜　共 ' + ms.scenes.length + ' 幕';
    renderMasterScriptHeader(ms, 'vt');
    lastSceneVideoPrompts = {};
    // Correction Proposal Stage D：同樣先複製這一幕指令，再提供開啟推薦影片工具的捷徑
    // （跟上面 vt-tool-guide 卡片的「開啟 Kling」是同一個官方推薦來源）。
    const primaryVideoTool = getRecommendedToolsChain('video', '工程師', '製作影片', 'video')[0];
    document.getElementById('vt-scenes-list').innerHTML = ms.scenes.map(function (scene) {
      lastSceneVideoPrompts[scene.sceneNo] = scene.videoPrompt || '';
      const openLink = primaryVideoTool ? buildToolOpenLinkHtml(primaryVideoTool.toolId, '開啟推薦影片工具') : '';
      return '<div class="card" style="margin-top:14px">' +
        '<div class="section-label">第' + scene.sceneNo + '幕' + (scene.sceneName ? '｜' + escHtml(scene.sceneName) : '') + '</div>' +
        '<div class="copy-box">' + escHtml(scene.videoPrompt || '（還沒有影片生成指令）') + '</div>' +
        '<button class="btn outline" style="margin-top:6px" onclick="copySceneVideoPrompt(' + scene.sceneNo + ')">📋 複製第' + scene.sceneNo + '幕影片生成指令</button>' +
        openLink +
        '<button class="btn outline" style="margin-top:6px" onclick="openSceneRegenerate(' + scene.sceneNo + ', \'video\', \'screen-video-tools\')">🔁 只重新生成這一幕的影片指令</button>' +
        '</div>';
    }).join('');
  } else {
    scenesBlock.style.display = 'none';
  }
}

function goVideoConfirm() { showScreen('screen-video-confirm'); }
// Phase B（影片）局部修改：同樣以「腳本」步驟的成果為修改依據（影片是圖片+腳本節奏的產物，
// 沒有獨立的「影片步驟成果」可以參照，腳本已經是使用者能提供的最完整脈絡）。
function videoConfirmRegenerate() {
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];
  const scriptIdx = flow.steps.findIndex(function (s) { return s.name === '腳本'; });
  const scriptResult = state.results.find(function (r) { return r.id === work.stepResultIds[scriptIdx]; });
  if (!scriptResult) { showToast('找不到腳本內容，請先完成腳本這一步'); showScreen('screen-video-tools'); return; }
  lastSubmittedResultId = scriptResult.id;
  videoRegenerateMode = true;
  regenerateDirectionsOverride = ['改鏡頭', '改節奏', '改配樂', '換工具再試'];
  selectedDirections = [];
  showScreen('screen-revise-direction');
}
function videoConfirmLater() {
  showToast('已保存，之後回來可以繼續。');
  showScreen('screen-work-detail');
}
// 剪輯交接（Stage 5，CEO 核准範圍）：只有有 Master Script 的工作才需要交接清單——純粹是
// 從 getMasterScript() 組現有資料的畫面，不呼叫 AI、不產生新內容。舊影音工作（沒有母稿）
// 直接跳過，維持原本「完成了 → 保存這支影片」的行為，不強迫使用者看一個沒有資料的空畫面。
function videoConfirmDone() {
  const work = getActiveWork();
  if (getMasterScript(work)) { showScreen('screen-video-handoff'); return; }
  showScreen('screen-save-video');
}
function videoHandoffContinue() { showScreen('screen-save-video'); }

let lastVideoHandoffText = '';
function copyVideoHandoffChecklist() { copyPlainText(lastVideoHandoffText, '已複製剪輯交接清單'); }

// Correction Proposal Stage C（要求八）：剪輯交接清單最前面要先看到完整文案與完整配音稿，
// 使用者或剪輯師才能先掌握整體內容，再處理逐幕素材——沿用 renderMasterScriptHeader() 同一份
// 資料與 fallback 規則（舊版沒有 fullNarrationScript／fullVoiceoverScript 時一樣誠實標記）。
function renderVideoHandoffFullScriptSection(ms) {
  const narration = getDisplayFullNarrationScript(ms);
  const voiceover = getDisplayFullVoiceoverScript(ms);
  let html = '<div class="card"><div class="section-label">完整影片文案／旁白稿</div>' +
    (narration.isFallbackAssembled ? '<div class="notice" style="margin-top:6px">（此為系統依逐幕內容組合顯示，非原始完整文案）</div>' : '') +
    '<div class="copy-box" style="margin-top:8px">' + escHtml(narration.text || '（尚未有內容）') + '</div>' +
    '<button class="btn outline" style="margin-top:8px" onclick="copyFullNarrationScript()">📋 複製完整文案</button></div>';
  if (voiceover.text) {
    html += '<div class="card" style="margin-top:14px"><div class="section-label">完整配音稿</div>' +
      (voiceover.isFallbackAssembled ? '<div class="notice" style="margin-top:6px">（此為系統依逐幕配音組合顯示，非原始完整配音稿）</div>' : '') +
      '<div class="copy-box" style="margin-top:8px">' + escHtml(voiceover.text) + '</div>' +
      '<button class="btn outline" style="margin-top:8px" onclick="copyFullVoiceoverScript()">📋 複製完整配音稿</button></div>';
  }
  return html;
}

function renderVideoHandoff() {
  const work = getActiveWork();
  const ms = getMasterScript(work);
  document.getElementById('vh-full-script-section').innerHTML = renderVideoHandoffFullScriptSection(ms);
  lastFullNarrationText = getDisplayFullNarrationScript(ms).text;
  lastFullVoiceoverText = getDisplayFullVoiceoverScript(ms).text;
  const list = document.getElementById('vh-scenes-list');
  const missing = [];
  list.innerHTML = ms.scenes.map(function (scene) {
    const voice = scene.voiceover;
    if (!voice) missing.push('第' + scene.sceneNo + '幕還沒有配音與字幕內容');
    if (!scene.imagePrompt) missing.push('第' + scene.sceneNo + '幕還沒有圖片生成指令');
    if (!scene.videoPrompt) missing.push('第' + scene.sceneNo + '幕還沒有影片生成指令');
    return '<div class="card" style="margin-top:14px">' +
      '<div class="section-label">第' + scene.sceneNo + '幕' + (scene.sceneName ? '｜' + escHtml(scene.sceneName) : '') + '　（約 ' + escHtml(scene.estimatedSeconds || '未設定') + '）</div>' +
      '<div class="line"><b>旁白／文案：</b>' + escHtml(scene.narration || '（無）') + '</div>' +
      '<div class="line"><b>字幕：</b>' + escHtml((voice && voice.subtitle) || scene.subtitle || '（無）') + '</div>' +
      (voice ? '<div class="line"><b>配音稿：</b>' + escHtml(voice.voiceoverScript || '（無）') + '</div>' +
        '<div class="line"><b>配音語氣：</b>' + escHtml(voice.tone || '（無）') + '　<b>語速與停頓：</b>' + escHtml(voice.paceNotes || '（無）') + '</div>'
        : '<div class="line">（尚未完成配音與字幕）</div>') +
      '<div class="line"><b>畫面意圖：</b>' + escHtml(scene.visualIntent || '（無）') + '</div>' +
      '<div class="line"><b>素材需求：</b>' + escHtml(scene.materialNeeds || '（無）') + '</div>' +
      '<div class="btn-row" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn outline" onclick="openSceneRegenerate(' + scene.sceneNo + ', \'image\', \'screen-video-handoff\')">🔁 重做圖片指令</button>' +
      '<button class="btn outline" onclick="openSceneRegenerate(' + scene.sceneNo + ', \'video\', \'screen-video-handoff\')">🔁 重做影片指令</button>' +
      '<button class="btn outline" onclick="openSceneRegenerate(' + scene.sceneNo + ', \'voiceover\', \'screen-video-handoff\')">🔁 重做配音與字幕</button>' +
      '</div>' +
      '</div>';
  }).join('');

  const warnEl = document.getElementById('vh-missing-warning');
  if (missing.length) {
    warnEl.style.display = 'block';
    warnEl.textContent = '⚠️ 還沒完成：' + missing.join('；');
  } else {
    warnEl.style.display = 'none';
  }

  const narrationForText = getDisplayFullNarrationScript(ms);
  const voiceoverForText = getDisplayFullVoiceoverScript(ms);
  lastVideoHandoffText = '【剪輯交接清單】' + work.name + '\n主軸：' + (ms.mainThread || '') + '　長度：' + (ms.lengthRange || '') + '\n\n' +
    '【完整影片文案／旁白稿】' + (narrationForText.isFallbackAssembled ? '（系統依逐幕內容組合）' : '') + '\n' + (narrationForText.text || '') + '\n\n' +
    (voiceoverForText.text ? '【完整配音稿】' + (voiceoverForText.isFallbackAssembled ? '（系統依逐幕配音組合）' : '') + '\n' + voiceoverForText.text + '\n\n' : '') +
    ms.scenes.map(function (scene) {
      const voice = scene.voiceover;
      return '第' + scene.sceneNo + '幕' + (scene.sceneName ? '｜' + scene.sceneName : '') + '（約 ' + (scene.estimatedSeconds || '未設定') + '）\n' +
        '旁白／文案：' + (scene.narration || '') + '\n' +
        '字幕：' + ((voice && voice.subtitle) || scene.subtitle || '') + '\n' +
        (voice ? '配音稿：' + (voice.voiceoverScript || '') + '\n配音語氣：' + (voice.tone || '') + '　語速與停頓：' + (voice.paceNotes || '') + '\n' : '（尚未完成配音與字幕）\n') +
        '畫面意圖：' + (scene.visualIntent || '') + '\n素材需求：' + (scene.materialNeeds || '');
    }).join('\n\n');
}

let lastVideoFileName = '';
function copyVideoFileName() { copyPlainText(lastVideoFileName, '已複製建議檔名'); }

function renderSaveVideo() {
  const work = getActiveWork();
  document.getElementById('save-video-name-input').value = work.name;
  document.getElementById('save-video-url-input').value = '';
  document.getElementById('save-video-note-input').value = '';
  lastVideoFileName = buildSuggestedFileName(work.name, '影片');
  document.getElementById('save-video-filename').textContent = lastVideoFileName;
}
// Sprint 4（完成作品）：使用者存好成果就是「完成」的那一刻，必須清楚感受到，
// 不是丟一個 toast 就跳走——所以這裡改成專屬的「🎉完成作品」畫面，只有兩個出路
// （查看作品／返回專案），不推薦發布/剪輯/字幕等下一步，避免使用者猶豫「還要不要做」。
// Phase 1A 範圍不變更這個決定（是否推薦下一步屬於 Phase 2 的 Open Decision，見全域契約待確認清單），
// 這裡只補齊保存/備份提醒，不新增下一步推薦。
let lastCompletedResultId = null;
function confirmSaveVideo() {
  const work = getActiveWork();
  const project = getProject(work.projectId);
  const flow = FLOWS[work.flowId];
  const stepIdx = flow.steps.findIndex(function (s) { return s.name === '製作影片'; });
  const name = (document.getElementById('save-video-name-input').value || work.name).trim() || work.name;
  const url = (document.getElementById('save-video-url-input').value || '').trim();
  const note = (document.getElementById('save-video-note-input').value || '').trim();
  const content = '影片名稱：' + name + '\n作品網址：' + (url || '（未填寫）') + '\n備註：' + (note || '（無）');
  lastVideoFileName = buildSuggestedFileName(name, '影片');

  const r = makeResult(state, work, project, stepIdx, content, false, '很滿意');
  work.stepResultIds[stepIdx] = r.id;
  // 「製作影片」是影片 Flow 最後一步，MVD 驗收邏輯：完成一支影片即完成工作
  if (isWorkComplete(work, stepIdx)) {
    work.status = '已完成';
    work.completedAt = new Date().toISOString();
    const final = createFinalProduct(state, work, project);
    saveState();
    lastCompletedResultId = final.id;
    showScreen('screen-video-complete');
    return;
  }
  saveState();
  showToast('🎉 第一支影片完成了！');
  showScreen('screen-project');
}

function renderVideoComplete() {
  const work = getActiveWork();
  document.getElementById('vc-name').textContent = work.name;
  document.getElementById('vc-filename').textContent = lastVideoFileName || buildSuggestedFileName(work.name, '影片');
  const sourceLine = document.getElementById('vc-source');
  const typeInfo = VIDEO_TYPES.find(function (t) { return t.id === work.videoType; });
  if (typeInfo) {
    sourceLine.textContent = '來源：' + typeInfo.emoji + ' ' + typeInfo.label;
    sourceLine.style.display = 'block';
  } else {
    sourceLine.style.display = 'none';
  }
}

// ── 完成海報（行銷海報 Production Studio）─────────────────────────
// 跟「製作歌曲」「製作影片」同一套架構：不是 AI 寫文字，是帶著已完成的文案／視覺內容
// 去外部圖片工具動手做出真正的海報成品。海報只有一個工具階段（不像影片分圖片/影片兩段），
// 比照 Song Tool Guide 的完整版型（工具介紹＋步驟＋完成提醒＋開啟工具都直接展開）。
let lastMakePosterCopy = '';
let lastMakePosterVisual = '';
function copyMakePosterCopy() { copyPlainText(lastMakePosterCopy, '已複製海報文案，帶去你的圖片工具吧'); }
function copyMakePosterVisual() { copyPlainText(lastMakePosterVisual, '已複製圖片生成請求與風格建議，帶去你的圖片工具吧'); }

function parsePosterVisualSections(content) {
  const sections = { imageRequest: content || '', style: '' };
  const reqMatch = content && content.match(/【圖片生成請求】([\s\S]*?)(?=【風格建議】|$)/);
  const styleMatch = content && content.match(/【風格建議】([\s\S]*?)$/);
  if (reqMatch && reqMatch[1].trim()) sections.imageRequest = reqMatch[1].trim();
  if (styleMatch && styleMatch[1].trim()) sections.style = styleMatch[1].trim();
  return sections;
}

// rating 是 1-5 的星等，fitFor 是一句話的「適合：」快速判斷（CEO 回饋：初學者不用猜哪個工具比較好）。
const POSTER_TOOL_GUIDE = {
  toolSectionLabel: '🖼️ 建議工具',
  toolName: 'ChatGPT',
  rating: 5,
  fitFor: '第一次做海報、想要最快看到成品',
  toolIntro: '很多人會直接用 ChatGPT 生成海報圖片，操作簡單，內建的圖片功能就能用。',
  toolFeatures: ['文字生成圖片，操作簡單', '可以把文案內容直接寫進圖片裡', '適合第一次製作海報', '不需要額外學設計軟體'],
  altTools: [
    { name: 'Canva', rating: 5, fitFor: '需要精確排版、中文字型、QR Code', reason: '適合需要精確調整繁體中文排版、版面、QR Code 與品牌素材的時候，比生成式圖片工具更好手動微調細節。' },
    { name: 'Gemini', rating: 4, fitFor: '免費額度充足、想多比較幾種風格', reason: '適合圖片發想、想比較不同風格初版，或 ChatGPT 額度用完時的替代選擇。' },
    { name: 'PPT／Google Slides', rating: 4, fitFor: '需要可編輯版面、之後想自己調文字', reason: '適合需要可編輯版面、簡報式海報，或之後想自己調整文字內容時使用。' }
  ],
  steps: [
    '複製海報文案',
    '複製圖片生成請求與風格建議',
    '開啟 ChatGPT',
    '貼上圖片生成請求與風格建議，請它生成海報',
    '看看效果，不滿意可以請它調整或重新生成',
    '滿意後，先在 ChatGPT 下載海報圖片或複製分享連結',
    '回到工作台，按「下一步：確認海報進度」'
  ],
  completionReminder: {
    title: '完成後記得保存',
    items: [
      '想保留在手機或電腦：在 ChatGPT 下載海報圖片。',
      '想傳給朋友或分享到社群：複製圖片分享連結。',
      '完成後回到工作台，按「下一步：確認海報進度」。'
    ]
  },
  firstTimeReminder: '第一次使用不用擔心。照著步驟貼上文字，很快就能看到第一版海報。',
  openToolLabel: '🖼️ 開啟 ChatGPT',
  openToolUrl: 'https://chatgpt.com'
};

// Phase 1A 共用能力收斂（Tool Profile，見 docs/workspace-global-contracts.md 契約三）：
// 三個 Production Studio 的工具指引原本是三個各自獨立的頂層常數，呼叫端各自寫死引用哪一個。
// 收斂成單一 registry 後，renderToolGuide() 的呼叫端統一從這裡取資料，之後新增 Flow 的
// Production Studio 只要在這裡多一個 key，不用再新增一個獨立常數。三個常數本身內容不變，
// 只是從「各自獨立」變成「被收進同一個查詢入口」。
const TOOL_GUIDES = { song: SONG_TOOL_GUIDE, video: VIDEO_TOOL_GUIDE, poster: POSTER_TOOL_GUIDE };

// 版本紀錄小卡（CEO 回饋：海報通常會改很多次，要看得到改過幾次）——不重新做一套版本切換邏輯，
// 直接沿用既有的 getVersionHistory()／openResult()：點一個版本就是連去既有的「成果詳情」畫面看那一版，
// 那裡本來就有完整的版本歷程、打磨、標記最終成品功能，這裡只負責「讓使用者知道改過幾次、可以點進去看」。
function renderPosterVersionChips(containerId, result) {
  const box = document.getElementById(containerId);
  if (!box) return;
  if (!result) { box.innerHTML = ''; return; }
  const versions = getVersionHistory(result);
  if (versions.length <= 1) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="tool-suggest-note">這份內容已經修改過 ' + versions.length + ' 次：</div>' +
    versions.map(function (v, i) {
      const label = (i === versions.length - 1) ? 'v' + v.version + '（目前用這版）' : 'v' + v.version;
      return '<span class="template-pick' + (v.id === result.id ? ' selected' : '') + '" style="display:inline-block;margin:4px 6px 0 0" onclick="openResult(' + v.id + ')">' + label + '</span>';
    }).join('');
}

function renderMakePoster() {
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];
  const copyIdx = flow.steps.findIndex(function (s) { return s.name === '海報文案'; });
  const visualIdx = flow.steps.findIndex(function (s) { return s.name === '視覺設計'; });
  const copyResult = state.results.find(function (r) { return r.id === work.stepResultIds[copyIdx]; });
  const visualResult = state.results.find(function (r) { return r.id === work.stepResultIds[visualIdx]; });
  const sections = parsePosterVisualSections(visualResult ? visualResult.content : '');
  lastMakePosterCopy = copyResult ? copyResult.content : '';
  lastMakePosterVisual = [sections.imageRequest, sections.style].filter(Boolean).join('\n\n');
  renderPosterVersionChips('mp-copy-versions', copyResult);
  renderPosterVersionChips('mp-visual-versions', visualResult);

  document.getElementById('mp-copy-content').textContent = lastMakePosterCopy || '（還沒有海報文案）';
  document.getElementById('mp-image-request-content').textContent = sections.imageRequest || '（還沒有圖片生成請求）';
  document.getElementById('mp-style-content').textContent = sections.style || '（還沒有風格建議）';

  renderToolGuide('mp-tool-guide', 'mp-open-tool-btn', withOfficialRecommendation(TOOL_GUIDES.poster, 'poster', '工程師', '完成海報'));
}

function goPosterConfirm() { showScreen('screen-poster-confirm'); }
// 「我還要重新生成」優先局部修改（CEO 明確要求：不要每次整份重做），接上既有的
// screen-revise-direction／作品打磨模板管線，只是把要修改的成果指向「視覺設計」這一步的結果
// （不是目前站著的「完成海報」步驟），並用 posterRegenerateMode 讓後續導向跳過一般的貼回流程。
function posterConfirmRegenerate() {
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];
  const visualIdx = flow.steps.findIndex(function (s) { return s.name === '視覺設計'; });
  const visualResult = state.results.find(function (r) { return r.id === work.stepResultIds[visualIdx]; });
  if (!visualResult) { showToast('找不到視覺設計內容，請先完成視覺設計這一步'); showScreen('screen-make-poster'); return; }
  lastSubmittedResultId = visualResult.id;
  posterRegenerateMode = true;
  selectedDirections = [];
  showScreen('screen-revise-direction');
}
function posterConfirmLater() {
  showToast('已保存，之後回來可以繼續。');
  showScreen('screen-work-detail');
}
function posterConfirmDone() { showScreen('screen-save-poster'); }

// 建議檔名（CEO 第十一節 11.5）：直接用工作名稱＋日期組字串，不是交給 AI 生成——日期是確定的事實，
// 不需要也不應該讓 AI 用猜的。
function buildSuggestedFileName(name, category) {
  const dateStr = new Date().toISOString().slice(0, 10);
  return (name || '作品') + '_' + category + '_' + dateStr;
}
let lastPosterFileName = '';
function copyPosterFileName() { copyPlainText(lastPosterFileName, '已複製建議檔名'); }

function renderSavePoster() {
  const work = getActiveWork();
  document.getElementById('save-poster-name-input').value = work.name;
  document.getElementById('save-poster-url-input').value = '';
  document.getElementById('save-poster-note-input').value = '';
  lastPosterFileName = buildSuggestedFileName(work.name, '海報');
  document.getElementById('save-poster-filename').textContent = lastPosterFileName;
}
function confirmSavePoster() {
  const work = getActiveWork();
  const project = getProject(work.projectId);
  const flow = FLOWS[work.flowId];
  const stepIdx = flow.steps.findIndex(function (s) { return s.name === '完成海報'; });
  const name = (document.getElementById('save-poster-name-input').value || work.name).trim() || work.name;
  const url = (document.getElementById('save-poster-url-input').value || '').trim();
  const note = (document.getElementById('save-poster-note-input').value || '').trim();
  const content = '海報名稱：' + name + '\n作品網址：' + (url || '（未填寫）') + '\n備註：' + (note || '（無）');
  lastPosterFileName = buildSuggestedFileName(name, '海報');

  const r = makeResult(state, work, project, stepIdx, content, false, '很滿意');
  work.stepResultIds[stepIdx] = r.id;
  // 「完成海報」是行銷海報 Flow 最後一步，只完成一種 Deliverable（海報），完成即完成工作
  if (isWorkComplete(work, stepIdx)) {
    work.status = '已完成';
    work.completedAt = new Date().toISOString();
    const final = createFinalProduct(state, work, project);
    saveState();
    lastCompletedResultId = final.id;
    showScreen('screen-poster-complete');
    return;
  }
  saveState();
  showToast('🎉 第一張海報完成了！');
  showScreen('screen-project');
}

function renderPosterComplete() {
  const work = getActiveWork();
  document.getElementById('pc-name').textContent = work.name;
  document.getElementById('pc-filename').textContent = lastPosterFileName || buildSuggestedFileName(work.name, '海報');
}

// 從「成果詳情」畫面直接進入打磨（例如已經按過「很滿意」，但回頭看又想再調整）
// 只給 renderAssetDetail() 已經確認過「還是目前這一步」的成果呼叫，避免資料錯位
function openPolishFromAsset(resultId) {
  const r = getResult(resultId);
  activeWorkId = r.workId;
  lastSubmittedResultId = r.id;
  selectedDirections = [];
  regenerateDirectionsOverride = null;
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
// 步驟要用「被修改的成果自己的 stepIndex」推算，不能直接用 currentStep(work)——大多數情況兩者相同
// （修改的就是目前正在做的那一步），但「完成海報」重新生成是例外：使用者站在最後一步（完成海報／工程師），
// 實際要修改的內容卻是前一步「視覺設計」的成果，用 currentStep(work) 會讓 step_name／role_name 對不上內容。
// 歌曲重新生成是唯一需要同時參考「兩個」前面步驟成果（歌詞＋音樂風格）的情況——poster／video
// 的重新生成都只對應單一步驟的成果，可以直接沿用 r.stepIndex 推算，歌曲不行，所以獨立处理。
function buildSongRegenerateInstructionText() {
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];
  const lyricsIdx = flow.steps.findIndex(function (s) { return s.name === '歌名＋歌詞'; });
  const styleIdx = flow.steps.findIndex(function (s) { return s.name === '音樂風格'; });
  const lyricsResult = state.results.find(function (r) { return r.id === work.stepResultIds[lyricsIdx]; });
  const styleResult = state.results.find(function (r) { return r.id === work.stepResultIds[styleIdx]; });
  return '你是作品打磨教練。\n\n請根據使用者選擇的修改方向，直接完成修改後的正式版本，這是可以直接使用、貼回同一個對話讓 Suno 重新生成的成果，不是討論。\n\n' +
    '工作：' + (work.songTitle || work.name) + '\n\n' +
    '上一版歌詞：\n' + (lyricsResult ? lyricsResult.content : '（無）') + '\n\n' +
    '上一版音樂風格：\n' + (styleResult ? styleResult.content : '（無）') + '\n\n' +
    '使用者想修改的方向：\n' + selectedDirections.join('、') + '\n\n' +
    '請只修改使用者選擇的部分（例如選「改曲風」就只調整音樂風格，歌詞維持不變；選「改歌詞」就只調整歌詞，音樂風格維持不變；選「改唱腔」通常屬於音樂風格的一部分），完整輸出修改後對應的內容，不要兩者都重寫，也不要省略未修改的那一部分（仍要附上原始內容，方便使用者一次複製）。';
}

function buildRevisionInstruction() {
  if (songRegenerateMode) return buildSongRegenerateInstructionText();
  const work = getActiveWork();
  const flow = FLOWS[work.flowId];
  const r = getResult(lastSubmittedResultId);
  const step = (!r.isBriefDraft && r.stepIndex !== undefined && r.stepIndex >= 0 && flow.steps[r.stepIndex])
    ? flow.steps[r.stepIndex] : currentStep(work);
  const template = resolvePolishTemplate();
  const isBrief = !!r.isBriefDraft;

  const vars = {
    work_name: work.name,
    step_name: isBrief ? '前置討論 Brief' : step.name,
    role_name: isBrief ? (DISCUSS_ROLE_BY_FLOW[work.flowId] || '顧問') : step.role,
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

// 「完成海報」重新生成不走一般的貼回流程（screen-paste-back／submitPasteBack 一律寫回
// work.stepResultIds[work.currentStepIndex]，此時 currentStepIndex 是「完成海報」，會把修改指令
// 誤存進最後一步的成果欄位，蓋掉正確資料）——海報是外部工具產出的圖片，App 本來就不接收貼回的圖片內容，
// 使用者在原本的對話串裡直接請 AI 依修正指令重新生成即可，改完直接回「完成海報」畫面重新確認。
let posterRegenerateMode = false;
// Phase 1A：song／video 的 Production Studio 重新生成比照 poster 同一套「不走一般貼回流程」的理由——
// screen-paste-back／submitPasteBack() 一律寫回 work.stepResultIds[work.currentStepIndex]，
// 此時 currentStepIndex 已經是最後一步（製作歌曲／製作影片），會把修改指令誤存進最後一步的成果欄位。
let songRegenerateMode = false;
let videoImageRegenerateMode = false;
let videoRegenerateMode = false;
function goReviseSubmit() {
  if (posterRegenerateMode) {
    posterRegenerateMode = false;
    regenerateDirectionsOverride = null;
    showToast('好，回到完成海報，在同一個對話裡確認新版本');
    showScreen('screen-make-poster');
    return;
  }
  if (songRegenerateMode) {
    songRegenerateMode = false;
    regenerateDirectionsOverride = null;
    showToast('好，回到製作歌曲，在同一個對話裡確認新版本');
    showScreen('screen-make-song');
    return;
  }
  if (videoImageRegenerateMode) {
    videoImageRegenerateMode = false;
    regenerateDirectionsOverride = null;
    showToast('好，回到製作影片，在同一個對話裡確認新版本');
    showScreen('screen-make-video');
    return;
  }
  if (videoRegenerateMode) {
    videoRegenerateMode = false;
    regenerateDirectionsOverride = null;
    showToast('好，回到製作影片，在同一個對話裡確認新版本');
    showScreen('screen-video-tools');
    return;
  }
  showScreen('screen-paste-back');
}

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

// Workspace Trust Sprint 1（Task 9）：原本這裡是「雲端作品庫」相關函式
// （saveToCloud／updateGasWebhookUrl／openGasInstructions／copyGasCode／GAS_CODE_TEMPLATE）。
// 已整批移除——這些函式從未真正把資料送到任何地方，saveToCloud() 只是切換本地欄位，
// 部署的 GAS 腳本本身也只是 placeholder，卻用「安全且完全私密」的語氣描述，
// 容易讓使用者誤以為已有真正雲端備份。移除比留著誤導性的死程式碼更誠實。

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
// Workspace Trust Sprint 1（Task 2）：匯出＋記錄備份快照，讓 Data Safety Center
// 能顯示「最後備份時間」與「距上次備份新增了幾筆成果」。
// Non-blocking 1（技術長複審）：先更新 lastBackupAt／resultsCountAtLastBackup，
// 再組裝要下載的 blob，這樣下載檔本身就包含「這次備份」的正確時間戳記，
// 不是上一次備份時的舊時間戳記。
function exportData() {
  state.lastBackupAt = new Date().toISOString();
  state.resultsCountAtLastBackup = state.results.length;
  saveState();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = '我的工作台備份.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  render();
  showToast('已匯出，檔案在你的下載資料夾');
}

// 現有陣列裡最大的 id + 1，陣列是空的就從 1 開始——用來在 next*Id 缺漏或不合法時
// 安全重建，保證不會是 undefined／NaN，也不會撞到現有任何一筆資料的 id。
function computeNextId(items) {
  let max = 0;
  items.forEach(function (item) { if (typeof item.id === 'number' && item.id > max) max = item.id; });
  return max + 1;
}

// 共用的備份檔解析／驗證邏輯（Task 5 還原、Task 6 測試備份都呼叫這裡，
// 確保「什麼樣的檔案算有效備份檔」只有一個判斷標準，不會兩邊各自寫一套、之後容易漂移）。
// 只做格式檢查＋安全正規化，不寫入 localStorage——呼叫端自己決定驗證通過後要不要真的覆蓋 state。
//
// Blocking 2（技術長複審修正）：原本只檢查 projects/works/results 是陣列就視為有效，
// 驗證不足，非 Workspace 的 JSON（例如缺 publishRecords 的殘缺檔）可能被誤判成可用備份。
// 現在把 publishRecords 也列入必要結構；並且在通過結構檢查後，立刻安全重算任何缺漏或不合法的
// next*Id（舊版備份可能沒有這些欄位），使用「現有最大 id + 1」，不會是 undefined／NaN，
// 也不會撞號——這個正規化直接寫回 parsed 物件，所以 Recovery Test 跟正式還原看到的都是
// 同一份已經安全的資料，不用兩邊各自處理一次。
function parseBackupFile(rawText) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch (e) { return { valid: false }; }
  if (!parsed || typeof parsed !== 'object'
    || !Array.isArray(parsed.projects) || !Array.isArray(parsed.works)
    || !Array.isArray(parsed.results) || !Array.isArray(parsed.publishRecords)) {
    return { valid: false };
  }
  if (!Number.isInteger(parsed.nextProjectId) || parsed.nextProjectId <= 0) parsed.nextProjectId = computeNextId(parsed.projects);
  if (!Number.isInteger(parsed.nextWorkId) || parsed.nextWorkId <= 0) parsed.nextWorkId = computeNextId(parsed.works);
  if (!Number.isInteger(parsed.nextResultId) || parsed.nextResultId <= 0) parsed.nextResultId = computeNextId(parsed.results);
  if (!Number.isInteger(parsed.nextPublishId) || parsed.nextPublishId <= 0) parsed.nextPublishId = computeNextId(parsed.publishRecords);
  return {
    valid: true,
    data: parsed,
    summary: {
      backedUpAt: parsed.lastBackupAt || null,
      projectCount: parsed.projects.length,
      workCount: parsed.works.length,
      resultCount: parsed.results.length,
      projectNames: parsed.projects.map(function (p) { return p.name; })
    }
  };
}

function readFileAsText(fileInput) {
  return new Promise(function (resolve, reject) {
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) { reject(new Error('no file selected')); return; }
    const reader = new FileReader();
    reader.onload = function (e) { resolve(e.target.result); };
    reader.onerror = function () { reject(new Error('file read error')); };
    reader.readAsText(file);
  });
}

// Task 5：Full Replace Import——整包覆蓋現有 state，不做合併（CEO 已核准的策略，
// 理由見 Proposal：這是單裝置救回，不是多裝置資料合併，合併需要處理每種 entity 的
// ID 重新對應，超出這次範圍）。還原前必須明確二次確認，說清楚「會完全覆蓋」。
function importDataFile(fileInput) {
  readFileAsText(fileInput).then(function (rawText) {
    const result = parseBackupFile(rawText);
    fileInput.value = '';
    if (!result.valid) {
      showToast('匯入失敗，請確認選的是本工作台匯出的備份檔');
      return;
    }
    const s = result.summary;
    const confirmed = confirm(
      '這會用備份檔內容「完全覆蓋」這台裝置目前的所有資料，此動作無法復原。\n\n' +
      '備份檔內容：' + s.projectCount + ' 個專案・' + s.workCount + ' 件工作・' + s.resultCount + ' 筆成果\n\n' +
      '確定要繼續嗎？'
    );
    if (!confirmed) return;
    // Blocking 3（技術長複審修正）：Full Replace 前先留住目前記憶體中的 state，
    // 寫入 localStorage 真的成功才顯示「已還原資料」；失敗時（例如裝置空間不足）
    // 把記憶體中的 state 復原成還原前的內容並重新渲染畫面，不能留下「畫面已經是
    // 新資料、但重新整理後又變回舊資料」這種不一致狀態，也不能在寫入失敗時仍回報成功。
    const previousState = state;
    state = result.data;
    ensureNewFields(state);
    const saved = saveState();
    if (!saved) {
      state = previousState;
      render();
      showToast('還原失敗，裝置儲存空間可能不足，原有資料未被取代。');
      return;
    }
    showScreen('screen-home');
    showToast('已還原資料');
  }).catch(function () {
    fileInput.value = '';
    showToast('匯入失敗，請確認選的是本工作台匯出的備份檔');
  });
}

// Task 6：Recovery Test（測試我的備份檔）——只解析驗證，全程不寫入 state，
// 讓使用者在真的需要還原之前，就能先確認「這份備份檔真的可以用」。
function testBackupFile(fileInput) {
  readFileAsText(fileInput).then(function (rawText) {
    const result = parseBackupFile(rawText);
    fileInput.value = '';
    renderRecoveryTestResult(result);
  }).catch(function () {
    fileInput.value = '';
    renderRecoveryTestResult({ valid: false });
  });
}

function renderRecoveryTestResult(result) {
  const box = document.getElementById('dsc-recovery-test-result');
  if (!box) return;
  if (!result.valid) {
    box.innerHTML = '<div class="notice" style="border-color:var(--red)">⚠️ 這個檔案看起來不是有效的備份檔。<br>你目前的資料完全沒有被更動。</div>';
    return;
  }
  const s = result.summary;
  box.innerHTML = '<div class="notice" style="border-color:var(--green-soft)">' +
    '✅ 這份備份檔案有效<br>' +
    (s.backedUpAt ? '備份時間：' + formatDateTime(s.backedUpAt) + '<br>' : '') +
    '包含：' + s.projectCount + ' 個專案・' + s.workCount + ' 件工作・' + s.resultCount + ' 筆成果' +
    (s.projectNames.length ? '<br>專案：' + s.projectNames.map(escHtml).join('、') : '') +
    '<br><br>這只是測試，你目前的資料完全沒有被更動。' +
    '</div>';
}

// ── 渲染 ──────────────────────────────────────────────────────
function render() {
  const active = document.querySelector('.screen.active');
  if (!active) return;
  const id = active.id;
  if (id === 'screen-home') renderHome();
  if (id === 'screen-data-safety-center') renderDataSafetyCenter();
  if (id === 'screen-cloud-restore-preview') renderDriveRestorePreview();
  if (id === 'screen-cloud-version-choice') renderDriveVersionChoice();
  if (id === 'screen-project') renderProject();
  if (id === 'screen-add-work') renderAddWork();
  if (id === 'screen-product-category') renderProductCategory();
  if (id === 'screen-work-detail') renderWorkDetail();
  if (id === 'screen-brief-choice') renderBriefChoice();
  if (id === 'screen-brief-direct-form') renderBriefDirectForm();
  if (id === 'screen-brief-direct-confirm') renderBriefDirectConfirm();
  if (id === 'screen-copy-to-ai') renderCopyToAi();
  if (id === 'screen-paste-back') renderPasteBack();
  if (id === 'screen-satisfaction') renderSatisfaction();
  if (id === 'screen-make-song') renderMakeSong();
  if (id === 'screen-save-song') renderSaveSong();
  if (id === 'screen-song-next') renderSongNext();
  if (id === 'screen-make-video') renderMakeVideo();
  if (id === 'screen-video-tools') renderVideoTools();
  if (id === 'screen-tool-companion') renderToolCompanion();
  if (id === 'screen-video-handoff') renderVideoHandoff();
  if (id === 'screen-scene-regenerate') renderSceneRegenerate();
  if (id === 'screen-save-video') renderSaveVideo();
  if (id === 'screen-video-complete') renderVideoComplete();
  if (id === 'screen-make-poster') renderMakePoster();
  if (id === 'screen-save-poster') renderSavePoster();
  if (id === 'screen-poster-complete') renderPosterComplete();
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
  if (id === 'screen-preferred-ai-onboarding') renderOnboardingAi();
  if (id === 'screen-my-ai') renderMyAiList();
  if (id === 'screen-add-my-ai') renderAddMyAi();
}

function renderHome() {
  document.getElementById('home-greeting').textContent = greetPrefix() + '，' + state.userName + ' ' + (greetPrefix() === '晚安' ? '🌙' : '☀️');

  renderHomeDataSafetySummary();

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
  const recentAsset = state.results.filter(function (r) { return r.projectId === project.id && !r.isBriefDraft && !r.isMasterScriptDraft && !r.isVoiceoverDraft; }).slice(-1)[0];

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

// ── 資料安全（Workspace Trust Sprint 1）─────────────────────────

// Task 10：事件驅動備份提醒，取代固定天數。兩個訊號都是從既有資料即時算出來的，
// 不需要另外新增一個「事件系統」去監聽每個完成動作——這正是 Over-Engineering
// Self-Check 的「能用現有內容/欄位算出來，就不要新增架構」。
// 訊號 A（完成重要作品）：任一 isFinal 成果的完成時間晚於上次備份時間
//（從未備份過時，只要存在任何 isFinal 成果就算）。
// 訊號 B（大量新增內容）：目前 results 總數比上次備份時多出達門檻（5 筆）。
const BACKUP_REMINDER_THRESHOLD = 5;
function backupReminderStatus() {
  const hasNewFinal = state.results.some(function (r) {
    return r.isFinal && (!state.lastBackupAt || new Date(r.completedAt) > new Date(state.lastBackupAt));
  });
  const newCount = state.results.length - state.resultsCountAtLastBackup;
  const hasBulkNew = newCount >= BACKUP_REMINDER_THRESHOLD;
  if (!hasNewFinal && !hasBulkNew) return { show: false };
  if (hasNewFinal) return { show: true, reason: '你剛完成了一件作品，建議備份一下' };
  return { show: true, reason: '自從上次備份後，新增了 ' + newCount + ' 筆成果' };
}

function openDataSafetyCenter() { showScreen('screen-data-safety-center'); }

// 真人驗收發現：上方摘要（首頁卡片／資料安全中心狀態列）原本只讀 state.lastBackupAt
// （只有本機 JSON 匯出 exportData() 會寫入這個欄位），跟下方 Google Drive 區塊讀的
// state.driveLastBackupAt（只有 finishDriveBackupSuccess() 會寫入）是兩個完全獨立的
// 欄位——使用者只做過 Google Drive 備份、從未按過本機「⬇️ 立即備份」時，上方就會一直
// 顯示「從未備份過」，即使下方雲端區塊明明顯示著雲端備份時間，兩處互相矛盾。
// 這裡取兩個來源裡「時間較新」的一筆，並清楚標示是哪一種備份（不再用含義不明的
// 「最後備份」），只有兩邊都沒有任何紀錄時才顯示「從未備份過」。
function mostRecentBackupInfo() {
  const local = state.lastBackupAt ? { at: state.lastBackupAt, label: '本機備份' } : null;
  const drive = state.driveLastBackupAt ? { at: state.driveLastBackupAt, label: 'Google Drive 備份' } : null;
  if (!local && !drive) return null;
  if (local && !drive) return local;
  if (drive && !local) return drive;
  return new Date(local.at).getTime() >= new Date(drive.at).getTime() ? local : drive;
}

function renderHomeDataSafetySummary() {
  const box = document.getElementById('home-data-safety-summary');
  if (!box) return;
  const reminder = backupReminderStatus();
  const mostRecent = mostRecentBackupInfo();
  const lastBackupLine = mostRecent
    ? '最後備份（' + mostRecent.label + '）：' + formatRelativeTime(mostRecent.at)
    : '從未備份過';
  box.innerHTML = '<div class="line">資料儲存在：這台裝置（瀏覽器本機）</div>' +
    '<div class="line">' + lastBackupLine + '　｜　' + state.projects.length + ' 個專案・' + state.works.length + ' 件工作・' + state.results.length + ' 筆成果</div>' +
    (reminder.show ? '<div class="line" style="color:var(--red)">⚠️ ' + escHtml(reminder.reason) + '</div>' : '') +
    '<div class="line" style="color:var(--green-soft);font-weight:700">前往資料安全中心 →</div>';
}

function renderDataSafetyCenter() {
  const reminder = backupReminderStatus();
  const statusBox = document.getElementById('dsc-backup-status');
  const statusLines = [];
  if (state.lastBackupAt) {
    statusLines.push('本機備份：' + formatDateTime(state.lastBackupAt) + '（' + formatRelativeTime(state.lastBackupAt) + '）');
  }
  if (state.driveLastBackupAt) {
    statusLines.push('Google Drive 最後備份：' + formatDateTime(state.driveLastBackupAt) + '（' + formatRelativeTime(state.driveLastBackupAt) + '）');
  }
  if (statusLines.length > 0) {
    statusBox.innerHTML = statusLines.join('<br>') +
      (reminder.show ? '<br><span style="color:var(--red)">⚠️ ' + escHtml(reminder.reason) + '</span>' : '');
  } else {
    statusBox.innerHTML = '<span style="color:var(--red)">⚠️ 從未備份過</span>';
  }
  document.getElementById('dsc-stats').textContent = state.projects.length + ' 個專案・' + state.works.length + ' 件工作・' + state.results.length + ' 筆成果';
  // 每次進入畫面清空上一次的測試結果，避免使用者看到不是這次選的檔案的驗證結果
  const testResultBox = document.getElementById('dsc-recovery-test-result');
  if (testResultBox) testResultBox.innerHTML = '';
  renderDriveBackupSection();
}

// ── Google Drive Backup MVP ───────────────────────────────────
// 「使用者主動備份與復原」，不是背景自動同步。所有動作都由使用者點擊觸發，
// 沒有任何背景排程、沒有靜默 OAuth。CEO 核准方案 A：drive.appdata（App 專屬隱藏
// 資料夾，讀不到使用者 Drive 裡其他檔案）＋ openid/email（只用來顯示「目前連接哪個
// 帳號」，程式邏輯一律用 sub 做穩定比對，email 只是給人看的標籤）。
//
// ⚠️ DRIVE_CLIENT_ID 目前是佔位字串，需要由人在 Google Cloud Console 建立正式
// OAuth Client ID（設定 Authorized JavaScript origins 為正式網址、完成 OAuth 同意
// 畫面與隱私權政策連結）後才能真正運作——這一步需要人工登入 Google Cloud Console
// 操作，開發長無法自己建立，見實作計畫「風險」一節。程式碼在這之前已經是完整可運作的
// 邏輯，只差這一個設定值。
const DRIVE_CLIENT_ID = '1055556462623-r90lii2j4abjf3r2vrttmvgt384mkl64.apps.googleusercontent.com';
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email openid';
const DRIVE_BACKUP_FILENAME_CURRENT = 'workspace-backup-current.json';
const DRIVE_BACKUP_FILENAME_PREVIOUS = 'workspace-backup-previous.json';
const DRIVE_HOURLY_LIMIT = 6;   // CEO 核准：每小時最多 6 次「成功」備份
const DRIVE_DAILY_LIMIT = 30;   // CEO 核准：每日最多 30 次「成功」備份，失敗重試不計入
const PRE_RESTORE_SNAPSHOT_KEY = STORAGE_KEY + '_pre_restore_snapshot';
const PRE_RESTORE_SNAPSHOT_RETENTION_DAYS = 14; // CEO 核准：復原成功後保留 14 天，逾期自動清除

// Token 只存在頁面記憶體（POC 已驗證的既有結論），重新整理就會消失，不寫進
// localStorage／state——避免把敏感憑證留在裝置的持久化儲存裡。
let driveAccessToken = null;
let activeDriveOperation = null; // null｜'backup'｜'restore'，備份/復原互斥鎖（R9）
// 復原流程從「找到雲端備份」到「使用者實際確認」中間隔著一個畫面／一次使用者互動，
// 不是同一條 Promise 鏈能一路串到底，所以用這個模組層級變數暫存待確認的復原內容，
// 使用者確認或取消後就清空，避免殘留舊資料被誤用。
let pendingDriveRestoreContext = null;

// ── GIS（Google Identity Services）載入與 Token 取得 ──
function isGisLoaded() { return typeof window !== 'undefined' && window.google && window.google.accounts && window.google.accounts.oauth2; }

// error_callback 收到的是 GIS 層級的錯誤物件（{ type: 'popup_closed' | 'popup_failed_to_open' | ... }），
// 跟 callback 的 resp.error（OAuth 層級的錯誤字串，例如 access_denied）是兩種不同來源，
// 呼叫端（showDriveError）需要分開判斷才能給使用者正確、不誇大的訊息。
function classifyGisError(gisError) {
  const type = gisError && gisError.type;
  if (type === 'popup_closed') return { type: 'popup_closed' };
  if (type === 'popup_failed_to_open') return { type: 'popup_failed_to_open' };
  return { type: 'gis_error', reason: type || 'unknown' };
}

// let（不是 const）：正式環境維持 2 分鐘不變，只是刻意讓自動測試可以在頁面內把這個值
// 改小，才能在測試裡用真實（但很短）的等待時間驗證逾時行為，不需要真的等 2 分鐘，
// 也不用依賴 fake timer 工具去猜測跟這個版本相容與否。
let DRIVE_AUTH_TIMEOUT_MS = 120000; // 2 分鐘：足夠使用者完成帳號選擇／輸入密碼／兩步驟驗證，但不會無限期卡住

// 每次都帶 prompt:'select_account'（CEO 明確要求保留）：使用者每次授權都會看到
// Google 原生帳號選擇畫面，不會悄悄沿用瀏覽器已登入的帳號，這是目前技術上能做到的
// 「不增加身分範圍也能防呆」的部分（見實作計畫第六節 Q2）。
//
// 補正（技術長退回第三次：timeout 後遲發的 GIS callback 可能污染下一次請求）：
// 原本的設計用一個 singleton token client（driveTokenClient，跨所有呼叫共用同一個
// 物件），每次呼叫 requestDriveAccessToken() 都動態覆寫這個共用物件的
// callback／error_callback，並用一個全域遞增的 requestId 跟閉包內的 settled 旗標
// 判斷「這個事件還算不算數」。這個設計對「同一次請求收到重複事件」是有效的，但擋不住
// 一個更根本的問題：GIS 內部沒有請求識別碼，事後觸發回呼時，只會呼叫「當下掛在這個
// client 物件上」的那個函式。如果請求 A 逾時放棄後，請求 B 緊接著開始，B 呼叫
// requestAccessToken() 時會把 client.callback／error_callback 換成 B 自己的閉包——
// 這時如果 A 那個已經放棄的 Google 帳號選擇視窗才終於觸發事件，GIS 實際呼叫到的會是
// 「現在掛在 client 上」的 B 的閉包，不是 A 的。B 的閉包只看得到自己的 requestId
// 剛好等於目前最新值（因為 B 就是最新的），會誤判成「這是我自己等到的結果」，讓 A
// 已經放棄的流程污染 B 的請求（例如把 A 那邊使用者選的帳號，誤植成 B 的 token）。
// 修正：不再共用單一個 client 物件。每次呼叫都用 initTokenClient() 建立一個全新、
// 專屬於這次請求的 client，callback／error_callback 在建立當下就直接綁定在這次
// 請求自己的閉包裡，之後永遠不會被其他請求覆寫。這樣不管 GIS 事後多晚才觸發事件，
// physically 只可能呼叫到「當初建立那個 client 時」綁定的那個閉包——A 的事件不管
// 多晚才來，永遠只會進到 A 自己的閉包，A 自己的 settled 旗標會擋下（因為 A 早就
// 已經因為逾時而 settled），完全不可能誤觸到 B 的閉包，也就不再需要、也不應該再用
// 「跟全域序號比對是否為最新」這種判斷方式（那正是問題根源：它假設事件一定屬於目前
// 最新的請求，但現在每次請求有自己獨立、不共用的 client，這個假設不再必要）。
function requestDriveAccessToken() {
  return new Promise(function (resolve, reject) {
    if (!isGisLoaded()) { reject({ type: 'gis_not_loaded' }); return; }

    let settled = false;
    let timeoutId;

    let client;
    try {
      client = window.google.accounts.oauth2.initTokenClient({
        client_id: DRIVE_CLIENT_ID,
        scope: DRIVE_SCOPES,
        callback: function (resp) {
          if (settled) return; // 這次請求自己已經 settle 過（例如已經逾時放棄），忽略遲到的事件
          clearTimeout(timeoutId);
          if (resp && resp.error) {
            // OAuth 層級錯誤（例如使用者在同意畫面按「取消」＝access_denied）：
            // 不代表永久失敗，只回報這次沒有拿到 token，交由呼叫端決定要不要提示重試。
            settled = true;
            reject({ type: 'oauth_error', reason: resp.error });
            return;
          }
          settled = true;
          driveAccessToken = resp.access_token;
          resolve(resp.access_token);
        },
        error_callback: function (gisError) {
          if (settled) return;
          clearTimeout(timeoutId);
          settled = true;
          reject(classifyGisError(gisError));
        }
      });
    } catch (e) { reject({ type: 'gis_not_loaded' }); return; }

    timeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject({ type: 'auth_timeout' });
    }, DRIVE_AUTH_TIMEOUT_MS);

    try {
      client.requestAccessToken({ prompt: 'select_account' });
    } catch (e) {
      // requestAccessToken() 本身同步拋出例外（極少見，例如 client_id 設定錯誤）：
      // 直接視為這次請求失敗，同樣要讓 Promise settle，不留下永遠不 resolve 的鎖。
      if (!settled) { clearTimeout(timeoutId); settled = true; reject({ type: 'gis_not_loaded' }); }
    }
  });
}

// 只用最小必要 scope 換取的 access token 呼叫 userinfo，取得 { email, sub }。
// sub 是內部穩定識別碼，email 只是顯示標籤（CEO 核准方案 A，見實作計畫第六節）。
function fetchDriveAccountInfo(accessToken) {
  return fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + accessToken }
  }).then(function (res) {
    if (!res.ok) throw { type: 'account_info_failed', status: res.status };
    return res.json();
  }).then(function (info) {
    return { email: info.email || null, sub: info.sub || null };
  });
}

// ── 操作互斥鎖（R9：快速連點不產生重複操作；備份/復原進行中禁用重複操作）──
function isDriveOperationBusy() { return activeDriveOperation !== null; }
function withDriveOperationLock(kind, fn) {
  if (activeDriveOperation) {
    showToast('目前有備份／復原正在進行中，請稍候。');
    return Promise.resolve();
  }
  activeDriveOperation = kind;
  renderDriveBackupSection();
  return Promise.resolve().then(fn).finally(function () {
    activeDriveOperation = null;
    renderDriveBackupSection();
  });
}

// ── 備份節流（CEO 核准：每小時 6 次／每日 30 次，只計算成功備份，失敗重試不計）──
function pruneOldBackupTimestamps() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  state.driveBackupTimestamps = (state.driveBackupTimestamps || []).filter(function (t) { return new Date(t).getTime() >= cutoff; });
}
function driveBackupRateStatus() {
  pruneOldBackupTimestamps();
  const now = Date.now();
  const hourAgo = now - 3600 * 1000;
  const hourlyCount = state.driveBackupTimestamps.filter(function (t) { return new Date(t).getTime() >= hourAgo; }).length;
  const dailyCount = state.driveBackupTimestamps.length; // 陣列已經只保留 24 小時內的紀錄
  return {
    hourlyCount: hourlyCount,
    dailyCount: dailyCount,
    hourlyLimitReached: hourlyCount >= DRIVE_HOURLY_LIMIT,
    dailyLimitReached: dailyCount >= DRIVE_DAILY_LIMIT,
    canBackupNow: hourlyCount < DRIVE_HOURLY_LIMIT && dailyCount < DRIVE_DAILY_LIMIT
  };
}
function recordSuccessfulDriveBackup() {
  state.driveBackupTimestamps.push(new Date().toISOString());
  pruneOldBackupTimestamps();
  saveState();
}

// ── 重試與截尾指數退避（R15：403/429/暫時性錯誤重試，401/權限錯誤不重試）──
function isRetryableDriveError(err) {
  if (err && err.type === 'network_error') return true;
  const status = err && err.status;
  if (status === 429) return true;
  if (status === 403) {
    const reason = err.reason || '';
    return reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded';
  }
  return false;
}
function withDriveRetry(fn, maxAttempts, onRetrying) {
  maxAttempts = maxAttempts || 5;
  let attempt = 0;
  function attemptOnce() {
    attempt += 1;
    return Promise.resolve().then(fn).catch(function (err) {
      if (attempt >= maxAttempts || !isRetryableDriveError(err)) throw err;
      const delayMs = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
      if (onRetrying) onRetrying(attempt, delayMs);
      return new Promise(function (resolve) { setTimeout(resolve, delayMs); }).then(attemptOnce);
    });
  }
  return attemptOnce();
}

// ── Drive API（v3，appDataFolder，最小權限）──
function driveApiRequest(url, options, accessToken) {
  const opts = Object.assign({}, options, {
    headers: Object.assign({}, (options && options.headers) || {}, { Authorization: 'Bearer ' + accessToken })
  });
  return fetch(url, opts).then(function (res) {
    if (res.ok) return res;
    return res.json().catch(function () { return {}; }).then(function (body) {
      const reason = body && body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason;
      const err = { type: 'drive_api_error', status: res.status, reason: reason };
      throw err;
    });
  }).catch(function (err) {
    if (err && err.type) throw err;
    throw { type: 'network_error' }; // fetch 本身拋出（離線／逾時），不是 Drive API 回應的錯誤
  });
}

function driveFindFileByName(name, accessToken) {
  const q = encodeURIComponent("name='" + name + "' and trashed=false");
  const url = 'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=' + q + '&fields=files(id,name)';
  return driveApiRequest(url, { method: 'GET' }, accessToken).then(function (res) { return res.json(); }).then(function (data) {
    return (data.files && data.files[0]) || null;
  });
}

function driveDownloadFile(fileId, accessToken) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + fileId + '?alt=media';
  return driveApiRequest(url, { method: 'GET' }, accessToken).then(function (res) { return res.text(); });
}

// 有 fileId 就用 files.update（PATCH，內容用 uploadType=media），沒有就用 files.create
// （POST，multipart，metadata 指定 parents:['appDataFolder']）——固定 file id 更新，
// 呼應 POC 已驗證「更新同一份備份、id 不變、不產生重複檔案」的行為。
function driveUploadOrUpdate(name, content, accessToken, existingFileId) {
  if (existingFileId) {
    const url = 'https://www.googleapis.com/upload/drive/v3/files/' + existingFileId + '?uploadType=media';
    return driveApiRequest(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content }, accessToken)
      .then(function (res) { return res.json(); });
  }
  const boundary = 'gdrivebackup' + Date.now();
  const metadata = { name: name, parents: ['appDataFolder'] };
  const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
    '\r\n--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + content + '\r\n--' + boundary + '--';
  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  return driveApiRequest(url, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body }, accessToken)
    .then(function (res) { return res.json(); });
}

// 補正（技術長退回第三次：舊雲端備份相容）：判斷一個值是不是「可以拿來當備份時間用」
// 的合法時間字串——缺漏（undefined）、null、空字串、或無法解析成合法日期，都算不合法。
// 用在復原舊格式雲端備份、接續舊格式殘留輪替狀態時，判斷要不要用其他來源補值。
function isValidTimestampString(v) {
  return typeof v === 'string' && v.length > 0 && !isNaN(new Date(v).getTime());
}

// ── 雲端備份payload 結構與驗證（現況 MVP：schemaVersion＋摘要層級資料＋完整 state）──
// 真人驗收發現：這裡原本直接內嵌目前的 state（含目前的 state.driveLastBackupAt，
// 也就是「上一次」備份的時間，不是「這一次」），因為 finishDriveBackupSuccess()
// 要等上傳＋驗證都成功後才會把 driveLastBackupAt 更新成這次的時間——這個順序完全
// 正確（不能在還沒確定成功前就更新本機狀態），但也代表每次上傳的雲端快照裡，
// state.driveLastBackupAt 永遠是「上一次」的舊值（第一次備份時甚至是 null）。
// 別人拿這份快照去做跨裝置復原時，套用進去的 state.driveLastBackupAt 就會是這個
// 舊值／null，導致復原後資料安全中心仍可能顯示「從未備份過」。
// 修正：呼叫端傳入「這次備份萬一成功後，即將寫入本機的時間」（pendingDriveLastBackupAt，
// 跟 finishDriveBackupSuccess() 最終真正寫入的時間用同一個值），這裡只在「要內嵌進
// payload 的那份 state 副本」覆蓋這個欄位，不影響、不提前更動真正的 state 物件本身
// ——本機 state.driveLastBackupAt 仍然只有在 finishDriveBackupSuccess() 確認成功
// 之後才會更新，失敗時完全不受影響。
function buildCloudBackupPayload(pendingDriveLastBackupAt) {
  const stateForPayload = pendingDriveLastBackupAt
    ? Object.assign({}, state, { driveLastBackupAt: pendingDriveLastBackupAt })
    : state;
  return JSON.stringify({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    backupType: 'google-drive',
    createdAt: new Date().toISOString(),
    summary: {
      projectCount: state.projects.length,
      workCount: state.works.length,
      resultCount: state.results.length
    },
    state: stateForPayload
  });
}

// 跟 parseBackupFile() 共用「必要陣列存在」的核心判斷，但額外多驗證外層信封
// （schemaVersion／summary／state）——雲端備份payload 比本機 JSON 匯出多一層包裝。
function parseCloudBackupPayload(rawText) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch (e) { return { valid: false }; }
  if (!parsed || typeof parsed !== 'object' || !parsed.state || !parsed.summary
    || !Array.isArray(parsed.state.projects) || !Array.isArray(parsed.state.works)
    || !Array.isArray(parsed.state.results) || !Array.isArray(parsed.state.publishRecords)) {
    return { valid: false };
  }
  return { valid: true, data: parsed, summary: parsed.summary, createdAt: parsed.createdAt };
}

// ── 帳號防呆（CEO 核准：切換帳號後找不到備份不得直接建立或覆蓋，必須先提醒）──
function isDifferentDriveAccount(accountInfo) {
  return !!(state.driveAccountSub && accountInfo.sub && state.driveAccountSub !== accountInfo.sub);
}

// ── 本機安全快照（單一格，不無限累積；14 天保存期限；CEO 核准規則）──
function createPreRestoreSnapshot() {
  const snapshot = { createdAt: new Date().toISOString(), state: state };
  try { localStorage.setItem(PRE_RESTORE_SNAPSHOT_KEY, JSON.stringify(snapshot)); return true; }
  catch (e) { return false; }
}
function getPreRestoreSnapshot() {
  const raw = localStorage.getItem(PRE_RESTORE_SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    const snapshot = JSON.parse(raw);
    if (!snapshot || !snapshot.createdAt || !snapshot.state) return null;
    return snapshot;
  } catch (e) { return null; }
}
function isPreRestoreSnapshotExpired(snapshot) {
  const ageMs = Date.now() - new Date(snapshot.createdAt).getTime();
  return ageMs > PRE_RESTORE_SNAPSHOT_RETENTION_DAYS * 24 * 3600 * 1000;
}
function clearPreRestoreSnapshot() { localStorage.removeItem(PRE_RESTORE_SNAPSHOT_KEY); }
// 逾期自動清除：只在讀取時檢查並清掉，不需要背景排程（沿用「不做背景自動同步」的既有原則，
// 過期判斷跟一般 UI 渲染一樣，使用者下次打開畫面時才會被動觸發檢查）。
function pruneExpiredPreRestoreSnapshot() {
  const snapshot = getPreRestoreSnapshot();
  if (snapshot && isPreRestoreSnapshotExpired(snapshot)) clearPreRestoreSnapshot();
}
// 清除前必須確認「目前資料已成功載入且通過完整性驗證」（CEO 核准規則）：
// 只要目前 state 本身是透過既有 ensureNewFields() 正常載入（loadState() 不是走
// 資料損毀分支），就視為已通過完整性驗證，不需要另外重新解析一次。
function canClearPreRestoreSnapshot() { return !dataCorruptionDetected; }

// ── iPhone 預期管理（偵測到就顯示清楚提示，取代按鈕，不宣稱支援也不讓功能默默失效）──
function isIphoneDevice() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPod/.test(ua);
}

// ── 備份主流程（current/previous 輪替＋完整性驗證，R4/R6）──
function startDriveBackup() {
  return withDriveOperationLock('backup', function () {
    const rate = driveBackupRateStatus();
    if (!rate.canBackupNow) {
      showToast(rate.dailyLimitReached
        ? '今天的備份次數已達上限（每日 ' + DRIVE_DAILY_LIMIT + ' 次），請明天再試。'
        : '這一小時的備份次數已達上限（每小時 ' + DRIVE_HOURLY_LIMIT + ' 次），請稍後再試。');
      return;
    }
    return withDriveRetry(function () {
      return requestDriveAccessToken().then(function (token) {
        return fetchDriveAccountInfo(token).then(function (accountInfo) {
          if (isDifferentDriveAccount(accountInfo)) {
            renderDriveAccountMismatchNotice(accountInfo, 'backup');
            return null; // 交由使用者在提示畫面決定，先不繼續備份
          }
          return performDriveBackupUpload(token, accountInfo);
        });
      });
    }, 5, function (attempt, delayMs) {
      showToast('連線不穩，正在重試…（第 ' + attempt + ' 次）');
    }).catch(function (err) {
      showDriveError(err, '備份失敗，請稍後再試。你的資料沒有遺失，仍安全保存在這台裝置。');
    });
  });
}

// ── 補正一（技術長第三次複審更正用詞）：可恢復式輪替（recoverable rotation）
//   current/previous ──────────────────────────────────────────────
//
// 重要更正：這裡刻意不再稱為「交易式」（transactional）保證。Google Drive API
// 沒有「同時替換兩個檔案」的原子操作，files.update 是逐檔獨立的 HTTP 請求，
// 沒有辦法保證「previous 寫入」跟「current 寫入」這兩步要嘛都成功、要嘛都不生效——
// 這不符合「transactional」這個詞在資料庫領域的實際定義（all-or-nothing、
// 具備真正的原子性），繼續用這個詞會誤導技術長與 CEO 對安全等級的判斷，因此改稱
// 「可恢復式輪替」：意思是「輪替中斷後，系統知道怎麼安全地把它接續做完」，
// 而不是「輪替過程本身具備原子性」。
//
// 這裡能做到、也確實做到的保證：
//   1. current.json 只有在「新內容已經完整上傳＋下載回來驗證通過」之後才會被取代，
//      讀取 current.json 的人永遠看到完整有效的舊版或新版，不會看到部分寫入的內容。
//   2. 任何一步失敗，都會把「已經確認完成到哪一步、需要哪些資料才能接續」持久寫進
//      localStorage（DRIVE_BACKUP_ROTATION_STATE_KEY），下次備份或還原前會先檢查
//      並嘗試安全地把上次沒做完的輪替接續完成（用完全相同的內容重新上傳，
//      files.update 對同樣內容重複寫入是安全的，不會造成任何資料落差）。
//
// 誠實揭露的最壞情況（technical lead 需要知道、不能被「可恢復」這個詞蓋過去）：
//   a. 中斷發生在「previous 寫入完成之後、current 寫入完成之前」：previous.json
//      這時已經等於「輪替前的 current 內容」，不是「輪替前的原始 previous 內容」——
//      也就是說 previous 事實上已經跟 current（舊值）相同，不是真正獨立的
//      「上一份」備份，直到下次接續完成輪替為止。
//   b. current.json 在這個中繼狀態下維持舊內容不變，尚未變成使用者這次真正要備份
//      的新內容——如果使用者這時去查看雲端備份，看到的還是舊資料。
//   c. 「下次自動接續」完全依賴同一台裝置、同一個瀏覽器的 localStorage 還留著
//      DRIVE_BACKUP_ROTATION_STATE_KEY 這筆紀錄。如果使用者換了裝置、清除了瀏覽器
//      資料、或瀏覽器設定為無痕/不保留資料，這個接續資訊就不存在了——輪替會停在
//      中繼狀態，不會自動修復，只有使用者下次在「同一台裝置、同一個瀏覽器」執行
//      備份時才會被接續。
//   d. 因此這不是資料庫等級的「transactional guarantee」，而是「local-device-assisted
//      recoverable rotation」：可恢復，但恢復能力綁定在單一裝置的本機儲存上。
//
// 是否該把這筆輪替接續紀錄也同步到 Drive 端（例如另存一個 staging 檔），讓恢復能力
// 不必依賴單一裝置？評估後的建議是「暫不實作」，原因：
//   - current.json 本身在任何中斷點都不會是損毀或半寫入內容（見保證 1），所以就算
//     這筆本機接續紀錄永久遺失，最壞後果只是「這次備份沒有完整輪替成功，previous
//      暫時跟 current 舊值相同」，使用者只要在任何裝置上重新執行一次備份，
//      performDriveBackupUpload 會重新走一次完整流程（重新下載 current、
//      重新分辨要不要建立新的輪替），系統會自我修復，不會累積損壞。
//   - 加上 Drive 端 staging 檔會多一組跨檔案一致性問題要處理（staging 檔本身要不要
//     也做同樣的可恢復寫入？誰來清除過期的 staging 檔？），複雜度的增加沒有對應到
//     實際風險的降低——因為就算不接續，系統下次備份仍會自我修復，不會卡死。
//   - 這是本回合的建議、非最終定案，實際是否需要視技術長是否認為「單一裝置恢復」
//     的安全等級不足以滿足 MVP 上線標準而定。
const DRIVE_BACKUP_ROTATION_STATE_KEY = STORAGE_KEY + '_drive_backup_rotation';

function writeDriveRotationState(fields) {
  try { localStorage.setItem(DRIVE_BACKUP_ROTATION_STATE_KEY, JSON.stringify(Object.assign({ updatedAt: new Date().toISOString() }, fields))); return true; }
  catch (e) { return false; }
}
function readDriveRotationState() {
  const raw = localStorage.getItem(DRIVE_BACKUP_ROTATION_STATE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function clearDriveRotationState() { localStorage.removeItem(DRIVE_BACKUP_ROTATION_STATE_KEY); }

function performDriveBackupUpload(token, accountInfo) {
  // 這次備份萬一成功，本機最終會寫入的時間——跟內嵌進雲端快照的 driveLastBackupAt
  // 用同一個值（見 buildCloudBackupPayload() 說明），確保「這份快照裡記載的備份時間」
  // 就是「這次備份完成的時間」，不是上一次的舊值。resumeDriveRotation 走的是接續上次
  // 中斷的輪替，沿用上次持久記錄裡的 pendingBackupAt（見下方），不是這裡重新產生的值。
  const pendingBackupAt = new Date().toISOString();
  // 每次備份前，先檢查上次是否有沒做完的輪替殘留，優先安全接續完成，
  // 不會因為使用者又按了一次「立即備份」就丟掉上次卡住的接續資訊、另起爐灶。
  const leftover = readDriveRotationState();
  if (leftover && leftover.phase) {
    return resumeDriveRotation(leftover, token, accountInfo);
  }
  return driveFindFileByName(DRIVE_BACKUP_FILENAME_CURRENT, token).then(function (currentFile) {
    if (!currentFile) {
      // 第一次備份，沒有舊 current 可以搬去 previous，不需要輪替，
      // 直接寫入 current；這一步失敗，current 本來就不存在，不會有「改變原 current」的問題。
      return uploadAndVerify(DRIVE_BACKUP_FILENAME_CURRENT, buildCloudBackupPayload(pendingBackupAt), token, null, true).then(function () {
        finishDriveBackupSuccess(accountInfo, pendingBackupAt);
      });
    }
    return driveDownloadFile(currentFile.id, token).then(function (oldCurrentContent) {
      return driveFindFileByName(DRIVE_BACKUP_FILENAME_PREVIOUS, token).then(function (previousFile) {
        const newContent = buildCloudBackupPayload(pendingBackupAt);
        // 在真的動 previous 之前，先把「接續這次輪替需要的全部資訊」持久記錄下來——
        // 這一步本身若失敗（例如裝置空間不足），直接中止，current／previous 都完全
        //還沒被碰過，是最安全的失敗點。
        const stateWritten = writeDriveRotationState({
          phase: 'writing_previous',
          oldCurrentContent: oldCurrentContent,
          newContent: newContent,
          currentFileId: currentFile.id,
          previousFileId: previousFile && previousFile.id,
          pendingBackupAt: pendingBackupAt
        });
        if (!stateWritten) throw { type: 'rotation_state_write_failed' };
        return continueDriveRotationFromWritingPrevious(token, accountInfo);
      });
    });
  });
}

// 從「開始寫 previous」這一步往下執行——不論是全新輪替、還是接續上次中斷的輪替，
// 都走同一條路徑，因為需要的資訊（oldCurrentContent／newContent／file id）已經
// 持久記錄在 DRIVE_BACKUP_ROTATION_STATE_KEY 裡，讀出來就能接續，不需要重新下載。
function continueDriveRotationFromWritingPrevious(token, accountInfo) {
  const rotation = readDriveRotationState();
  return uploadAndVerify(DRIVE_BACKUP_FILENAME_PREVIOUS, rotation.oldCurrentContent, token, rotation.previousFileId, false)
    .then(function (previousFileMeta) {
      writeDriveRotationState(Object.assign({}, rotation, { phase: 'writing_current', previousFileId: previousFileMeta.id }));
      return continueDriveRotationFromWritingCurrent(token, accountInfo);
    });
}

// 補正（技術長退回第三次：舊 rotation state 接續後的雲端 current 快照）：接續一筆
// 「這一輪修正之前」留下的殘留輪替狀態時，rotation.pendingBackupAt 可能完全不存在
// （那時候還沒有這個欄位），rotation.newContent 內嵌的 state.driveLastBackupAt 也
// 可能缺漏／為 null（那時候 buildCloudBackupPayload() 還沒有補這個欄位）。如果直接
// 原樣上傳，即使本機這次事後把 driveLastBackupAt 更新對了，實際上傳到雲端的
// current.json 內嵌值仍然是空的——下一台裝置復原這份快照時，還是會顯示「從未備份過」，
// 這是只修好本機畫面、卻留下錯誤雲端快照的半套修正，不能接受。
// 在真正上傳 current 之前，依序嘗試找出一個可驗證、非憑空捏造的時間來源，需要時才
// 補進 newContent 內嵌的 state.driveLastBackupAt（已經合法就完全不覆蓋）：
//   1. rotation.pendingBackupAt——這一輪修正後才有的欄位，本來就合法就直接用。
//   2. newContent 自己的頂層 createdAt——buildCloudBackupPayload() 一律會寫這個
//      欄位，代表「這份雲端內容當初是什麼時候組出來的」，新舊版都有，是最可靠的來源。
//   3. rotation.updatedAt——writeDriveRotationState() 每次寫入都一定會有，代表
//      「這筆殘留輪替紀錄最後一次被更新的時間」，是最後一道防線，正常情況下用不到，
//      因為前兩個來源理論上至少會有一個存在。
// 回傳的 pendingBackupAt 也會拿去更新本機 state.driveLastBackupAt（見下方呼叫處），
// 確保「本機記錄的備份時間」跟「這次真正上傳到雲端 current.json 裡的值」永遠一致。
// 補正（技術長最終複審：損壞 rotation state 必須 fail safe）：三個時間來源
// （pendingBackupAt／newContent 的 createdAt／rotation.updatedAt）都缺漏或不合法時，
// 原本會 fallback 成 new Date().toISOString()——這等於替一筆真假都無法證明的殘留
// 狀態背書，讓使用者以為這是一次「剛剛發生」的成功備份，但實際上完全無法確認這份
// 內容是什麼時候產生的。這種情況下唯一誠實、安全的做法是整個接續流程直接失敗：
// 不上傳、不清除 rotation state、不更新本機 driveLastBackupAt、不增加備份次數、
// 不顯示成功——這裡改成拋出明確、可辨識的錯誤（invalid_rotation_backup_time），
// 讓呼叫端整個中止，保留原始殘留狀態方便之後人工診斷或安全處理。
function ensureRotationContentHasValidDriveLastBackupAt(rotation) {
  let parsed;
  try { parsed = JSON.parse(rotation.newContent); } catch (e) { parsed = null; }
  const embedded = parsed && parsed.state && parsed.state.driveLastBackupAt;
  if (isValidTimestampString(embedded)) {
    // 已經是合法時間，不覆蓋——不管是這一輪修正後正常寫入的，還是巧合本來就有效。
    const pendingBackupAt = isValidTimestampString(rotation.pendingBackupAt) ? rotation.pendingBackupAt : embedded;
    return { content: rotation.newContent, pendingBackupAt: pendingBackupAt };
  }
  const derivedAt = (isValidTimestampString(rotation.pendingBackupAt) && rotation.pendingBackupAt)
    || (parsed && isValidTimestampString(parsed.createdAt) && parsed.createdAt)
    || (isValidTimestampString(rotation.updatedAt) && rotation.updatedAt)
    || null;
  if (!derivedAt) {
    // 三個來源全部無效：不得用 new Date() 捏造時間，直接視為這筆殘留輪替狀態已經
    // 損壞到無法安全接續，中止整個流程（見上方說明）。
    throw { type: 'invalid_rotation_backup_time' };
  }
  if (!parsed || !parsed.state) {
    // newContent 本身格式異常（理論上不會發生）：這裡沒辦法安全補值，原樣傳回，
    // 交由 uploadAndVerify() 之後的雲端格式驗證判斷是否失敗——這是既有機制已經涵蓋
    // 的另一種失敗，不屬於這次「備份時間無法證明」的 fail-safe 範圍。
    return { content: rotation.newContent, pendingBackupAt: derivedAt };
  }
  parsed.state.driveLastBackupAt = derivedAt;
  return { content: JSON.stringify(parsed), pendingBackupAt: derivedAt };
}

function continueDriveRotationFromWritingCurrent(token, accountInfo) {
  const rotation = readDriveRotationState();
  const prepared = ensureRotationContentHasValidDriveLastBackupAt(rotation);
  return uploadAndVerify(DRIVE_BACKUP_FILENAME_CURRENT, prepared.content, token, rotation.currentFileId, true)
    .then(function () {
      clearDriveRotationState();
      finishDriveBackupSuccess(accountInfo, prepared.pendingBackupAt);
    });
}

// 接續上次中斷的輪替：依殘留的 phase 決定要從哪一步繼續，用的是持久記錄裡「一模一樣」
// 的 oldCurrentContent／newContent，不會因為「這次重新產生的備份內容」跟「上次中斷時
// 的內容」不一致而讓 previous／current 錯配。
function resumeDriveRotation(rotation, token, accountInfo) {
  if (rotation.phase === 'writing_previous') return continueDriveRotationFromWritingPrevious(token, accountInfo);
  if (rotation.phase === 'writing_current') return continueDriveRotationFromWritingCurrent(token, accountInfo);
  // 未知的殘留狀態，保守起見清掉，不嘗試接續（避免用不明內容誤寫檔案）
  clearDriveRotationState();
  return Promise.reject({ type: 'rotation_state_unknown' });
}

// content 一律傳明確字串（不再用 null 隱含「這次重新產生」，因為輪替接續時必須用
// 持久記錄裡當初的內容，不能每次呼叫都重新產生一份不同的內容）。
// isCurrentFile 決定驗證方式：current.json 驗證「內容是不是有效的雲端備份格式」，
// previous.json 驗證「內容是不是跟原本要搬過去的內容逐字相同」。
// 上傳後立即下載回來比對，通過才算「完成寫入及完整性驗證」（CEO 明確要求）。
function uploadAndVerify(filename, content, token, existingFileId, isCurrentFile) {
  return driveUploadOrUpdate(filename, content, token, existingFileId).then(function (fileMeta) {
    return driveDownloadFile(fileMeta.id, token).then(function (downloaded) {
      const parsedOk = isCurrentFile ? parseCloudBackupPayload(downloaded).valid : (downloaded === content);
      if (!parsedOk) throw { type: 'verify_failed', filename: filename };
      return fileMeta;
    });
  });
}

// pendingBackupAt：跟這次上傳的雲端快照內嵌的 driveLastBackupAt 用同一個值（見
// buildCloudBackupPayload()／performDriveBackupUpload() 說明），確保本機記錄的
// 「這次備份時間」跟雲端快照裡記載的完全一致。沒有傳入時（理論上不會發生，保留
// 純粹是防呆）才退回用當下時間，避免留下 undefined。
function finishDriveBackupSuccess(accountInfo, pendingBackupAt) {
  state.driveAccountEmail = accountInfo.email;
  state.driveAccountSub = accountInfo.sub;
  state.driveLastBackupAt = pendingBackupAt || new Date().toISOString();
  recordSuccessfulDriveBackup();
  render();
  showToast('已備份到 Google Drive（' + formatDateTime(state.driveLastBackupAt) + '）');
}

// ── 復原主流程（R1-R3/R5/R10-R13）──
function startDriveRestore() {
  return withDriveOperationLock('restore', function () {
    return withDriveRetry(function () {
      return requestDriveAccessToken().then(function (token) {
        return fetchDriveAccountInfo(token).then(function (accountInfo) {
          // 帳號防呆順序（CEO 核准）：先確認是不是跟上次不同的帳號，才決定要不要繼續找
          // 備份——appDataFolder 本來就是依帳號各自獨立隔離，換帳號後「找不到備份」跟
          // 「這個帳號本來就沒備份過」表面上長得一樣，但語意不同，必須先攔下來讓使用者
          // 自己決定，不能直接當成「第一次使用」帶過。
          if (isDifferentDriveAccount(accountInfo)) {
            renderDriveAccountMismatchNotice(accountInfo, 'restore');
            return;
          }
          return driveFindFileByName(DRIVE_BACKUP_FILENAME_CURRENT, token).then(function (currentFile) {
            if (!currentFile) {
              renderDriveNoBackupFound(accountInfo);
              return;
            }
            return driveDownloadFile(currentFile.id, token).then(function (raw) {
              const parsed = parseCloudBackupPayload(raw);
              if (!parsed.valid) { showToast('雲端備份內容看起來已損壞，無法還原。你目前的資料完全沒有被更動。'); return; }
              const localHasData = state.projects.length > 0 || state.works.length > 0 || state.results.length > 0;
              pendingDriveRestoreContext = { parsed: parsed, accountInfo: accountInfo, token: token, cloudFileId: currentFile.id };
              // showScreen() 本身會觸發 render() 再呼叫一次對應的 render 函式（既有 dispatcher
              // 機制），這裡不需要在 showScreen() 之前手動先呼叫一次 renderDriveVersionChoice()／
              // renderDriveRestorePreview()——那樣反而會呼叫兩次，且兩個 render 函式已改為
              // 不自己呼叫 showScreen()，需要由這裡明確指定要切去哪個畫面。
              showScreen(localHasData ? 'screen-cloud-version-choice' : 'screen-cloud-restore-preview');
            });
          });
        });
      });
    }, 5, function (attempt, delayMs) {
      showToast('連線不穩，正在重試…（第 ' + attempt + ' 次）');
    }).catch(function (err) {
      showDriveError(err, '無法連接到你的 Google Drive，請稍後再試。');
    });
  });
}

// 使用者在預覽畫面確認後才呼叫——先建立本機安全快照，快照本身也要驗證存得下去
// 才繼續，寫入失敗就中止，不繼續套用還原（本機資料完全未變動）。
// 供「還原預覽」與「選擇要使用的資料版本，使用雲端版本」兩個畫面共用——語意上是
// 同一件事（用雲端內容覆蓋本機），只是觸發情境不同，都從 pendingDriveRestoreContext 取資料。
//
// ── 補正二（技術長第三次複審修正）：跨頁面中斷的復原保護，修正中斷縫隙 ──
// 原本的設計有一個真實縫隙：saveState() 成功寫入雲端資料之後、writeRestoreTransaction
// ('cloud_state_applied') 執行之前，如果頁面被關閉或重新整理，下次啟動讀到的交易階段
// 還停在 'snapshot_created'，但主 state 其實已經被替換成雲端資料了——舊版
// checkAndRecoverIncompleteRestoreTransaction() 看到 'snapshot_created' 會誤判成
// 「主資料還沒被換掉」而直接清除交易紀錄，導致未經驗證的雲端資料被悄悄保留下來，
// 也失去了自動回復的機會。
//
// 修正方式：交易紀錄不再只依賴「階段名稱」判斷，而是額外持久化這次交易「預期套用後
// 的資料指紋」（expectedFingerprint，在真正呼叫 saveState() 之前就先寫入，比階段名稱
// 更早），啟動恢復時一律比對「目前主資料的指紋」跟「交易紀錄裡的預期指紋」是否相符，
// 不再假設某個階段名稱等於資料沒被換過——階段名稱只是輔助資訊，指紋比對才是真正的
// 判斷依據。
const RESTORE_TRANSACTION_KEY = STORAGE_KEY + '_restore_transaction';

function writeRestoreTransaction(phase, extra) {
  try { localStorage.setItem(RESTORE_TRANSACTION_KEY, JSON.stringify(Object.assign({ phase: phase, updatedAt: new Date().toISOString() }, extra || {}))); return true; }
  catch (e) { return false; }
}
function readRestoreTransaction() {
  const raw = localStorage.getItem(RESTORE_TRANSACTION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function clearRestoreTransaction() { localStorage.removeItem(RESTORE_TRANSACTION_KEY); }

// 簡單、確定性的雜湊（不需要密碼學等級強度，只需要能可靠比對「現在載入的這份 state，
// 是不是這次交易原本要套用的那份」），避免直接用整份 JSON 字串比對（沒必要在
// localStorage 裡重複存一份完整內容當指紋，浪費空間）。
function computeStateFingerprint(s) {
  const json = JSON.stringify(s);
  let hash = 0;
  for (let i = 0; i < json.length; i++) { hash = ((hash << 5) - hash + json.charCodeAt(i)) | 0; }
  return 'len' + json.length + '_h' + hash;
}

// 跟 parseBackupFile／parseCloudBackupPayload 用同一套「必要陣列存在」標準，
// 這裡直接檢查已經載入記憶體的 state 物件本身（不是重新解析 raw text）。
function isStateStructurallyValid(s) {
  return !!(s && typeof s === 'object'
    && Array.isArray(s.projects) && Array.isArray(s.works)
    && Array.isArray(s.results) && Array.isArray(s.publishRecords));
}

function confirmApplyDriveRestore() {
  const ctx = pendingDriveRestoreContext;
  if (!ctx) return;
  const transactionId = 'restore-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  writeRestoreTransaction('pending', { transactionId: transactionId });
  const snapshotOk = createPreRestoreSnapshot();
  if (!snapshotOk) {
    clearRestoreTransaction();
    showToast('無法建立還原前的安全快照（裝置空間可能不足），已取消還原，本機資料未變動。');
    return;
  }
  writeRestoreTransaction('snapshot_created', { transactionId: transactionId });
  const previousState = state;
  const newState = ctx.parsed.data.state;
  ensureNewFields(newState);
  newState.driveAccountEmail = ctx.accountInfo.email;
  newState.driveAccountSub = ctx.accountInfo.sub;
  // 補正（技術長退回第三次：舊雲端備份相容）：舊版 buildCloudBackupPayload() 沒有內嵌
  // driveLastBackupAt（或內嵌的是「上一次」的舊值／null，見上方說明），這裡拿這份雲端
  // payload 本身的 createdAt（上傳當下組出這份內容的時間，parseCloudBackupPayload()
  // 已經解析出來放在 ctx.parsed.createdAt）補上，避免復原後主資料裡的
  // driveLastBackupAt 是空的，導致「剛復原成功」跟「資料安全中心／Google Drive 區塊
  // 仍顯示從未備份過」互相矛盾。必須在下面計算 fingerprint 之前完成——這樣「這次還原
  // 真正套用的內容」跟拿去驗證、之後拿去比對的指紋才會是同一份，順序上不能顛倒。
  // 只在 driveLastBackupAt 缺漏／null／不是合法時間時才補，已經有合法值的新版備份
  // 不受影響、不覆蓋。
  if (!isValidTimestampString(newState.driveLastBackupAt) && isValidTimestampString(ctx.parsed.createdAt)) {
    newState.driveLastBackupAt = ctx.parsed.createdAt;
  }
  // 關鍵修正：在真正呼叫 saveState() 之前，先把「即將套用的這份資料」的指紋持久寫下來
  // （phase='applying'）。這一步比 saveState() 更早，所以即使 saveState() 成功後、
  // 下一行 phase 推進之前就中斷，這個 expectedFingerprint 也已經確實存在，
  // 啟動恢復時才能可靠比對「主資料是不是已經被換成這份」。
  const expectedFingerprint = computeStateFingerprint(newState);
  const stateWritten = writeRestoreTransaction('applying', { transactionId: transactionId, expectedFingerprint: expectedFingerprint });
  if (!stateWritten) {
    showToast('無法記錄還原交易狀態（裝置空間可能不足），已取消還原，本機資料未變動。');
    return;
  }
  state = newState;
  const saved = saveState();
  if (!saved) {
    state = previousState;
    clearRestoreTransaction();
    render();
    showToast('還原失敗，裝置儲存空間可能不足，原有資料未被取代。');
    return;
  }
  // 這一行寫入之後，如果頁面在這裡被關閉或重新整理，下次啟動時
  // checkAndRecoverIncompleteRestoreTransaction() 會比對指紋發現主資料其實已經換過了
  // （即使階段名稱還停在 'applying'），自動重新驗證、驗證失敗才回復安全快照。
  writeRestoreTransaction('cloud_state_applied', { transactionId: transactionId, expectedFingerprint: expectedFingerprint });
  if (!isStateStructurallyValid(state)) {
    revertToPreRestoreSnapshotInternal('復原後的資料驗證失敗，已自動回復到還原前的狀態。');
    return;
  }
  writeRestoreTransaction('validation_completed', { transactionId: transactionId, expectedFingerprint: expectedFingerprint });
  clearRestoreTransaction();
  pendingDriveRestoreContext = null;
  showScreen('screen-home');
  showToast('已從 Google Drive 還原資料（還原前的資料已自動保留 14 天，可在資料安全中心復原或清除）');
}

// 回復到還原前的安全快照。修正（技術長第三次複審）：saveState() 的回傳值現在會被
// 檢查——失敗時絕對不能清除交易紀錄、也不能宣稱「已自動回復」，否則會製造「畫面說
// 已經回復、但實際上主資料還是剛才有問題的內容」這種比原本更糟的假象。失敗時交易
// 紀錄保留，讓使用者知道問題還沒解決，可以之後手動處理（例如清空間後重新整理）。
// 也處理「連安全快照本身都不存在」這種更少見的情況，誠實告知而不是靜默什麼都不做。
function revertToPreRestoreSnapshotInternal(message) {
  const snapshot = getPreRestoreSnapshot();
  if (!snapshot) {
    render();
    showToast('偵測到還原異常，但找不到還原前的安全快照可以回復，請檢查資料是否正常，或改用本機備份還原。');
    return;
  }
  state = snapshot.state;
  ensureNewFields(state);
  const saved = saveState();
  if (!saved) {
    render();
    showToast('偵測到還原異常，嘗試自動回復時失敗（裝置空間可能不足）。目前資料狀態可能不一致，請手動處理或改用本機備份還原。');
    return; // 交易紀錄刻意不清除，保留線索
  }
  clearRestoreTransaction();
  render();
  showToast(message);
}

// App 啟動時檢查（在 loadState() 之後呼叫）：若上一次的復原交易沒有走到
// validation_completed 就中斷了（頁面關閉／重新整理／當機），一律用指紋比對判斷，
// 不再假設某個階段名稱代表主資料有沒有被換過：
//   - 沒有 expectedFingerprint（連 'applying' 階段都沒走到）：主資料確定沒被換掉，
//     只清掉殘留紀錄即可。
//   - 有 expectedFingerprint：比對目前主資料的指紋——
//       相符 → 雲端資料確實已經套用進主 key，重新驗證結構是否完整，完整就正常結案，
//              不完整就回復安全快照。
//       不相符 → 雲端資料其實還沒真的套用進主 key（例如卡在 saveState() 呼叫之前就
//              中斷），主資料仍是原本的內容，安全，只清掉殘留紀錄。
function checkAndRecoverIncompleteRestoreTransaction() {
  const txn = readRestoreTransaction();
  if (!txn) return;
  if (!txn.expectedFingerprint) {
    clearRestoreTransaction();
    return;
  }
  const currentFingerprint = computeStateFingerprint(state);
  if (currentFingerprint !== txn.expectedFingerprint) {
    // 主資料的指紋跟這筆交易預期套用的內容不符，代表 saveState() 那一步根本沒有
    // 真的發生過（中斷點在更早之前），本機資料維持原狀，安全，只需要清掉殘留紀錄。
    clearRestoreTransaction();
    return;
  }
  // 指紋相符：主資料確實已經是這筆交易要套用的雲端內容，不論階段名稱停在哪裡，
  // 都要重新驗證，不能假設「階段名稱看起來還沒完成」就代表資料沒事。
  if (isStateStructurallyValid(state)) { clearRestoreTransaction(); return; }
  revertToPreRestoreSnapshotInternal('偵測到上次的 Google Drive 還原沒有正常完成，已自動回復到還原前的狀態。');
}

function cancelDriveRestorePreview() { pendingDriveRestoreContext = null; showScreen('screen-data-safety-center'); }

// ── 錯誤呈現（區分需要重新授權 vs 一般失敗，見狀態機第四節）──
// 補正（技術長退回）：使用者主動關閉 Google 登入視窗，或視窗被瀏覽器擋下無法開啟，
// 都是使用者可以理解、可以馬上再試一次的情況，不是「備份失敗／資料損壞／權限永久
// 失效／系統嚴重錯誤」，訊息用詞要誠實反映這一點，不誇大也不嚇人。
function showDriveError(err, fallbackMessage) {
  if (err && err.type === 'gis_not_loaded') { showToast('Google 服務載入失敗，請檢查網路連線後重新整理。'); return; }
  if (err && err.type === 'popup_closed') { showToast('Google 登入視窗已關閉，這次操作尚未完成。你可以稍後再試一次。'); return; }
  if (err && err.type === 'popup_failed_to_open') { showToast('無法開啟 Google 登入視窗，請確認瀏覽器沒有封鎖快顯視窗後再試一次。'); return; }
  // 這裡刻意用「這次操作沒有完成」這種操作中性的說法（跟 popup_closed 用同一種語氣），
  // 因為 requestDriveAccessToken() 同時被備份／復原兩種流程呼叫——寫死「沒有建立備份」
  // 這種只適用備份情境的字眼，會在使用者其實是在嘗試復原時顯示不合語意的訊息。
  if (err && err.type === 'auth_timeout') { showToast('尚未完成 Google 授權，這次操作沒有完成，請重新嘗試。'); return; }
  if (err && err.type === 'oauth_error') { showToast('尚未完成 Google 帳號授權，可以再試一次。'); return; }
  if (err && err.type === 'gis_error') { showToast('這次操作尚未完成，可以稍後再試一次。'); return; }
  // 殘留輪替狀態損壞到無法證明備份時間（見 ensureRotationContentHasValidDriveLastBackupAt()）：
  // 誠實告知「這次沒有建立備份」，不宣稱失敗原因是使用者操作，也不宣稱資料損壞（本機資料
  // 本身完全沒有被更動），單純是這筆殘留的雲端輪替紀錄目前沒辦法安全接續。
  if (err && err.type === 'invalid_rotation_backup_time') { showToast('偵測到未完成的雲端備份資料異常，本次沒有建立備份，請重新嘗試。'); return; }
  if (err && (err.status === 401 || (err.status === 403 && err.reason !== 'rateLimitExceeded' && err.reason !== 'userRateLimitExceeded'))) {
    showToast('Google Drive 連線已過期或權限不足，請重新連接。');
    return;
  }
  showToast(fallbackMessage);
}

// ── Google Drive Backup 畫面 ───────────────────────────────────

// Data Safety Center 裡「☁️ Google Drive 備份」區塊——跟既有本機 JSON 區塊視覺上明確
// 分開（見任務書「本機備援並存」要求），iPhone 裝置直接顯示提示取代按鈕，不宣稱支援
// 也不讓功能默默失效。
function renderDriveBackupSection() {
  const box = document.getElementById('dsc-drive-backup-section');
  if (!box) return;
  if (isIphoneDevice()) {
    box.innerHTML = '<div class="section-label">☁️ Google Drive 備份</div>' +
      '<div class="notice">Google Drive 備份目前支援電腦 Chrome 與 Android；iPhone 仍在測試中。<br>你仍可以使用上方「匯出我的資料」保存在這台裝置。</div>';
    return;
  }
  const rate = driveBackupRateStatus();
  const busy = isDriveOperationBusy();
  const accountLine = state.driveAccountEmail
    ? '目前連接帳號：' + escHtml(state.driveAccountEmail)
    : '尚未連接 Google Drive';
  const lastBackupLine = state.driveLastBackupAt
    ? '雲端最後備份：' + formatDateTime(state.driveLastBackupAt) + '（' + formatRelativeTime(state.driveLastBackupAt) + '）'
    : '尚未備份到雲端過';
  const rateLine = (rate.hourlyLimitReached || rate.dailyLimitReached)
    ? '<div class="line" style="color:var(--red)">⚠️ ' + (rate.dailyLimitReached ? '今天的備份次數已達上限（' + DRIVE_DAILY_LIMIT + ' 次）' : '這一小時的備份次數已達上限（' + DRIVE_HOURLY_LIMIT + ' 次）') + '</div>'
    : (rate.hourlyCount > 0 ? '<div class="line">今天已備份 ' + rate.dailyCount + ' 次（每小時上限 ' + DRIVE_HOURLY_LIMIT + '，每日上限 ' + DRIVE_DAILY_LIMIT + '）</div>' : '');
  const snapshot = getPreRestoreSnapshot();
  const snapshotBlock = snapshot ? renderPreRestoreSnapshotBlock(snapshot) : '';
  box.innerHTML = '<div class="section-label">☁️ Google Drive 備份</div>' +
    '<div class="card"><div class="line">' + accountLine + '</div><div class="line">' + lastBackupLine + '</div>' + rateLine + '</div>' +
    '<button class="btn" style="margin-top:10px" ' + (busy ? 'disabled' : '') + ' onclick="startDriveBackup()">' + (activeDriveOperation === 'backup' ? '⏳ 備份中…' : '☁️ 備份到 Google Drive') + '</button>' +
    '<button class="btn outline" style="margin-top:10px" ' + (busy ? 'disabled' : '') + ' onclick="startDriveRestore()">' + (activeDriveOperation === 'restore' ? '⏳ 讀取中…' : '☁️ 從 Google Drive 復原') + '</button>' +
    snapshotBlock;
}

function renderPreRestoreSnapshotBlock(snapshot) {
  return '<div class="notice" style="margin-top:10px">' +
    '上一次還原前，已自動保留一份本機安全快照（' + formatDateTime(snapshot.createdAt) + '），將保留 14 天。<br><br>' +
    '<button class="btn outline" onclick="restoreFromPreRestoreSnapshotAction()">回復到還原前的狀態</button>' +
    '<button class="btn outline" style="margin-top:8px" onclick="clearPreRestoreSnapshotAction()">立即清除</button>' +
    '</div>';
}

function restoreFromPreRestoreSnapshotAction() {
  const snapshot = getPreRestoreSnapshot();
  if (!snapshot) return;
  if (!confirm('確定要回復到還原前的狀態嗎？這會覆蓋掉你剛剛還原／使用雲端版本後的內容。')) return;
  state = snapshot.state;
  ensureNewFields(state);
  const saved = saveState();
  if (!saved) { showToast('回復失敗，裝置儲存空間可能不足。'); return; }
  clearPreRestoreSnapshot();
  render();
  showToast('已回復到還原前的狀態');
}

function clearPreRestoreSnapshotAction() {
  if (!canClearPreRestoreSnapshot()) { showToast('目前資料狀態異常，暫時無法清除安全快照。'); return; }
  if (!confirm('確定要清除還原前保留的安全快照嗎？清除後將無法再回復到還原前的狀態。')) return;
  clearPreRestoreSnapshot();
  render();
  showToast('已清除安全快照');
}

// 找到雲端備份、本機目前沒什麼資料好保護時的簡單預覽（單一主要動作）
// 注意：這個函式只負責把資料填進畫面，不呼叫 showScreen() 切到自己這個畫面——
// 這個函式本身已經被登記在 render() 的дispatcher 裡（畫面啟用時會自動呼叫一次），
// 如果函式內又呼叫 showScreen('screen-cloud-restore-preview')，會變成
// render() → renderDriveRestorePreview() → showScreen() → render() → ... 的無窮遞迴
//（實際測試時發現過這個問題，已修正）。呼叫端（startDriveRestore()）負責先準備好
// pendingDriveRestoreContext 再呼叫 showScreen() 切換過來。
function renderDriveRestorePreview() {
  const ctx = pendingDriveRestoreContext;
  if (!ctx) { showScreen('screen-data-safety-center'); return; }
  const s = ctx.parsed.summary;
  document.getElementById('cdrp-account').textContent = ctx.accountInfo.email || '（無法顯示帳號）';
  document.getElementById('cdrp-summary').innerHTML =
    '備份時間：' + (ctx.parsed.createdAt ? formatDateTime(ctx.parsed.createdAt) : '未知') + '<br>' +
    '內容：' + s.projectCount + ' 個專案・' + s.workCount + ' 件工作・' + s.resultCount + ' 筆成果';
}

// 補正三：這裡原本叫「雲端版本較新」，但程式邏輯只檢查「本機是否已有資料」，
// 完全沒有比較過雲端與本機兩邊的實際時間或內容，沒有根據可以宣稱雲端「比較新」。
// 這次 MVP 不做複雜的雙邊時間/版本比對，改用中性名稱與文案：只誠實顯示「雲端備份
// 時間」與「這台裝置最後備份時間」兩者的摘要，讓使用者自己判斷要用哪一份，
// 不替使用者做「哪個比較新」這個沒有根據的判斷。
// 注意：同樣不呼叫 showScreen() 切到自己這個畫面，理由跟 renderDriveRestorePreview() 一樣
//（避免跟 render() dispatcher 形成無窮遞迴，實測時發現過）。呼叫端負責切換畫面。
function renderDriveVersionChoice() {
  const ctx = pendingDriveRestoreContext;
  if (!ctx) { showScreen('screen-data-safety-center'); return; }
  const s = ctx.parsed.summary;
  document.getElementById('cvc-account').textContent = ctx.accountInfo.email || '（無法顯示帳號）';
  document.getElementById('cvc-cloud-summary').innerHTML =
    '雲端備份時間：' + (ctx.parsed.createdAt ? formatDateTime(ctx.parsed.createdAt) : '未知') + '<br>' +
    '雲端：' + s.projectCount + ' 個專案・' + s.workCount + ' 件工作・' + s.resultCount + ' 筆成果';
  document.getElementById('cvc-local-summary').innerHTML =
    '這台裝置最後備份：' + (state.driveLastBackupAt ? formatDateTime(state.driveLastBackupAt) : '尚未備份過') + '<br>' +
    '這台裝置：' + state.projects.length + ' 個專案・' + state.works.length + ' 件工作・' + state.results.length + ' 筆成果';
}

function keepLocalVersionInstead() { pendingDriveRestoreContext = null; showScreen('screen-data-safety-center'); showToast('已保留這台裝置目前的資料，沒有變動。'); }

// 找不到雲端備份：三個明確出口，不得只顯示「沒有備份資料」（任務書明確要求）
function renderDriveNoBackupFound(accountInfo) {
  pendingDriveRestoreContext = { accountInfo: accountInfo };
  document.getElementById('cnbf-account').textContent = accountInfo.email || '（無法顯示帳號）';
  showScreen('screen-cloud-no-backup-found');
}

function createFirstCloudBackupNow() {
  const accountInfo = pendingDriveRestoreContext && pendingDriveRestoreContext.accountInfo;
  pendingDriveRestoreContext = null;
  showScreen('screen-data-safety-center');
  if (accountInfo) { state.driveAccountEmail = accountInfo.email; state.driveAccountSub = accountInfo.sub; }
  startDriveBackup();
}

function reselectDriveAccount() {
  pendingDriveRestoreContext = null;
  driveAccessToken = null;
  showScreen('screen-data-safety-center');
  startDriveRestore();
}

function useLocalImportInstead() {
  pendingDriveRestoreContext = null;
  showScreen('screen-data-safety-center');
  document.getElementById('dsc-restore-file-input').click();
}

// 帳號切換防呆：偵測到跟上次不同的帳號，先提醒，不直接建立或覆蓋（CEO 核准規則）
function renderDriveAccountMismatchNotice(accountInfo, context) {
  pendingDriveRestoreContext = { accountInfo: accountInfo, mismatchContext: context };
  document.getElementById('cam-previous-account').textContent = state.driveAccountEmail || '（先前未記錄帳號）';
  document.getElementById('cam-new-account').textContent = accountInfo.email || '（無法顯示帳號）';
  document.getElementById('cam-context-hint').textContent = context === 'backup'
    ? '你正要備份到這個新帳號。'
    : '你正要從這個新帳號還原。';
  showScreen('screen-cloud-account-mismatch');
}

function proceedWithNewDriveAccount() {
  const ctx = pendingDriveRestoreContext;
  if (!ctx) return;
  const mismatchContext = ctx.mismatchContext;
  const accountInfo = ctx.accountInfo;
  pendingDriveRestoreContext = null;
  state.driveAccountEmail = accountInfo.email;
  state.driveAccountSub = accountInfo.sub;
  saveState();
  showScreen('screen-data-safety-center');
  if (mismatchContext === 'backup') { startDriveBackup(); } else { startDriveRestore(); }
}

function cancelDriveAccountSwitch() { pendingDriveRestoreContext = null; showScreen('screen-data-safety-center'); }

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

  const videoTypeField = document.getElementById('video-type-field');
  if (pendingFlowId === 'video') {
    videoTypeField.style.display = 'block';
    document.getElementById('video-type-list').innerHTML = VIDEO_TYPES.map(function (t) {
      const sel = t.id === selectedVideoType ? ' selected' : '';
      return '<div class="template-pick' + sel + '" onclick="chooseVideoType(\'' + t.id + '\')">' + t.emoji + ' ' + t.label + '</div>';
    }).join('');
  } else {
    videoTypeField.style.display = 'none';
  }

  // 歌曲靈感（Song Inspiration Hotfix）：只在建立歌曲工作時顯示，不清空使用者已經打好的內容
  // （這個欄位沒有另外用 JS 變數追蹤選取狀態，切換流程再切回來時，DOM 裡打好的文字不會不見）
  document.getElementById('song-idea-field').style.display = pendingFlowId === 'song' ? 'block' : 'none';
}

function renderWorkDetail() {
  const work = getActiveWork();
  if (!work) { showScreen('screen-home'); return; }
  const flow = FLOWS[work.flowId];
  const step = currentStep(work);

  // 「製作歌曲」「製作影片」不是「AI 寫文字」的步驟，沒有指令可以交給 AI，直接接手到專屬畫面。
  // 「製作影片」分兩階段（Sprint 2.1）：圖片還沒確認完成前回到 Phase A，確認完成後回到 Phase B，
  // 這樣使用者中途離開再回來，才會落在正確的階段，不會被打回已經做完的圖片準備畫面。
  if (work.flowId === 'song' && step.name === '製作歌曲') { showScreen('screen-make-song'); return; }
  if (work.flowId === 'video' && step.name === '製作影片') {
    showScreen(work.imagesCompleted ? 'screen-video-tools' : 'screen-make-video');
    return;
  }
  if (work.flowId === 'poster' && step.name === '完成海報') { showScreen('screen-make-poster'); return; }

  document.getElementById('wd-name').textContent = work.name;
  document.getElementById('wd-tpl').textContent = flow.name + '　·　共 ' + flow.steps.length + ' 步';

  // 前置協作 Brief（若有）：只在有 work.brief 時顯示，收合狀態不佔畫面（Official Flow Sprint，2026-07-14）
  const briefBox = document.getElementById('wd-brief-box');
  if (work.brief) {
    briefBox.style.display = 'block';
    document.getElementById('wd-brief-content').textContent = work.brief;
  } else {
    briefBox.style.display = 'none';
  }

  // 來源標籤：只有「歌曲 MV」類型的影片工作才顯示，一般影片工作不顯示（Sprint 1.2）
  const sourceTag = document.getElementById('wd-source-tag');
  if (work.videoType === 'song_mv') {
    let sourceLine = '🎵 歌曲 MV';
    if (work.sourceWorkId) {
      const sourceSong = getWork(work.sourceWorkId);
      sourceLine += sourceSong ? '　·　來源：《' + (sourceSong.songTitle || sourceSong.name) + '》' : '　·　來源歌曲已不存在';
    }
    sourceTag.textContent = sourceLine;
    sourceTag.style.display = 'block';
  } else {
    sourceTag.style.display = 'none';
  }

  document.getElementById('wd-step-name').textContent = step.name;
  document.getElementById('wd-role').textContent = ROLE_ICON[step.role] + ' ' + step.role;

  renderAiPartnerSection(work, step);

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

  renderCreativePreferencesSection(work);
}

// ── 創作偏好 UI（Creative Preferences MVP）：只在 screen-work-detail 顯示，跟 wd-source-tag
// 同樣的判斷邏輯——「製作歌曲」「製作影片」專屬畫面不重複顯示（Sprint 1.2 已有先例）
function renderCreativePreferencesSection(work) {
  const box = document.getElementById('wd-creative-preferences');
  const categories = CREATIVE_PREFERENCE_CATEGORIES[work.flowId];
  if (!categories) { box.style.display = 'none'; return; }
  box.style.display = 'block';

  const resolved = resolveCreativePreferences(work);
  document.getElementById('wd-cp-product-language').textContent = buildCreativePreferenceProductLanguage(work);
  // CEO 核准的第一項校準：腳本確認後才改的偏好，不能悄悄改變已確認的影片內容——這裡只是
  // 提示使用者「新偏好還沒套用」，實際套用要等使用者重新產生或重新確認「腳本」，才會建立
  // 新的 Style Anchor 快照（見 styleAnchorOutOfSync()／buildStyleAnchorSnapshot() 的設計說明）。
  const outOfSync = work.flowId === 'video' && styleAnchorOutOfSync(work);
  document.getElementById('wd-cp-status').textContent = outOfSync
    ? '⚠️ 已調整偏好，但目前影片母稿還是舊設定，需要重新產生或重新確認「腳本」才會套用新偏好'
    : (isUsingCreativeDefaults(work) ? '✓ 使用系統推薦設定' : '✎ 已使用你的偏好');

  document.getElementById('wd-cp-categories').innerHTML = categories.map(function (cat) {
    const pills = cat.options.map(function (opt) {
      const sel = opt.id === resolved[cat.key] ? ' selected' : '';
      return '<span class="template-pick' + sel + '" onclick="setCreativePreferenceOption(\'' + cat.key + '\',\'' + opt.id + '\')">' + escHtml(opt.label) + '</span>';
    }).join('');
    return '<div style="margin-bottom:12px"><div class="section-label" style="margin-bottom:6px">' + escHtml(cat.label) + '</div><div>' + pills + '</div></div>';
  }).join('');

  document.getElementById('wd-cp-custom-input').value = resolved.custom || '';
}

function setCreativePreferenceOption(key, id) {
  const work = getActiveWork();
  if (!work.creativePreferences) work.creativePreferences = {};
  work.creativePreferences[key] = id;
  saveState();
  renderWorkDetail();
}
function setCreativePreferenceCustomText(text) {
  const work = getActiveWork();
  if (!work.creativePreferences) work.creativePreferences = {};
  work.creativePreferences.custom = text;
  saveState();
  renderWorkDetail();
}
function restoreCreativePreferenceDefaults() {
  const work = getActiveWork();
  work.creativePreferences = null;
  saveState();
  showToast('已恢復系統推薦設定。');
  renderWorkDetail();
}

// ── AI 協作夥伴導航（AI Collaboration Calibration MVP）───────────
// 「建議合作夥伴」永遠顯示 officialSuggestedAiForStep() 的結果（跟這一步的工作需要有關，
// 不會被使用者自己的選擇蓋掉）；「其他可選夥伴」列出其餘已啟用、有特長文案的 AI，
// 使用者選了哪一個，就在對應卡片上顯示「✓ 目前使用」（依 suggestedToolForStep() 的實際結果判斷，
// 那個函式本來就會優先採用使用者的手動選擇，交給 AI 時也是用那個結果，這裡沒有另外存一份）。
// 這一步「為什麼推薦」的理由，找 collaboration-templates.json 既有的 recommend 鏈裡對應這個
// AI 名稱的 reason（Sprint「Song Flow MVP 最後校準」，2026-07-13）——這份資料本來就存在，
// 不是新欄位，只是先前沒有被讀出來顯示。找不到專屬理由時回傳 null，卡片會優雅退回顯示
// AI 的通用特長（見 renderAiPartnerCard），不會空白、不會報錯。
function stepReasonForAi(flowId, role, stepName, aiName) {
  const chain = getRecommendChain(flowId, role, stepName);
  const found = chain.find(function (c) {
    const tool = getMyToolById(c.toolId);
    return tool && tool.name === aiName;
  });
  return found ? found.reason : null;
}

// 這一步 recommendation chain 裡本來就有定義的 AI 名單（Video Flow Sprint 2：校準「其他可選
// 夥伴」顯示範圍）——不是所有已啟用的 AI 都跟這一步的任務有關，例如創作步驟不該列出 Claude Code／
// Codex 這種程式開發用途的 AI。沿用既有 getRecommendChain／getMyToolById，沒有另建推薦引擎。
function stepPartnerCandidateNames(flowId, role, stepName) {
  const chain = getRecommendChain(flowId, role, stepName);
  const names = [];
  chain.forEach(function (c) {
    const tool = getMyToolById(c.toolId);
    if (tool && tool.name && names.indexOf(tool.name) === -1) names.push(tool.name);
  });
  return names;
}

function renderAiPartnerSection(work, step) {
  const officialName = officialSuggestedAiForStep(work.flowId, step.role, step.name);
  const effectiveName = suggestedToolForStep(work.flowId, step.role, step.name).name;

  document.getElementById('wd-ai-recommend-card').innerHTML =
    renderAiPartnerCard(officialName, getAiPartnerByName(officialName), true, officialName === effectiveName,
      stepReasonForAi(work.flowId, step.role, step.name, officialName));

  // 只列出這一步 recommendation chain 裡本來就有的 AI；如果使用者手動選擇的 AI 不在鏈裡，
  // 仍然要顯示它，確保「目前使用」狀態不會因為這次篩選從畫面上消失（不影響使用者已手動選擇的
  // 有效 AI，state.roleAiMap 本身完全不受這次篩選影響）。
  const chainNames = stepPartnerCandidateNames(work.flowId, step.role, step.name);
  if (effectiveName !== officialName && chainNames.indexOf(effectiveName) === -1 && isToolEnabledByName(effectiveName)) {
    chainNames.push(effectiveName);
  }
  const others = getAiPartnerCatalog().filter(function (t) {
    return t.name !== officialName && isToolEnabledByName(t.name) && chainNames.indexOf(t.name) !== -1;
  });
  const otherBox = document.getElementById('wd-ai-other-partners');
  if (others.length === 0) {
    otherBox.innerHTML = '<div class="tool-suggest-note">目前沒有其他啟用中的協作夥伴，可以到「我的工具」新增。</div>';
  } else {
    otherBox.innerHTML = others.map(function (t) {
      return renderAiPartnerCard(t.name, t, false, t.name === effectiveName,
        stepReasonForAi(work.flowId, step.role, step.name, t.name));
    }).join('');
  }
}
// 卡片內容優先顯示「這一步為什麼推薦」（stepReason，跟目前任務有關）；只有在官方合作模板
// 沒有留下這個 AI 在這一步的專屬理由時，才退回顯示 AI 的通用特長／適合情境（既有機制，不變）。
function renderAiPartnerCard(name, entry, isRecommended, isCurrentlyUsed, stepReason) {
  // Phase 1B（Official Recommendation Center）：文字改成「官方建議」，跟商品行銷/歌曲/影片的
  // 工具推薦卡片用同一套用詞，避免使用者在不同畫面看到「這一步建議」跟「官方建議」兩種不同說法。
  const badge = isRecommended ? '<span class="ai-partner-badge">⭐ 官方建議</span>' : '';
  const usedTag = isCurrentlyUsed ? '<span class="ai-partner-used-tag">✓ 目前使用</span>' : '';
  const body = stepReason
    ? '<div class="ai-partner-line">' + escHtml(stepReason) + '</div>'
    : '<div class="ai-partner-line"><b>擅長：</b>' + escHtml(entry ? entry.specialty : '目前可用的協作夥伴') + '</div>' +
      (entry && entry.suitableFor ? '<div class="ai-partner-line"><b>適合：</b>' + escHtml(entry.suitableFor) + '</div>' : '');
  return '<div class="ai-partner-card' + (isRecommended ? ' recommended' : '') + '">' +
    '<div>' + badge + usedTag + '</div>' +
    '<div class="ai-partner-name">' + escHtml(name) + '</div>' +
    body +
    '<button class="btn outline" style="margin-top:10px;padding:10px;font-size:13px" onclick="chooseAiForStep(\'' + name.replace(/'/g, "\\'") + '\')">選擇 ' + escHtml(name) + '</button>' +
    '</div>';
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
  lastCopyText = work.briefDiscussing ? buildBriefDiscussionPrompt(work) : buildCopyText(work);
  document.getElementById('copy-text-box').innerHTML = renderCopyPreviewHtml(lastCopyText);
  document.getElementById('copy-ai-name').textContent = currentStepAiName();
  // 前置討論的指令不是「Context Pack + 乾淨指令」的組合結構（buildBriefDiscussionPrompt 是
  // 獨立寫死的一段），拆開複製沒有意義，這裡先隱藏，避免使用者點了拿到不對的內容。
  document.getElementById('copy-split-buttons').style.display = work.briefDiscussing ? 'none' : 'flex';
}
// 特定步驟的字數建議（目前僅歌曲創作流程的 Lyrics／Style 有實際工具字數限制需要提醒）
// 依據 Suno 官方目前實際狀況（2026）：Lyrics 新版模型上限 5000 字，但 3000 字（約40-60行）內是實際好用的甜蜜點；
// Style 舊版模型上限 200 字，新版模型上限 1000 字，控制在 200 字內可相容所有版本
const LENGTH_GUIDANCE = {
  '歌名＋歌詞': { soft: 3000, hard: 5000, note: 'Suno 歌詞欄位建議控制在 3000 字（約 40-60 行）內，太長容易被系統壓縮或搶拍；新版模型上限是 5000 字。這個字數限制只算歌詞本身，歌名不算在內。' },
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
  const isBrief = !!work.briefDiscussing;
  const stepName = isBrief ? '前置討論 Brief' : currentStep(work).name;
  document.getElementById('pb-ab-warning').style.display = 'none';
  document.getElementById('pb-step-name').textContent = stepName;
  document.getElementById('pb-notice-text').textContent = isBrief
    ? '現在請：把 AI 最後輸出的「本次工作 Brief」完整貼回來。'
    : (work.flowId === 'song' && stepName === '歌名＋歌詞')
      ? '現在請：把 AI 最後輸出的「歌名＋完整歌詞」一起貼回來。'
      : '現在請：把剛剛完成的「' + stepName + '」內容貼回來。';
  const versions = isBrief ? (work.briefVersions || []) : ((work.stepVersions && work.stepVersions[work.currentStepIndex]) || []);
  document.getElementById('pb-version-hint').textContent = versions.length > 0 ? '這會是第 v' + (versions.length + 1) + ' 版' : '這是第一版';

  const guidance = isBrief ? null : LENGTH_GUIDANCE[stepName];
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

// Phase 1A（song/video 局部修改）：Production Studio 的重新生成方向清單有時跟「目前站著的
// 步驟名稱」對不上（例如影片 Phase A 改圖片、Phase B 改影片，兩者都發生在「製作影片」這一步，
// 但需要不同的修改方向選項），directionsFor() 用「flowId+stepName」查表在這種情況下不夠精準，
// 用這個 override 讓進入重新生成模式的呼叫端可以指定專屬清單，離開時清掉，不影響一般文字步驟的打磨流程。
let regenerateDirectionsOverride = null;
function renderReviseDirection() {
  const work = getActiveWork();
  const dirs = regenerateDirectionsOverride || directionsFor(work.flowId, currentStep(work).name);
  const list = document.getElementById('direction-list');
  list.innerHTML = dirs.map(function (d) {
    return '<div class="template-pick" onclick="toggleDirection(\'' + d + '\', event)">' + d + '</div>';
  }).join('');
}

function renderReviseInstruction() {
  document.getElementById('revise-instruction-box').textContent = buildRevisionInstruction();
  const submitBtn = document.getElementById('revise-submit-btn');
  const inRegenerateMode = posterRegenerateMode || songRegenerateMode || videoImageRegenerateMode || videoRegenerateMode;
  if (submitBtn) submitBtn.textContent = inRegenerateMode ? '已在對話裡重新生成 → 回到製作畫面' : '拿到修改版了 → 貼回修改版';
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
    const titlePrefix = r.isFinal ? categoryEmoji(r.category) + ' ' : '';
    return '<div class="result-card" onclick="openResult(' + r.id + ')">' +
      '<h4>' + titlePrefix + escHtml(r.title) + (r.isFinal ? '<span class="final-badge">最終版</span>' : '') + '</h4>' +
      '<div class="meta">來自「' + escHtml(r.projectName) + ' / ' + escHtml(r.workName) + '」　·　' + r.ai + '　·　' + formatDate(r.completedAt) + '</div>' +
      (versions.length > 1 ? '<div class="meta">版本數：v' + versions.length + '　修改次數：' + (versions.length - 1) + '</div>' : '') +
      (r.isFinal ? '<div class="meta">發布狀態：' + (isPublished(r.id) ? '已發布' : '尚未發布') + '</div>' : '') +
      '</div>';
  }).join('');
}

function renderAssetDetail() {
  const r = getResult(activeResultId);
  if (!r) { showScreen('screen-assets'); return; }
  const titlePrefix = r.isFinal ? categoryEmoji(r.category) + ' ' : '';
  document.getElementById('rd-title').textContent = titlePrefix + r.title;
  document.getElementById('rd-meta').textContent = '來自「' + r.projectName + ' / ' + r.workName + '」　·　角色：' + r.role + '　·　使用：' + r.ai + '　·　建立：' + formatDate(r.completedAt) + (r.updatedAt && r.updatedAt !== r.completedAt ? '　·　更新：' + formatDate(r.updatedAt) : '') + (r.version ? '　·　v' + r.version : '');

  // Sprint 4：成果庫詳情要能看到「來源歌曲」——只有歌曲 MV 這種從歌曲接力過來的影片工作才顯示，
  // 其餘一律不顯示這行；來源歌曲工作被刪除時優雅降級，不報錯（沿用 Sprint 1.2 wd-source-tag 的作法）
  const sourceBox = document.getElementById('rd-source');
  const ownerWorkForSource = state.works.find(function (w) { return w.id === r.workId; });
  if (r.isFinal && ownerWorkForSource && ownerWorkForSource.videoType === 'song_mv' && ownerWorkForSource.sourceWorkId) {
    const sourceSong = getWork(ownerWorkForSource.sourceWorkId);
    sourceBox.textContent = '🎵 來源歌曲：' + (sourceSong ? (sourceSong.songTitle || sourceSong.name) : '（已不存在）');
    sourceBox.style.display = 'block';
  } else {
    sourceBox.style.display = 'none';
  }

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

  // Workspace Trust Sprint 1（Task 9）：原本這裡會顯示「加入雲端作品庫」按鈕與
  // 「☁️ 已加入雲端作品庫」狀態，但 saveToCloud() 從未真正把資料送到任何地方，
  // 只是切換本地欄位——已停用，避免使用者誤以為作品已經有雲端備份。
  const cloudBox = document.getElementById('rd-cloud-box');
  cloudBox.innerHTML = '';
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

// ── 常用 AI 引導畫面（第一次使用，Starter Alpha）───────────────
function renderOnboardingAi() {
  const list = document.getElementById('onboarding-ai-list');
  list.innerHTML = PREFERRED_AI_OPTIONS.map(function (name) {
    return '<button class="btn outline" style="margin-top:10px" onclick="chooseOnboardingAi(\'' + name + '\')">' + name + '</button>';
  }).join('') +
    '<button class="btn outline" style="margin-top:10px" onclick="showOnboardingOtherInput()">其他</button>' +
    '<button class="btn outline" style="margin-top:10px" onclick="chooseOnboardingNoAi()">我還沒有固定使用的 AI</button>';
  document.getElementById('onboarding-ai-other-field').style.display = 'none';
}
function showOnboardingOtherInput() {
  document.getElementById('onboarding-ai-other-field').style.display = 'block';
}
function confirmOnboardingOtherAi() {
  const input = document.getElementById('onboarding-ai-other-input');
  const name = (input.value || '').trim();
  if (!name) { showToast('請先輸入 AI 的名字'); return; }
  chooseOnboardingAi(name);
}
function chooseOnboardingAi(name) {
  state.myAiList = [name];
  state.preferredAiOnboarded = true;
  saveState();
  showToast('已設定常用 AI：' + name);
  showScreen(homeOrDataSafetyOnboardingScreen());
}
function chooseOnboardingNoAi() {
  state.preferredAiOnboarded = true;
  saveState();
  showScreen(homeOrDataSafetyOnboardingScreen());
}
function skipOnboardingPreferredAi() {
  state.preferredAiOnboarded = true;
  saveState();
  showScreen(homeOrDataSafetyOnboardingScreen());
}

// ── 我的常用 AI（我的工作台 → 我的常用 AI，可修改／新增／刪除／排序）──
function renderMyAiList() {
  const list = document.getElementById('my-ai-list');
  if (!state.myAiList || state.myAiList.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="icon">⭐</div><div class="txt">還沒有設定 AI 夥伴，先新增一個吧</div></div>';
    return;
  }
  list.innerHTML = state.myAiList.map(function (name, i) {
    const upBtn = i > 0 ? '<span style="cursor:pointer;font-size:15px;margin-right:10px" onclick="moveMyAi(' + i + ', -1)" title="往上移">▲</span>' : '';
    const downBtn = i < state.myAiList.length - 1 ? '<span style="cursor:pointer;font-size:15px;margin-right:10px" onclick="moveMyAi(' + i + ', 1)" title="往下移">▼</span>' : '';
    return '<div class="tool-row">' +
      '<div class="tool-info"><span class="tool-emoji">' + (i === 0 ? '⭐' : '　') + '</span>' +
      '<div><div class="tool-name">' + escHtml(name) + '</div>' + (i === 0 ? '<div class="tool-category">目前優先建議</div>' : '') + '</div></div>' +
      '<div class="tool-actions">' + upBtn + downBtn +
      '<button class="tool-delete" onclick="deleteMyAi(' + i + ')" title="刪除">🗑️</button>' +
      '</div></div>';
  }).join('');
}
function moveMyAi(index, dir) {
  const list = state.myAiList;
  const target = index + dir;
  if (target < 0 || target >= list.length) return;
  const tmp = list[index]; list[index] = list[target]; list[target] = tmp;
  saveState();
  renderMyAiList();
}
function deleteMyAi(index) {
  const name = state.myAiList[index];
  if (!confirm('確定要移除「' + name + '」嗎？')) return;
  state.myAiList.splice(index, 1);
  saveState();
  renderMyAiList();
}
function openAddMyAi() { showScreen('screen-add-my-ai'); }
function renderAddMyAi() {
  const quick = document.getElementById('add-my-ai-quick-list');
  const existing = state.myAiList || [];
  const options = PREFERRED_AI_OPTIONS.filter(function (n) { return existing.indexOf(n) === -1; });
  quick.innerHTML = options.map(function (name) {
    return '<button class="btn outline" style="margin-top:10px" onclick="quickAddMyAi(\'' + name + '\')">' + name + '</button>';
  }).join('');
}
function quickAddMyAi(name) {
  state.myAiList = state.myAiList || [];
  if (state.myAiList.indexOf(name) === -1) state.myAiList.push(name);
  saveState();
  showToast('已新增「' + name + '」');
  showScreen('screen-my-ai');
}
function confirmAddMyAi() {
  const input = document.getElementById('new-my-ai-input');
  const name = (input.value || '').trim();
  if (!name) { showToast('請先輸入 AI 的名字'); return; }
  quickAddMyAi(name);
  input.value = '';
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
function formatDateTime(iso) {
  const d = new Date(iso);
  const pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return (d.getFullYear()) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// 相對時間（「3 天前」／「剛剛」），首頁摘要卡片與 Data Safety Center 都要用，只寫一次
function formatRelativeTime(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '剛剛';
  if (diffMin < 60) return diffMin + ' 分鐘前';
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return diffHour + ' 小時前';
  const diffDay = Math.floor(diffHour / 24);
  return diffDay + ' 天前';
}
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── 啟動 ──────────────────────────────────────────────────────
// 先載入工具資料（官方工具清單／合作模板），確保 loadState() 建立預設狀態時 TOOLS_CATALOG 已經就緒
function startApp() {
  loadState();
  if (dataCorruptionDetected) { showScreen('screen-data-corruption-notice'); return; }
  // 補正二：每次啟動都先確認上一次的 Google Drive 復原交易有沒有正常做完，
  // 在使用者看到任何畫面之前先處理好，不會讓一個沒收尾的復原交易停留在背景。
  checkAndRecoverIncompleteRestoreTransaction();
  showScreen(state.preferredAiOnboarded ? homeOrDataSafetyOnboardingScreen() : 'screen-preferred-ai-onboarding');
}
function acknowledgeDataCorruption() {
  showScreen(state.preferredAiOnboarded ? homeOrDataSafetyOnboardingScreen() : 'screen-preferred-ai-onboarding');
}
// Workspace Trust Sprint 1（Task 8）：唯一一個判斷「現在該不該顯示首次資料安全提醒」的地方，
// 所有「原本要去首頁」的路徑都改呼叫這裡，不要在每個呼叫點各自判斷一次
// dataSafetyOnboarded，避免之後漏掉某一條路徑、造成有些使用者永遠看不到提醒。
function homeOrDataSafetyOnboardingScreen() {
  return state.dataSafetyOnboarded ? 'screen-home' : 'screen-data-safety-onboarding';
}
function acknowledgeDataSafetyOnboarding(goBackup) {
  state.dataSafetyOnboarded = true;
  saveState();
  if (goBackup) { showScreen('screen-home'); exportData(); return; }
  showScreen('screen-home');
}
loadToolData().then(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
  } else {
    startApp();
  }
});
