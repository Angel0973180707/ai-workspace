// AI 工作台 Service Worker — Deployment Mirror Sprint 1
//
// 這份檔案屬於「部署管線」，不屬於產品原始碼（產品的 ai-workspace/frontend/service-worker.js
// 是另一份，兩者刻意分開維護）。原因：第一次部署的來源固定是已核准的 Factory commit
// （目前是 61a3f33），但那個 commit 當時的 service-worker.js 還是舊版（cache-first、
// 固定 ai-workspace-v0.12），如果直接照搬那個版本，就沒辦法滿足這個 Sprint 的
// 「避免正式站長期卡在舊快取」要求。把正確版本放在這裡、由部署流程注入 079e490，
// 不管之後核准哪一個 Factory commit 上線，快取正確性都不會因為忘記同步而跳過。
//
// 079e490 由 .github/workflows/deploy-ai-workspace.yml 在部署時替換成當次的
// Factory source commit short SHA，確保「每次部署使用唯一 cache identifier」。
const CACHE_NAME = 'ai-workspace-079e490';
const ASSETS = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './tools-catalog.json',
  './collaboration-templates.json',
  './build-info.json'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) { return cache.addAll(ASSETS); })
  );
  self.skipWaiting();
});

// 清掉所有跟這次部署 CACHE_NAME 不同的舊快取（不管舊快取叫什麼名字，例如舊版固定的
// ai-workspace-v0.12，或任何一次之前部署留下的 ai-workspace-<sha>），確保不會有使用者
// 卡在很久以前部署的版本上，也不需要使用者自己手動清瀏覽器快取
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

// Network First：先試著拿最新版本，離線或網路失敗時才退回快取——
// 這樣每次部署完，使用者下一次連上網路就能拿到新版 index.html／app.js／style.css，
// 不需要等瀏覽器自己決定何時檢查 Service Worker 有沒有更新，也保留基本離線能力
//
// Google Drive Backup MVP 部署前最小修正：這個 handler 原本對「每一個」請求都嘗試
// cache.put()，但 Cache API 規格上 cache.put() 對非 GET 請求會直接拋出例外——這次
// 新增的 Drive API 呼叫大量使用 PATCH／POST，加上 OAuth（accounts.google.com）與
// Drive API（www.googleapis.com）都是跨網域請求，快取它們既不合法（非 GET）也沒有
// 實際用途（跨網域回應多半是 opaque response，快取起來無法被安全重用）。
// 修正範圍只限縮在這個 fetch handler 本身：只有「同網域＋GET」的請求才進入
// Network-First＋快取流程；其餘（非 GET，或跨網域）一律直接 fetch，完全不呼叫
// cache.put()，也不嘗試比對快取。install／activate 與其他部署行為完全不變。
self.addEventListener('fetch', function (e) {
  const req = e.request;
  let isSameOrigin = false;
  try { isSameOrigin = new URL(req.url).origin === self.location.origin; } catch (err) { isSameOrigin = false; }
  if (!isSameOrigin || req.method !== 'GET') {
    e.respondWith(fetch(req));
    return;
  }
  e.respondWith(
    fetch(req).then(function (fresh) {
      const copy = fresh.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
      return fresh;
    }).catch(function () {
      return caches.match(req);
    })
  );
});
