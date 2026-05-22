const CACHE_NAME = 'onul-safety-v35';
const FILES_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

// 설치
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(FILES_TO_CACHE))
  );
  self.skipWaiting();
});

// 활성화 — 이전 캐시 삭제
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 메시지 수신 — 강제 업데이트
self.addEventListener('message', event => {
  if(event.data && event.data.type === 'SKIP_WAITING'){
    self.skipWaiting();
  }
});

// 요청 처리 — 캐시 우선(Stale-While-Revalidate)
// 1) 캐시에서 즉시 응답 → 빠른 초기 로딩
// 2) 동시에 백그라운드에서 새 버전 fetch → 캐시 갱신
// 3) 새 SW 감지 시 업데이트 배너 자동 표시 → 즉시 반영
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // POST 또는 외부 API는 캐시 제외
  if(
    event.request.method !== 'GET' ||
    url.includes('googleapis.com') ||
    url.includes('anthropic.com') ||
    url.includes('groq.com') ||
    url.includes('workers.dev') ||
    !url.startsWith(self.location.origin)
  ){
    // 외부 요청 완전 위임 (iOS non-app-bound domain 에러 방지)
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const networkFetch = fetch(event.request).then(response => {
          if(response && response.status === 200 && response.type === 'basic'){
            cache.put(event.request, response.clone());
          }
          return response;
        }).catch(() => cached);

        // 캐시 있으면 즉시 반환, 없으면 네트워크 대기
        return cached || networkFetch;
      })
    )
  );
});
