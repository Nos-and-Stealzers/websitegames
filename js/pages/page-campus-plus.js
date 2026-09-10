/* Campus+: paste a YouTube link, it plays inline; save into playlists,
   personal or shared. No download — this is an embed, same limits every
   embed has (a video whose owner disabled embedding will refuse to play;
   that is YouTube's decision, not a bug here). */
(function () {
  "use strict";

  /* Every shape a YouTube link comes in: watch?v=, youtu.be/, embed/,
     shorts/, with or without extra query params/timestamps riding along. */
  function extractVideoId(input) {
    var s = String(input || "").trim();
    if (!s) return null;

    var patterns = [
      /(?:youtube\.com\/watch\?[^#]*\bv=)([A-Za-z0-9_-]{11})/,
      /youtu\.be\/([A-Za-z0-9_-]{11})/,
      /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
      /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
      /youtube\.com\/live\/([A-Za-z0-9_-]{11})/
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = s.match(patterns[i]);
      if (m) return m[1];
    }
    /* A bare 11-character id, pasted directly. */
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
    return null;
  }

  function embedUrl(videoId) {
    return "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(videoId) +
      "?autoplay=1&rel=0";
  }
  function thumbUrl(videoId) {
    return "https://i.ytimg.com/vi/" + encodeURIComponent(videoId) + "/mqdefault.jpg";
  }

  function init() {
    var UI = window.UI;
    var API = window.API;
    var Session = window.Session;

    var urlInput = document.getElementById("cp-url");
    var urlNote = document.getElementById("cp-url-note");
    var playBtn = document.getElementById("cp-play");
    var addBtn = document.getElementById("cp-add");
    var playerBlock = document.getElementById("cp-player-block");
    var player = document.getElementById("cp-player");
    var mineHost = document.getElementById("cp-mine");
    var publicHost = document.getElementById("cp-public");
    var publicQ = document.getElementById("cp-public-q");
    var signedOutNote = document.getElementById("cp-signed-out");
    var detailBlock = document.getElementById("cp-detail-block");
    var detailContent = document.getElementById("cp-detail-content");

    var currentVideoId = null;
    var currentVideoTitle = "";

    function checkUrl() {
      var id = extractVideoId(urlInput.value);
      addBtn.disabled = !id;
      urlNote.textContent = urlInput.value.trim() && !id
        ? "That doesn't look like a YouTube link."
        : "";
      return id;
    }
    urlInput.addEventListener("input", checkUrl);

    function play(videoId) {
      currentVideoId = videoId;
      currentVideoTitle = "";
      player.src = embedUrl(videoId);
      playerBlock.hidden = false;
      addBtn.disabled = false;
      playerBlock.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    playBtn.addEventListener("click", function () {
      var id = extractVideoId(urlInput.value);
      if (!id) { UI.toast("Paste a real YouTube link first."); return; }
      play(id);
    });

    urlInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") playBtn.click();
    });

    /* ---------------------------------------------------- add-to-playlist */

    function pickPlaylistThen(run) {
      if (!Session.user) {
        UI.toast("Sign in to save playlists.");
        return;
      }
      API.myPlaylists().then(function (lists) {
        if (!lists.length) {
          UI.toast("Make a playlist first — use \u201c+ New playlist\u201d below.");
          return;
        }
        var names = lists.map(function (p, i) { return (i + 1) + ". " + p.title; }).join("\n");
        var pick = window.prompt("Add to which playlist? Type the number:\n" + names);
        if (pick === null) return;
        var idx = parseInt(pick, 10) - 1;
        if (isNaN(idx) || !lists[idx]) { UI.toast("Didn't recognise that."); return; }
        run(lists[idx]);
      });
    }

    addBtn.addEventListener("click", function () {
      var id = currentVideoId || extractVideoId(urlInput.value);
      if (!id) { UI.toast("Play something first."); return; }
      pickPlaylistThen(function (list) {
        API.addPlaylistItem(list.id, id, currentVideoTitle)
          .then(function () {
            UI.toast("Added to " + list.title);
            loadMine();
          })
          .catch(function (err) { UI.toast(err.message); });
      });
    });

    /* --------------------------------------------------------- playlists */

    document.getElementById("cp-new").addEventListener("click", function () {
      if (!Session.user) { UI.toast("Sign in to make a playlist."); return; }
      var title = window.prompt("Name this playlist:");
      if (!title || !title.trim()) return;
      var isPublic = window.confirm("Let anyone see and play this playlist? Cancel keeps it just for you.");
      API.createPlaylist(title.trim(), "", isPublic)
        .then(function () { UI.toast("Playlist created"); loadMine(); })
        .catch(function (err) { UI.toast(err.message); });
    });

    function playlistRow(p, mine) {
      var row = UI.el("div", "row");
      row.style.cursor = "pointer";
      row.appendChild(UI.el("span", "name", p.title));
      var meta = (p.itemCount || 0) + (p.itemCount === 1 ? " video" : " videos") +
        (mine ? (p.isPublic ? " · shared" : " · private") : " · by @" + p.ownerUsername);
      row.appendChild(UI.el("span", "tiny dimmer", meta));
      row.addEventListener("click", function () { openDetail(p.id); });
      return row;
    }

    function loadMine() {
      if (!Session.user) {
        signedOutNote.hidden = false;
        mineHost.innerHTML = "";
        return;
      }
      signedOutNote.hidden = true;
      API.myPlaylists().then(function (lists) {
        mineHost.innerHTML = "";
        if (!lists.length) {
          mineHost.appendChild(UI.el("p", "tiny dimmer", "No playlists yet — play something and save it."));
          return;
        }
        lists.forEach(function (p) { mineHost.appendChild(playlistRow(p, true)); });
      }).catch(function () { /* non-fatal */ });
    }

    function loadPublic(q) {
      API.publicPlaylists(q).then(function (lists) {
        publicHost.innerHTML = "";
        if (!lists.length) {
          publicHost.appendChild(UI.el("p", "tiny dimmer",
            q ? "Nothing matches." : "Nobody has shared one yet — be the first."));
          return;
        }
        lists.forEach(function (p) { publicHost.appendChild(playlistRow(p, false)); });
      }).catch(function () { /* non-fatal */ });
    }

    publicQ.addEventListener("input", UI.debounce(function () {
      loadPublic(publicQ.value.trim());
    }, 250));

    /* ------------------------------------------------------------ detail */

    function openDetail(id) {
      API.playlistDetail(id).then(function (p) {
        detailBlock.hidden = false;
        document.getElementById("detail-h").textContent = p.title;
        detailContent.innerHTML = "";

        var meta = UI.el("p", "tiny dimmer");
        meta.style.margin = "0 0 0.8rem";
        meta.textContent = (p.mine ? "Yours" : "by @" + p.ownerUsername) +
          (p.isPublic ? " · shared" : " · private") +
          (p.description ? " — " + p.description : "");
        detailContent.appendChild(meta);

        if (!p.items.length) {
          detailContent.appendChild(UI.el("p", "tiny dimmer", "Nothing in here yet."));
        }
        p.items.forEach(function (item) {
          var row = UI.el("div", "row");
          row.style.gridTemplateColumns = "3.2rem 1fr auto";

          var thumb = document.createElement("img");
          thumb.src = thumbUrl(item.videoId);
          thumb.alt = "";
          thumb.style.cssText = "width:3.2rem;height:2.2rem;object-fit:cover;border-radius:4px";
          row.appendChild(thumb);

          var label = UI.el("span", "name", item.title || item.videoId);
          label.style.cursor = "pointer";
          label.addEventListener("click", function () {
            currentVideoId = item.videoId;
            player.src = embedUrl(item.videoId);
            playerBlock.hidden = false;
            playerBlock.scrollIntoView({ behavior: "smooth", block: "start" });
          });
          row.appendChild(label);

          if (p.mine) {
            var del = UI.el("button", "btn btn-sm btn-flat", "Remove");
            del.type = "button";
            del.addEventListener("click", function () {
              API.removePlaylistItem(item.id).then(function () { openDetail(id); loadMine(); });
            });
            row.appendChild(del);
          } else {
            row.appendChild(UI.el("span"));
          }
          detailContent.appendChild(row);
        });

        if (p.mine) {
          detailContent.appendChild(UI.el("hr", "sheet-rule"));
          var shareBtn = UI.el("button", "btn btn-sm", p.isPublic ? "Make private" : "Share with everyone");
          shareBtn.type = "button";
          shareBtn.addEventListener("click", function () {
            API.updatePlaylist(id, { isPublic: !p.isPublic }).then(function () {
              UI.toast(p.isPublic ? "Now private" : "Now shared");
              openDetail(id); loadMine(); loadPublic(publicQ.value.trim());
            });
          });
          detailContent.appendChild(shareBtn);

          var deleteBtn = UI.el("button", "btn btn-sm btn-flat is-danger", "Delete playlist");
          deleteBtn.type = "button";
          deleteBtn.style.marginLeft = "0.4rem";
          deleteBtn.addEventListener("click", function () {
            if (!window.confirm("Delete \u201c" + p.title + "\u201d? This can't be undone.")) return;
            API.deletePlaylist(id).then(function () {
              UI.toast("Deleted");
              detailBlock.hidden = true;
              loadMine(); loadPublic(publicQ.value.trim());
            });
          });
          detailContent.appendChild(deleteBtn);
        }

        detailBlock.scrollIntoView({ behavior: "smooth", block: "start" });
      }).catch(function (err) { UI.toast(err.message); });
    }

    document.getElementById("cp-detail-close").addEventListener("click", function () {
      detailBlock.hidden = true;
    });

    /* ------------------------------------------------------------- boot */

    Session.ready.then(function () {
      loadMine();
    });
    document.addEventListener("session:change", loadMine);
    loadPublic("");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
