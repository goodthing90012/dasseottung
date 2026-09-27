// 다썼텅 서비스워커 (오프라인-퍼스트)
// 업데이트 정책: '앱 새로고침' 버튼을 누를 때만 캐시를 비우고 다시 받는다.
// (자동 강제 업데이트는 오프라인 캐시 리스크 때문에 도입하지 않음 → skipWaiting 미사용)

const CACHE = 'dasseottung-v62';
const PUSH_DATA_CACHE = 'dasseottung-push-data';   // 알림용 루틴 스냅샷 (버전 정리 대상 아님)
const PUSH_SNAPSHOT_URL = './__routine-push-snapshot';

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
    await Promise.all(keys.filter((k) => k !== CACHE && k !== PUSH_DATA_CACHE).map((k) => caches.delete(k)));
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

// ── 루틴 알림 (웹 푸시) ─────────────────────────────────────────
// GitHub Actions가 보내는 건 {type:"routine-reminder"} 신호뿐.
// 알림 문구는 앱이 저장해 둔 스냅샷(오늘~7일 뒤 루틴 상태)으로 여기서 만든다.
// ※ userVisibleOnly 약속 때문에 푸시가 오면 '항상' 알림을 띄워야 한다
//   (안 띄우면 브라우저가 기본 문구를 띄우거나, iOS는 구독을 끊어버릴 수 있음).

function localDateStr(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function readRoutineSnapshot() {
  try {
    const cache = await caches.open(PUSH_DATA_CACHE);
    const res = await cache.match(PUSH_SNAPSHOT_URL);
    return res ? await res.json() : null;
  } catch (e) { return null; }
}

async function buildRoutineNotification() {
  const snap = await readRoutineSnapshot();
  const today = localDateStr(new Date());
  const items = snap && snap.days ? snap.days[today] : undefined;

  // 스냅샷이 없거나 너무 오래돼 오늘 칸이 없으면 → 일반 문구
  if (!Array.isArray(items)) {
    return { title: '오늘 루틴 체크했텅? 🧴', body: '다썼텅을 열어서 오늘 루틴을 확인해 보세요.' };
  }
  if (!snap.hasRoutines || items.length === 0) {
    return { title: '오늘은 쉬는 날이텅 😴', body: '오늘 예정된 루틴이 없어요. 푹 쉬어요!' };
  }
  const pending = items.filter((it) => !it.done);
  if (pending.length === 0) {
    return { title: '오늘 루틴 올클리어! ⭐', body: `${items.length}개 전부 다 했텅. 고생했어요!` };
  }
  const lines = pending.slice(0, 5).map((it) => `• ${it.name}${it.note ? ` (${it.note})` : ''}`);
  if (pending.length > 5) lines.push(`외 ${pending.length - 5}개`);
  return { title: `아직 안 한 루틴 ${pending.length}개 🫧`, body: lines.join('\n') };
}

async function showRoutineNotification() {
  const n = await buildRoutineNotification();
  return self.registration.showNotification(n.title, {
    body: n.body,
    tag: 'routine-reminder',     // 같은 날 여러 번 와도 하나로 교체
    renotify: true,
    data: { url: './?tab=routine' }
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(showRoutineNotification());
});

// 설정 화면 '미리보기' 버튼 → 실제와 같은 경로로 한 번 띄움
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'preview-routine-push') {
    event.waitUntil(showRoutineNotification());
  }
});

// 알림 탭 → 열려 있는 앱이 있으면 그 창을 루틴 탭으로, 없으면 새로 연다
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) {
        c.postMessage({ type: 'open-routine' });
        return c.focus();
      }
    }
    const url = (event.notification.data && event.notification.data.url) || './?tab=routine';
    return self.clients.openWindow(url);
  })());
});
