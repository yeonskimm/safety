const CACHE_NAME = 'onul-safety-v61';
const FILES_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// 설치 — 핵심 파일 캐시
// allSettled: 아이콘 등 일부 파일이 없어도 설치가 통째로 실패하지 않도록 개별 처리
// (이전: addAll → 파일 하나만 404여도 설치 전체 실패 → 새 SW 활성화 불가 → 업데이트 멈춤)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(FILES_TO_CACHE.map(f => cache.add(f)))
    )
  );
  // skipWaiting은 페이지가 '안전한 시점'에 SKIP_WAITING 메시지로 요청한다(채팅 입력 중 강제 새로고침 방지)
});

// 활성화 — 이전 캐시 삭제 후 즉시 제어 획득
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 메시지 수신 — 페이지가 준비되면 즉시 활성화 요청
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 요청 처리 — Stale-While-Revalidate
// 1) 캐시 즉시 응답(빠른 로딩) 2) 백그라운드로 새 버전 받아 캐시 갱신
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // POST 또는 외부 API는 캐시 제외 (iOS non-app-bound 도메인 에러·지연 방지)
  if (
    event.request.method !== 'GET' ||
    url.includes('googleapis.com') ||
    url.includes('anthropic.com') ||
    url.includes('groq.com') ||
    url.includes('workers.dev') ||
    url.includes('open-meteo.com') ||
    url.includes('bigdatacloud.net') ||
    url.includes('wttr.in') ||
    !url.startsWith(self.location.origin)
  ) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const networkFetch = fetch(event.request).then(response => {
          if (response && response.status === 200 && response.type === 'basic') {
            cache.put(event.request, response.clone());
          }
          return response;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    )
  );
});
