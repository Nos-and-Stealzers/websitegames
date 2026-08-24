/* Offline shell cache.
 *
 * The site's own pages and assets are cached; game folders never are, so a
 * game always fetches its current build.
 *
 * The cache used to answer first and refresh behind you. That is the right
 * shape for artwork and the wrong shape for the code that draws the page:
 * every visit ran the *previous* deploy, and the fix you had just shipped
 * only appeared on the visit after the one where you looked for it. A stale
 * console and a stale friends list are indistinguishable from a change that
 * never happened.
 *
 * So: HTML, CSS and JS go to the network first and fall back to the cache
 * when there isn't one. Everything else stays cache-first. Offline still
 * works — that is what the fallback is — and online is always current.
 */

var SHELL_VERSION = "ach-shell-v8";

/* The site's own code. These are what must never be a deploy behind. */
var CODE = /\.(?:html|css|js|json|webmanifest)$/i;

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
  "css/style.css",
  "js/config.js",
  "js/theme-boot.js",
  "js/store.js",
  "js/catalog.js",
  "js/art.js",
  "js/ui.js",
  "js/api.js",
  "js/api-supabase.js",
  "js/session.js",
  "js/social-ui.js",
  "js/capture.js",
  "js/chat-dock.js",
  "js/shell.js",
  "js/page-home.js",
  "js/page-browse.js",
  "js/page-categories.js",
  "js/page-play.js",
  "js/page-library.js",
  "js/page-stats.js",
  "js/page-about.js",
  "js/page-404.js",
  "js/page-login.js",
  "js/page-signup.js",
  "js/page-friends.js",
  "js/page-messages.js",
  "js/page-notifications.js",
  "js/page-profile.js",
  "js/page-settings.js",
  "js/page-admin.js",
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

  /* The site's own code: network first, cache only as a fallback. */
  if (CODE.test(url.pathname) || url.pathname === "/" || url.pathname === "") {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.status === 200) {
          var copy = response.clone();
          caches.open(SHELL_VERSION).then(function (c) { c.put(request, copy); });
        }
        return response;
      }).catch(function () {
        return caches.match(request).then(function (hit) {
          return hit || Response.error();
        });
      })
    );
    return;
  }

  /* Everything else — artwork, icons, fonts: cache first, refresh behind. */
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
