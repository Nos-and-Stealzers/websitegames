/* Offline shell cache.
   The site's own pages and assets are cached; game folders never are, so a
   game always fetches its current build. Bump SHELL_VERSION after a deploy. */

var SHELL_VERSION = "ach-shell-v8";

var SHELL = [
  "index.html",
  "browse.html",
  "categories.html",
  "play.html",
  "library.html",
  "stats.html",
  "about.html",
  "404.html",
  "login.html",
  "signup.html",
  "friends.html",
  "messages.html",
  "notifications.html",
  "profile.html",
  "settings.html",
  "admin.html",
  "admin-search.html",
  "css/style.css",
  "js/core/config.js",
  "js/core/theme-boot.js",
  "js/core/store.js",
  "js/core/ui.js",
  "js/core/api.js",
  "js/core/api-supabase.js",
  "js/core/session.js",
  "js/features/catalog.js",
  "js/features/art.js",
  "js/features/social-ui.js",
  "js/features/capture.js",
  "js/features/chat-dock.js",
  "js/features/shell.js",
  "js/pages/page-home.js",
  "js/pages/page-browse.js",
  "js/pages/page-categories.js",
  "js/pages/page-play.js",
  "js/pages/page-library.js",
  "js/pages/page-stats.js",
  "js/pages/page-about.js",
  "js/pages/page-404.js",
  "js/pages/page-login.js",
  "js/pages/page-signup.js",
  "js/pages/page-friends.js",
  "js/pages/page-messages.js",
  "js/pages/page-notifications.js",
  "js/pages/page-profile.js",
  "js/pages/page-settings.js",
  "js/pages/page-admin.js",
  "js/pages/page-admin-search.js",
  "data/games.js",
  "assets/icon.svg",
  "manifest.json"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_VERSION).then(function (cache) {
      /* addAll fails the whole install if one file 404s, so add individually. */
      return Promise.all(SHELL.map(function (url) {
        return cache.add(url).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        return key === SHELL_VERSION ? null : caches.delete(key);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // games on other hosts
  if (url.pathname.indexOf("/games/") !== -1) return;   // always live
  /* Sessions, friends and messages must never be served from cache. */
  if (url.pathname === "/api" || url.pathname.indexOf("/api/") === 0) return;

  /* Navigations: try the network, fall back to cache, then to the 404 page. */
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          var copy = response.clone();
          caches.open(SHELL_VERSION).then(function (c) { c.put(request, copy); });
          return response;
        })
        .catch(function () {
          return caches.match(request).then(function (hit) {
            return hit || caches.match("404.html") || caches.match("index.html");
          });
        })
    );
    return;
  }

  /* Assets: cache first, refresh in the background. */
  event.respondWith(
    caches.match(request).then(function (hit) {
      var network = fetch(request).then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(SHELL_VERSION).then(function (c) { c.put(request, copy); });
        }
        return response;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
