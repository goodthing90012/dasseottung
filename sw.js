// 다썼텅 서비스워커 (오프라인-퍼스트)
// 업데이트 정책: '앱 새로고침' 버튼을 누를 때만 캐시를 비우고 다시 받는다.
// (자동 강제 업데이트는 오프라인 캐시 리스크 때문에 도입하지 않음 → skipWaiting 미사용)

const CACHE = 'dasseottung-v38';

// 앱 셸: 오프라인에서도 앱이 뜨도록 미리 캐시해 둔다.
// (이미지/이모지는 index.html 안에 base64로 인라인되어 있어 별도 캐싱 불필요)
const PRECACHE_URLS = ['./', './index.html', './manifest.json'];

// ── install: 앱 셸을 캐시. 하나가 없어도(예: manifest 누락) 전체가 깨지지 않게 개별 캐시.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(
      PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))
    );
    // skipWaiting()은 일부러 호출하지 않음 — 사용자가 직접 새로고침할 때만 갱신
  })());
});

// ── activate: 옛 버전 캐시만 정리하고, 새 워커가 활성화되면 페이지 제어를 넘겨받는다.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ── fetch: 같은 출처 GET만 처리. 캐시 우선, 없으면 네트워크에서 받아 캐시에 저장.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부 요청은 그대로 네트워크

  // 내비게이션(HTML): 캐시된 앱 셸을 우선 제공(오프라인 대비).
  // '앱 새로고침'이 캐시를 비운 직후엔 캐시가 없으므로 네트워크에서 최신본을 받아 다시 캐싱한다.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match('./index.html');
      if (cached) return cached;
      try {
        const fresh = await fetch(req);              // 새로고침 시 ?v=... 우회 포함
        if (fresh && fresh.ok) cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        // 오프라인이고 셸도 없으면 디렉터리 인덱스라도 시도
        const fallback = await cache.match('./');
        if (fallback) return fallback;
        throw e;
      }
    })());
    return;
  }

  // 그 외 정적 자원: 캐시 우선, 없으면 네트워크에서 받아 캐시에 저장
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const fresh = await fetch(req);
    if (fresh && fresh.ok && fresh.type === 'basic') cache.put(req, fresh.clone());
    return fresh;
  })());
});
