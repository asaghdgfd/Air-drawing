/**
 * Simple Hand Tracker — No WebGL, No AI model needed
 * Uses color-based skin detection to find hands in the video feed
 * Works on any browser with camera access
 */
(function(){
  'use strict';

  /* ── Skin color detection ── */
  function isSkinColor(r, g, b) {
    // Multiple skin color rules for different skin tones
    // Rule 1: General skin detection
    if (r > 95 && g > 40 && b > 20 &&
        r > g && r > b &&
        Math.abs(r - g) > 15 &&
        r - g > 15 && r - b > 15) return true;
    // Rule 2: Lighter skin
    if (r > 220 && g > 210 && b > 200 &&
        Math.abs(r - g) <= 15 && r > b && g > b) return true;
    // Rule 3: Darker skin
    if (r > 60 && g > 40 && b > 20 &&
        r > g && g > b &&
        r - g > 10 && g - b > 5) return true;
    return false;
  }

  /* ── Find hand regions ── */
  function findHands(video, width, height) {
    // Create offscreen canvas to analyze video frame
    var offCanvas = document.createElement('canvas');
    offCanvas.width = 160;  // Small for performance
    offCanvas.height = 120;
    var offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
    offCtx.drawImage(video, 0, 0, 160, 120);

    var imageData = offCtx.getImageData(0, 0, 160, 120);
    var data = imageData.data;
    var w = 160, h = 120;

    // Create binary skin map
    var skinMap = new Uint8Array(w * h);
    var skinCount = 0;
    for (var i = 0; i < data.length; i += 4) {
      var idx = i / 4;
      if (isSkinColor(data[i], data[i+1], data[i+2])) {
        skinMap[idx] = 1;
        skinCount++;
      }
    }

    // If too little or too much skin, probably no hand
    if (skinCount < 100 || skinCount > w * h * 0.8) return [];

    // Find connected components (simple flood fill)
    var visited = new Uint8Array(w * h);
    var regions = [];

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var idx = y * w + x;
        if (skinMap[idx] && !visited[idx]) {
          // Flood fill to find connected region
          var region = { minX: x, maxX: x, minY: y, maxY: y, pixels: 0 };
          var stack = [idx];
          visited[idx] = 1;

          while (stack.length > 0) {
            var ci = stack.pop();
            var cx = ci % w;
            var cy = Math.floor(ci / w);
            region.pixels++;
            if (cx < region.minX) region.minX = cx;
            if (cx > region.maxX) region.maxX = cx;
            if (cy < region.minY) region.minY = cy;
            if (cy > region.maxY) region.maxY = cy;

            // Check 4 neighbors
            var neighbors = [
              cy > 0 ? (cy-1)*w+cx : -1,
              cy < h-1 ? (cy+1)*w+cx : -1,
              cx > 0 ? cy*w+(cx-1) : -1,
              cx < w-1 ? cy*w+(cx+1) : -1
            ];
            for (var n = 0; n < neighbors.length; n++) {
              var ni = neighbors[n];
              if (ni >= 0 && skinMap[ni] && !visited[ni]) {
                visited[ni] = 1;
                stack.push(ni);
              }
            }
          }

          // Only keep regions that are hand-sized (not too small, not too big)
          var regionW = region.maxX - region.minX;
          var regionH = region.maxY - region.minY;
          if (region.pixels > 50 && regionW > 5 && regionH > 5 &&
              region.pixels < w * h * 0.5) {
            // Scale coordinates back to video size
            var scaleX = width / w;
            var scaleY = height / h;
            regions.push({
              bbox: [
                region.minX * scaleX,
                region.minY * scaleY,
                regionW * scaleX,
                regionH * scaleY
              ],
              centerX: (region.minX + regionW / 2) * scaleX,
              centerY: (region.minY + regionH / 2) * scaleY,
              pixels: region.pixels,
              aspect: regionH / Math.max(regionW, 1)
            });
          }
        }
      }
    }

    // Sort by size (largest first), return top 2
    regions.sort(function(a, b) { return b.pixels - a.pixels; });
    return regions.slice(0, 2);
  }

  /* ── Public API ── */
  window.simpleHandTracker = {
    load: function() {
      // No model to load — just return immediately
      return Promise.resolve({ loaded: true });
    },
    detect: function(video) {
      if (!video || video.readyState < 2) return [];
      return findHands(video, video.videoWidth || 640, video.videoHeight || 480);
    }
  };
})();
