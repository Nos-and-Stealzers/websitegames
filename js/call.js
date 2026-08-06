/* Voice, video and screen sharing.
 *
 * The audio and video go straight from one browser to the other over WebRTC.
 * The hub's server only carries the setup handshake, and the addresses come
 * from Google's public STUN servers, which are free. Nothing here costs
 * anything to run and nothing here needs an external service.
 *
 * Everyone connects to everyone else — a mesh — so each extra person costs
 * every participant another upload stream. That's fine up to about four, and
 * the server enforces the same ceiling. Past that you need a relay server
 * that forwards video, and that is the part nobody gives away.
 *
 * One honest limitation: a peer connection belongs to the page that opened
 * it, so navigating away ends your call. Playing a game doesn't — the game
 * runs in an iframe inside the same page — which is the case that matters.
 */
(function () {
  "use strict";

  var RING_POLL = 6000;      // watching for incoming calls
  var LIVE_POLL = 1500;      // in a call, exchanging handshake messages
  var el;

  var state = {
    call: null,          // the active call, from the server
    self: 0,             // my user id
    ice: null,           // ICE server list
    local: null,         // my MediaStream
    screen: null,        // display capture, when sharing
    peers: {},           // userId -> { pc, stream, el }
    muted: false,
    camOff: true,
    timer: null,
    ringTimer: null,
    ringing: null,       // an incoming call awaiting an answer
    startedAt: 0
  };

  var root, bar, tiles, statusEl, timerEl, ringEl;

  function can() {
    return !!(navigator.mediaDevices && window.RTCPeerConnection);
  }

  /* ---------------------------------------------------------------- UI */

  function build() {
    el = window.UI.el;

    root = el("div", "callroot");
    root.hidden = true;

    /* --- incoming call card --- */
    ringEl = el("div", "ring");
    ringEl.hidden = true;
    ringEl.setAttribute("role", "alertdialog");
    ringEl.setAttribute("aria-label", "Incoming call");
    root.appendChild(ringEl);

    /* --- the live call panel --- */
    bar = el("div", "callbar");
    bar.hidden = true;

    var head = el("div", "callbar-head");
    statusEl = el("span", "callbar-status", "Connecting…");
    head.appendChild(statusEl);
    timerEl = el("span", "callbar-timer", "0:00");
    head.appendChild(timerEl);

    var min = el("button", "callbar-btn", "–");
    min.type = "button";
    min.title = "Minimise";
    min.setAttribute("aria-label", "Minimise call");
    min.addEventListener("click", function () {
      bar.classList.toggle("is-min");
      min.textContent = bar.classList.contains("is-min") ? "+" : "–";
    });
    head.appendChild(min);
    bar.appendChild(head);

    tiles = el("div", "calltiles");
    bar.appendChild(tiles);

    var deck = el("div", "callbar-deck");
    [
      ["mute",   "🎙", "Mute",         toggleMute],
      ["cam",    "📷", "Camera",       toggleCam],
      ["screen", "🖥", "Share screen", toggleScreen],
      ["full",   "⛶", "Expand",       function () { root.classList.toggle("is-big"); }]
    ].forEach(function (spec) {
      var b = el("button", "callbtn", spec[1]);
      b.type = "button";
      b.dataset.act = spec[0];
      b.title = spec[2];
      b.setAttribute("aria-label", spec[2]);
      b.addEventListener("click", function () { spec[3](); });
      deck.appendChild(b);
    });

    var end = el("button", "callbtn is-end", "✕");
    end.type = "button";
    end.title = "Leave the call";
    end.setAttribute("aria-label", "Leave the call");
    end.addEventListener("click", function () { hangUp(); });
    deck.appendChild(end);

    bar.appendChild(deck);
    root.appendChild(bar);
    document.body.appendChild(root);
  }

  function status(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function clock() {
    if (!timerEl || !state.startedAt) return;
    var s = Math.floor((Date.now() - state.startedAt) / 1000);
    timerEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* Each participant gets a tile. Audio-only peers still get one so you can
     see who is actually connected — a black rectangle is worse than a name. */
  function tileFor(userId, label) {
    var peer = state.peers[userId];
    if (peer && peer.el) return peer.el;

    var tile = el("div", "calltile");
    tile.dataset.peer = String(userId);

    var video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = userId === state.self;    // never hear yourself
    tile.appendChild(video);

    var face = el("div", "calltile-face");
    face.appendChild(window.Art.avatar(label || String(userId)));
    tile.appendChild(face);

    var name = el("span", "calltile-name", label || "…");
    tile.appendChild(name);

    tile._video = video;
    tiles.appendChild(tile);
    return tile;
  }

  /* A tile shows the video element only when a live video track exists;
     otherwise it falls back to the avatar. */
  function refreshTile(tile, stream) {
    var live = stream && stream.getVideoTracks().some(function (t) {
      return t.readyState === "live" && !t.muted;
    });
    tile.classList.toggle("has-video", !!live);
  }

  function nameOf(id) {
    var peers = (state.call && state.call.peers) || [];
    for (var i = 0; i < peers.length; i++) {
      if (peers[i].id === id) return peers[i].displayName || peers[i].username;
    }
    return "Someone";
  }

  /* --------------------------------------------------------- own media */

  /* Audio first, always. A call that fails because a camera is missing when
     nobody asked for video is a bad trade. */
  function getLocal(wantVideo) {
    if (state.local && (!wantVideo || !state.camOff)) return Promise.resolve(state.local);

    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: wantVideo ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { max: 24 } } : false
    }).then(function (stream) {
      state.local = stream;
      state.camOff = !wantVideo;
      var tile = tileFor(state.self, "You");
      tile._video.srcObject = stream;
      refreshTile(tile, stream);
      return stream;
    }).catch(function (err) {
      /* If video was the problem, fall back to audio rather than failing. */
      if (wantVideo) return getLocal(false);
      throw new Error(err && err.name === "NotAllowedError"
        ? "Microphone access was blocked. Allow it in the address bar, then try again."
        : "No microphone available.");
    });
  }

  function toggleMute() {
    if (!state.local) return;
    state.muted = !state.muted;
    state.local.getAudioTracks().forEach(function (t) { t.enabled = !state.muted; });
    mark("mute", state.muted);
    status(state.muted ? "Muted" : "In a call");
  }

  function toggleCam() {
    if (!state.local) return;
    var tracks = state.local.getVideoTracks();

    if (tracks.length) {
      state.camOff = !state.camOff;
      tracks.forEach(function (t) { t.enabled = !state.camOff; });
      mark("cam", !state.camOff);
      refreshTile(tileFor(state.self, "You"), state.camOff ? null : state.local);
      return;
    }

    /* Started audio-only: acquire a camera now and push it to every peer. */
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } } })
      .then(function (cam) {
        var track = cam.getVideoTracks()[0];
        state.local.addTrack(track);
        state.camOff = false;
        mark("cam", true);
        publishVideo(track);
        var tile = tileFor(state.self, "You");
        tile._video.srcObject = state.local;
        refreshTile(tile, state.local);
      })
      .catch(function () { window.UI.toast("No camera available."); });
  }

  /* Screen sharing swaps the outgoing video track rather than adding a second
     one, so peers don't have to renegotiate to see it. */
  function toggleScreen() {
    if (state.screen) return stopScreen();

    if (!navigator.mediaDevices.getDisplayMedia) {
      window.UI.toast("This browser can't share a screen.");
      return;
    }

    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 15 } }, audio: false })
      .then(function (stream) {
        state.screen = stream;
        var track = stream.getVideoTracks()[0];
        /* The browser's own "Stop sharing" bar bypasses our button. */
        track.addEventListener("ended", stopScreen);
        publishVideo(track);
        mark("screen", true);

        var tile = tileFor(state.self, "You");
        tile._video.srcObject = stream;
        tile.classList.add("has-video", "is-screen");
      })
      .catch(function (err) {
        if (err && err.name === "NotAllowedError") return;   // they cancelled
        window.UI.toast("Screen sharing failed.");
      });
  }

  function stopScreen() {
    if (!state.screen) return;
    state.screen.getTracks().forEach(function (t) { t.stop(); });
    state.screen = null;
    mark("screen", false);

    var cam = state.local ? state.local.getVideoTracks()[0] : null;
    publishVideo(cam || null);

    var tile = tileFor(state.self, "You");
    tile.classList.remove("is-screen");
    tile._video.srcObject = state.local;
    refreshTile(tile, state.camOff ? null : state.local);
  }

  /* Point every peer's video sender at `track`. Passing null blanks it
     without tearing the connection down. */
  function publishVideo(track) {
    Object.keys(state.peers).forEach(function (id) {
      var pc = state.peers[id].pc;
      if (!pc) return;
      var sender = pc.getSenders().filter(function (s) {
        return s.track ? s.track.kind === "video" : false;
      })[0];

      if (sender) sender.replaceTrack(track);
      else if (track) pc.addTrack(track, state.local || new window.MediaStream([track]));
    });
  }

  function mark(act, on) {
    var b = bar.querySelector('[data-act="' + act + '"]');
    if (b) b.classList.toggle("is-on", !!on);
  }

  /* ------------------------------------------------------ peer plumbing */

  function connect(userId) {
    if (state.peers[userId] && state.peers[userId].pc) return state.peers[userId];

    var pc = new window.RTCPeerConnection({ iceServers: state.ice || [] });
    var entry = state.peers[userId] || (state.peers[userId] = {});
    entry.pc = pc;
    entry.el = tileFor(userId, nameOf(userId));
    entry.pending = [];          // candidates that arrived before the answer

    if (state.local) {
      state.local.getTracks().forEach(function (t) { pc.addTrack(t, state.local); });
    }
    if (state.screen) {
      var s = state.screen.getVideoTracks()[0];
      if (s) pc.addTrack(s, state.screen);
    }

    pc.addEventListener("icecandidate", function (e) {
      if (e.candidate) send(userId, "ice", e.candidate.toJSON());
    });

    pc.addEventListener("track", function (e) {
      entry.stream = e.streams[0];
      entry.el._video.srcObject = e.streams[0];
      refreshTile(entry.el, e.streams[0]);
      /* Tracks can go live after the tile is drawn. */
      e.streams[0].addEventListener("addtrack", function () {
        refreshTile(entry.el, e.streams[0]);
      });
    });

    pc.addEventListener("connectionstatechange", function () {
      entry.el.dataset.state = pc.connectionState;
      if (pc.connectionState === "connected" && !state.startedAt) {
        state.startedAt = Date.now();
        status("In a call");
      }
      if (pc.connectionState === "failed") {
        /* Usually a network that blocks direct connections. Say so plainly
           rather than leaving a silent dead tile. */
        entry.el.classList.add("is-failed");
      }
    });

    return entry;
  }

  /* Both sides would otherwise offer at once and collide. The lower user id
     always offers; the higher always waits. */
  function shouldOffer(otherId) {
    return state.self < otherId;
  }

  function offerTo(userId) {
    var entry = connect(userId);
    return entry.pc.createOffer()
      .then(function (offer) { return entry.pc.setLocalDescription(offer); })
      .then(function () { send(userId, "offer", entry.pc.localDescription.toJSON()); })
      .catch(function () { /* retried on the next poll */ });
  }

  function send(to, kind, payload) {
    if (!state.call) return Promise.resolve();
    return window.API.sendSignal(state.call.id, to, kind, payload).catch(function () {});
  }

  function handle(sig) {
    var entry = connect(sig.from);
    var pc = entry.pc;

    if (sig.kind === "offer") {
      return pc.setRemoteDescription(sig.payload)
        .then(function () { return drainCandidates(entry); })
        .then(function () { return pc.createAnswer(); })
        .then(function (answer) { return pc.setLocalDescription(answer); })
        .then(function () { send(sig.from, "answer", pc.localDescription.toJSON()); })
        .catch(function () {});
    }

    if (sig.kind === "answer") {
      return pc.setRemoteDescription(sig.payload)
        .then(function () { return drainCandidates(entry); })
        .catch(function () {});
    }

    if (sig.kind === "ice") {
      /* Candidates routinely arrive before the description they belong to;
         holding them until then is normal, not an error. */
      if (!pc.remoteDescription || !pc.remoteDescription.type) {
        entry.pending.push(sig.payload);
        return Promise.resolve();
      }
      return pc.addIceCandidate(sig.payload).catch(function () {});
    }

    if (sig.kind === "bye") {
      dropPeer(sig.from);
    }
    return Promise.resolve();
  }

  function drainCandidates(entry) {
    var queued = entry.pending || [];
    entry.pending = [];
    return Promise.all(queued.map(function (c) {
      return entry.pc.addIceCandidate(c).catch(function () {});
    }));
  }

  function dropPeer(userId) {
    var entry = state.peers[userId];
    if (!entry) return;
    if (entry.pc) entry.pc.close();
    if (entry.el) entry.el.remove();
    delete state.peers[userId];

    var others = Object.keys(state.peers).filter(function (k) {
      return Number(k) !== state.self;
    });
    if (!others.length && state.call) {
      status("Everyone left");
      window.setTimeout(function () { if (state.call) hangUp(); }, 1500);
    }
  }

  /* --------------------------------------------------------------- loop */

  function pump() {
    if (!state.call) return;

    window.API.pollSignals(state.call.id).then(function (res) {
      if (!state.call) return;
      if (res.call) state.call = res.call;

      if (res.call && res.call.state === "ended") return teardown("Call ended");

      /* Anyone joined and not yet connected gets an offer from whichever
         side owns the offer for that pair. */
      (res.call ? res.call.peers : []).forEach(function (p) {
        if (p.id === state.self || p.state !== "joined") return;
        if (state.peers[p.id] && state.peers[p.id].pc) return;
        if (shouldOffer(p.id)) offerTo(p.id);
        else connect(p.id);        // stand ready to answer
      });

      return res.signals.reduce(function (chain, sig) {
        return chain.then(function () { return handle(sig); });
      }, Promise.resolve());
    }).catch(function (err) {
      if (err && (err.status === 403 || err.status === 404)) teardown("Call ended");
    });

    clock();
  }

  function runLoop() {
    window.clearInterval(state.timer);
    state.timer = window.setInterval(pump, LIVE_POLL);
    pump();
  }

  /* ------------------------------------------------------- start / stop */

  function begin(call, ice, wantVideo) {
    state.call = call;
    state.ice = ice;
    state.startedAt = 0;

    root.hidden = false;
    bar.hidden = false;
    ringEl.hidden = true;
    status("Connecting…");
    mark("cam", !!wantVideo);

    return getLocal(wantVideo).then(function () {
      runLoop();
    }).catch(function (err) {
      window.UI.toast(err.message || "Could not start the call.");
      hangUp();
    });
  }

  function start(opts) {
    opts = opts || {};
    if (!can()) {
      window.UI.toast("This browser can't make calls.");
      return Promise.reject(new Error("unsupported"));
    }
    if (state.call) {
      window.UI.toast("You're already in a call.");
      return Promise.resolve();
    }
    if (!root) build();

    return window.API.startCall({
      userId: opts.userId, threadId: opts.threadId, kind: opts.kind || "audio"
    }).then(function (res) {
      state.self = res.call.startedBy;
      status("Ringing…");
      return begin(res.call, res.iceServers, opts.kind === "video");
    }).catch(function (err) {
      window.UI.toast(err.message || "Could not start the call.");
      throw err;
    });
  }

  function answer(callId, wantVideo) {
    if (!root) build();
    return window.API.joinCall(callId).then(function (res) {
      state.self = res.self;
      return begin(res.call, res.iceServers, !!wantVideo);
    }).catch(function (err) {
      window.UI.toast(err.message || "Could not join that call.");
      dismissRing();
    });
  }

  function hangUp() {
    var id = state.call && state.call.id;
    teardown("");
    if (id) window.API.leaveCall(id).catch(function () {});
  }

  function teardown(message) {
    window.clearInterval(state.timer);
    state.timer = null;

    Object.keys(state.peers).forEach(function (k) {
      if (state.peers[k].pc) state.peers[k].pc.close();
    });
    state.peers = {};
    if (tiles) tiles.innerHTML = "";

    [state.local, state.screen].forEach(function (s) {
      if (s) s.getTracks().forEach(function (t) { t.stop(); });
    });
    state.local = null;
    state.screen = null;
    state.call = null;
    state.startedAt = 0;
    state.muted = false;
    state.camOff = true;

    if (bar) {
      bar.hidden = true;
      bar.classList.remove("is-min");
      ["mute", "cam", "screen"].forEach(function (a) { mark(a, false); });
    }
    if (root) {
      root.classList.remove("is-big");
      root.hidden = !ringEl || ringEl.hidden;    // keep it up if something's ringing
    }
    if (message) window.UI.toast(message);
  }

  /* ------------------------------------------------------------ ringing */

  function drawRing(call) {
    state.ringing = call;
    ringEl.innerHTML = "";

    var caller = (call.peers || []).filter(function (p) { return p.id === call.startedBy; })[0];
    var label = caller ? (caller.displayName || caller.username) : "Someone";

    var top = el("div", "ring-who");
    top.appendChild(window.Art.avatar(caller ? caller.username : "?"));
    var text = el("div", "ring-text");
    text.appendChild(el("strong", null, label));
    text.appendChild(el("span", "ring-kind",
      call.kind === "video" ? "Incoming video call" : "Incoming call"));
    top.appendChild(text);
    ringEl.appendChild(top);

    var acts = el("div", "ring-acts");

    var take = el("button", "btn btn-cta btn-sm", "Answer");
    take.type = "button";
    take.addEventListener("click", function () {
      ringEl.hidden = true;
      answer(call.id, call.kind === "video");
    });
    acts.appendChild(take);

    if (call.kind === "video") {
      var audioOnly = el("button", "btn btn-sm", "Audio only");
      audioOnly.type = "button";
      audioOnly.addEventListener("click", function () {
        ringEl.hidden = true;
        answer(call.id, false);
      });
      acts.appendChild(audioOnly);
    }

    var no = el("button", "btn btn-sm btn-flat", "Decline");
    no.type = "button";
    no.addEventListener("click", function () {
      window.API.leaveCall(call.id).catch(function () {});
      dismissRing();
    });
    acts.appendChild(no);

    ringEl.appendChild(acts);
    ringEl.hidden = false;
    root.hidden = false;
  }

  function dismissRing() {
    state.ringing = null;
    if (ringEl) ringEl.hidden = true;
    if (root && bar && bar.hidden) root.hidden = true;
  }

  /* Watch for calls aimed at me. Cheap enough to run on every page, and it
     has to run everywhere or a call only reaches you on the messages page. */
  function watch() {
    window.API.pendingCalls().then(function (res) {
      /* Only a call where *my* row is still "invited" is ringing at me. A
         group call I've already joined comes back here too. */
      var mine = (res.calls || []).filter(function (c) {
        if (state.call && c.id === state.call.id) return false;
        if (c.state !== "ringing" || c.startedBy === state.self) return false;
        return (c.peers || []).some(function (p) {
          return p.id === state.self && p.state === "invited";
        });
      })[0];

      if (!mine) { if (state.ringing) dismissRing(); return; }
      if (state.call) return;                       // already busy
      if (state.ringing && state.ringing.id === mine.id) return;
      drawRing(mine);
    }).catch(function () { /* offline; try again next tick */ });
  }

  /* ---------------------------------------------------------------- boot */

  function mount() {
    if (!window.Session || !window.API || !window.UI) return;

    window.Session.ready.then(function (s) {
      if (!s.backend || !s.user || !can()) return;
      build();
      state.self = s.user.id;

      state.ringTimer = window.setInterval(watch, RING_POLL);
      watch();

      /* Closing the tab mid-call should free the other side immediately
         rather than leaving them staring at a frozen tile. */
      window.addEventListener("pagehide", function () {
        if (!state.call) return;
        var url = (window.SITE.apiBase || "") + "/api/calls/" + state.call.id + "/leave";
        if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([], { type: "text/plain" }));
        else window.API.leaveCall(state.call.id).catch(function () {});
      });
    });
  }

  window.Calls = {
    start: start,
    answer: answer,
    hangUp: hangUp,
    supported: can,
    active: function () { return !!state.call; }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
