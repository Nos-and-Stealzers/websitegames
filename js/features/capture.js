/* Image capture for chat: screen, camera, or a file off disk.
   Everything is downscaled and re-encoded in the browser before it is sent,
   so the server only ever receives something already within its limits. */
(function () {
  "use strict";

  var MAX_EDGE = 1280;
  var TARGET_BYTES = 550 * 1024;      // server rejects over 600 KB

  function supported() {
    return {
      screen: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
      camera: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      file: true
    };
  }

  /* Draw onto a canvas at a sane size, then step the JPEG quality down until
     it fits. PNG screenshots of a game can be several megabytes otherwise. */
  function encode(source, width, height) {
    var scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    var w = Math.max(1, Math.round(width * scale));
    var h = Math.max(1, Math.round(height * scale));

    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(source, 0, 0, w, h);

    var quality = 0.85;
    var url = canvas.toDataURL("image/jpeg", quality);
    while (url.length * 0.75 > TARGET_BYTES && quality > 0.35) {
      quality -= 0.12;
      url = canvas.toDataURL("image/jpeg", quality);
    }
    return { dataUrl: url, width: w, height: h };
  }

  function frameFromStream(stream) {
    return new Promise(function (resolve, reject) {
      var video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;

      var done = false;
      function finish(fn) {
        if (done) return;
        done = true;
        stream.getTracks().forEach(function (t) { t.stop(); });
        fn();
      }

      video.addEventListener("loadedmetadata", function () {
        video.play().then(function () {
          /* One frame of settle time, or the capture can come back black. */
          window.setTimeout(function () {
            try {
              var shot = encode(video, video.videoWidth, video.videoHeight);
              finish(function () { resolve(shot); });
            } catch (err) {
              finish(function () { reject(err); });
            }
          }, 220);
        }).catch(function (err) { finish(function () { reject(err); }); });
      });

      window.setTimeout(function () {
        finish(function () { reject(new Error("Capture timed out.")); });
      }, 15000);
    });
  }

  /* The browser will not let a page silently screenshot itself, and a
     cross-origin game frame can never be read into a canvas. getDisplayMedia
     is the only route: the user picks what to share, which is also the only
     honest way to do it. */
  function screenshot() {
    if (!supported().screen) {
      return Promise.reject(new Error("This browser can't capture the screen."));
    }
    return navigator.mediaDevices
      .getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      .then(frameFromStream)
      .then(function (shot) { return Object.assign(shot, { kind: "screenshot" }); });
  }

  function camera(facing) {
    if (!supported().camera) {
      return Promise.reject(new Error("This browser has no camera access."));
    }
    return navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: facing || "user", width: { ideal: 1280 } },
        audio: false
      })
      .then(frameFromStream)
      .then(function (shot) { return Object.assign(shot, { kind: "camera" }); });
  }

  function fromFile() {
    return new Promise(function (resolve, reject) {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.addEventListener("change", function () {
        var file = input.files && input.files[0];
        if (!file) return reject(new Error("No file chosen."));
        if (!/^image\//.test(file.type)) return reject(new Error("That isn't an image."));

        var img = new Image();
        var url = URL.createObjectURL(file);
        img.onload = function () {
          try {
            var shot = encode(img, img.naturalWidth, img.naturalHeight);
            URL.revokeObjectURL(url);
            resolve(Object.assign(shot, { kind: "upload" }));
          } catch (err) {
            URL.revokeObjectURL(url);
            reject(err);
          }
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error("That image could not be read."));
        };
        img.src = url;
      });
      input.click();
    });
  }

  /* Live camera preview with a shutter, rather than a blind grab. */
  function cameraDialog() {
    return new Promise(function (resolve, reject) {
      if (!supported().camera) {
        reject(new Error("This browser has no camera access."));
        return;
      }

      var el = window.UI.el;
      var root = el("div", "sheet");
      var card = el("div", "sheet-card cam-card");
      var head = el("div", "sheet-head");
      head.appendChild(el("span", "label", "Camera"));
      var close = el("button", "btn btn-sq", "✕");
      close.type = "button";
      head.appendChild(close);
      card.appendChild(head);

      var video = document.createElement("video");
      video.className = "cam-view";
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      card.appendChild(video);

      var bar = el("div", "cam-bar");
      var shoot = el("button", "btn btn-cta", "◉ Take photo");
      shoot.type = "button";
      var flip = el("button", "btn", "⇄ Flip");
      flip.type = "button";
      bar.appendChild(shoot);
      bar.appendChild(flip);
      card.appendChild(bar);

      root.appendChild(card);
      document.body.appendChild(root);

      var stream = null;
      var facing = "user";
      var settled = false;

      function stop() {
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null;
      }
      function teardown() { stop(); root.remove(); }

      function start() {
        stop();
        navigator.mediaDevices
          .getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 } }, audio: false })
          .then(function (s) { stream = s; video.srcObject = s; })
          .catch(function (err) {
            if (settled) return;
            settled = true;
            teardown();
            reject(err);
          });
      }

      flip.addEventListener("click", function () {
        facing = facing === "user" ? "environment" : "user";
        start();
      });

      shoot.addEventListener("click", function () {
        if (settled || !video.videoWidth) return;
        settled = true;
        var shot = encode(video, video.videoWidth, video.videoHeight);
        teardown();
        resolve(Object.assign(shot, { kind: "camera" }));
      });

      function cancel() {
        if (settled) return;
        settled = true;
        teardown();
        reject(new Error("cancelled"));
      }
      close.addEventListener("click", cancel);
      root.addEventListener("click", function (e) { if (e.target === root) cancel(); });

      start();
    });
  }

  window.Capture = {
    supported: supported,
    screenshot: screenshot,
    camera: camera,
    cameraDialog: cameraDialog,
    fromFile: fromFile
  };
})();
