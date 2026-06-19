/**
 * Air Draw — Hand Tracking Canvas
 * Uses MediaPipe Hands for real-time air drawing via webcam.
 *
 * Gestures:
 *   ✏️  Index finger extended, others closed  → Draw
 *   🪄  Open palm (all fingers extended)      → Erase
 *   🗑️  Clear button in UI                    → Clear canvas
 */

// MediaPipe loaded via <script> tags — Hands and Camera are globals
if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
  document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:#fff;flex-direction:column;gap:16px;font-family:sans-serif;text-align:center;padding:20px;">' +
    '<p style="color:#ff5555;font-size:20px;">⚠️ Failed to load MediaPipe</p>' +
    '<p style="color:#999;font-size:14px;">Check your internet connection and refresh.<br>MediaPipe AI model must load from CDN.</p>' +
    '<button onclick="location.reload()" style="padding:10px 24px;background:#ff3366;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">Refresh</button>' +
    '</div>';
  throw new Error('MediaPipe not loaded');
}

/* ============================================================
   DOM REFERENCES
   ============================================================ */
const videoElement      = document.getElementById('video-input');
const drawingCanvas     = document.getElementById('drawing-canvas');
const skeletonCanvas    = document.getElementById('skeleton-canvas');
const ctx               = drawingCanvas.getContext('2d');
const skCtx             = skeletonCanvas.getContext('2d');
const loadingOverlay    = document.getElementById('loading-overlay');
const loadingText       = document.getElementById('loading-text');
const loadingSub        = document.getElementById('loading-sub');
const loadingProgress   = document.getElementById('loading-progress');
const gestureStatus     = document.getElementById('gesture-status');
const statusDot         = document.getElementById('status-dot');

// Controls
const brushColorInput   = document.getElementById('brush-color');
const brushSizeInput    = document.getElementById('brush-size');
const sizeValue         = document.getElementById('size-value');
const smoothingInput    = document.getElementById('smoothing');
const smoothValue       = document.getElementById('smooth-value');
const btnClear          = document.getElementById('btn-clear');
const btnUndo           = document.getElementById('btn-undo');
const btnSave           = document.getElementById('btn-save');
const btnToggleCam      = document.getElementById('btn-toggle-cam');
const btnToggleSkeleton = document.getElementById('btn-toggle-skeleton');
const secondaryDot    = document.getElementById('secondary-dot');
const secondaryStatus = document.getElementById('secondary-status');
const pinchResizeToggle = document.getElementById('toggle-pinch-resize');

/* ============================================================
   STATE
   ============================================================ */
let isDrawing       = false;
let lastPoint       = null;
let currentColor    = '#ff3366';
let brushSize       = 5;
let smoothingFactor = 0.5;
let cameraEnabled   = true;
let skeletonVisible = false;
let undoStack       = [];
let hands           = null;
let camera          = null;
let cameraStream    = null;
let rafId           = null;

// Gesture debounce
let currentGesture  = 'none';
let gestureStartTime = 0;
const GESTURE_HOLD_MS = 250;

// Second-hand state
let secondHandActive   = false;
let pinchResizeEnabled = localStorage.getItem('airdraw_pinchResize') === 'true';
let isPaused           = false;
let pauseGestureHeld   = false;
let pauseGestureStart  = 0;
let secondHandGesture  = 'none';

/* ============================================================
   CANVAS SETUP
   ============================================================ */
function resizeCanvases() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;

  drawingCanvas.width  = w * dpr;
  drawingCanvas.height = h * dpr;
  drawingCanvas.style.width  = w + 'px';
  drawingCanvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  skeletonCanvas.width  = w * dpr;
  skeletonCanvas.height = h * dpr;
  skeletonCanvas.style.width  = w + 'px';
  skeletonCanvas.style.height = h + 'px';
  skCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Restore last undo state after resize
  if (undoStack.length > 0) {
    ctx.putImageData(undoStack[undoStack.length - 1], 0, 0);
  }
}

window.addEventListener('resize', resizeCanvases);
resizeCanvases();

/* ============================================================
   CAMERA-ONLY MODE (instant start, no MediaPipe)
   ============================================================ */
async function startCameraOnly() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera not available. Make sure you are on HTTPS or localhost.');
  }
  // Timeout after 10 seconds in case permission prompt is ignored
  const camPromise = navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: 'user' }
  });
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Camera timed out. Did you allow camera access?')), 10000)
  );
  cameraStream = await Promise.race([camPromise, timeoutPromise]);
  videoElement.srcObject = cameraStream;
  // Wait for video to be ready (with timeout)
  await Promise.race([
    new Promise((resolve) => {
      if (videoElement.readyState >= 2) { videoElement.play(); resolve(); }
      else { videoElement.onloadeddata = () => { videoElement.play(); resolve(); }; }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Video failed to start')), 5000))
  ]);
}

/* ============================================================
   MEDIAPIPE HANDS INITIALIZATION (runs AFTER camera is shown)
   ============================================================ */
async function initMediaPipe() {
  // Show a SUBTLE loading indicator (not a full-screen overlay)
  // Camera is already visible behind it
  setStatus('loading', 'Loading hand model…');

  // Create a small floating indicator
  const indicator = document.getElementById('loading-indicator');
  if (indicator) indicator.style.display = 'block';

  hands = new Hands({
    locateFile: (file) => {
      // All files served from CDN (WASM, model, graph, assets)
      return 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/' + file;
    },
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 0,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  hands.onResults(onHandResults);

  if (cameraStream && cameraStream.active) {
    // Reuse the existing camera stream — no second getUserMedia() call.
    // MediaPipe's Camera always calls getUserMedia() internally, so we
    // use our own rAF loop to feed frames instead.
    const processFrame = async () => {
      if (cameraEnabled) {
        await hands.send({ image: videoElement });
      }
      rafId = requestAnimationFrame(processFrame);
    };
    rafId = requestAnimationFrame(processFrame);
  } else {
    // Fallback: no stream yet — use MediaPipe Camera (calls getUserMedia)
    camera = new Camera(videoElement, {
      onFrame: async () => {
        if (cameraEnabled) {
          await hands.send({ image: videoElement });
        }
      },
      width: 640,
      height: 480,
    });
    await camera.start();
  }

  // Wait for first hand detection — then hand tracking is live
  const readyCheck = setInterval(() => {
    if (currentGesture !== 'none') {
      clearInterval(readyCheck);
      if (indicator) indicator.style.display = 'none';
      setStatus('idle', 'Show index finger to draw');
    }
  }, 200);

  // Fallback: hide indicator after 4s
  setTimeout(() => {
    clearInterval(readyCheck);
    if (indicator) indicator.style.display = 'none';
    if (currentGesture === 'none') {
      setStatus('idle', 'Show index finger to draw');
    }
  }, 4000);
}

/* ============================================================
   HAND LANDMARK HELPERS
   ============================================================ */

/** 3D Euclidean distance between two landmarks */
function dist3D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

/**
 * A finger is "extended" when its tip is significantly farther
 * from the wrist than its PIP joint.
 */
function isFingerExtended(landmarks, tipIdx, pipIdx) {
  const wrist = landmarks[0];
  const tip   = landmarks[tipIdx];
  const pip   = landmarks[pipIdx];
  return dist3D(wrist, tip) > dist3D(wrist, pip) * 1.2;
}

/* ============================================================
   GESTURE DETECTION
   ============================================================ */

/** Index up, all others down → Draw */
function isDrawingGesture(lm) {
  return (
    isFingerExtended(lm, 8, 6)  &&   // index extended
    !isFingerExtended(lm, 12, 10) && // middle closed
    !isFingerExtended(lm, 16, 14) && // ring closed
    !isFingerExtended(lm, 20, 18)    // pinky closed
  );
}

/** All fingers extended → Erase */
function isEraseGesture(lm) {
  return (
    isFingerExtended(lm, 8, 6)  &&
    isFingerExtended(lm, 12, 10) &&
    isFingerExtended(lm, 16, 14) &&
    isFingerExtended(lm, 20, 18) &&
    isFingerExtended(lm, 4, 2)
  );
}

/** Get index-finger-tip position, mirrored & scaled to canvas */
function getIndexTip(lm) {
  const tip = lm[8];
  return {
    x: (1 - tip.x) * window.innerWidth,
    y: tip.y * window.innerHeight,
  };
}

/* ============================================================
   SECOND-HAND HELPERS
   ============================================================ */

/** 2D distance (ignores z) used for pinch detection on the same hand */
function dist2D(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Pinch gesture: thumb tip (4) close to index tip (8),
 * while middle/ring/pinky are curled (NOT extended).
 */
function isPinchGesture(landmarks) {
  const thumbIndexDist = dist2D(landmarks[4], landmarks[8]);
  // Other fingers must be curled
  const middleCurled = !isFingerExtended(landmarks, 12, 10);
  const ringCurled   = !isFingerExtended(landmarks, 16, 14);
  const pinkyCurled  = !isFingerExtended(landmarks, 20, 18);
  return thumbIndexDist < 0.08 && middleCurled && ringCurled && pinkyCurled;
}

/* ============================================================
   GESTURE STATE MACHINE
   ============================================================ */
function detectGesture(landmarks) {
  const now = Date.now();

  if (isEraseGesture(landmarks)) {
    if (currentGesture !== 'erasing') {
      if (now - gestureStartTime > GESTURE_HOLD_MS) {
        currentGesture = 'erasing';
        setStatus('erasing', 'Erasing — move hand to erase');
      }
    }
    return { mode: 'erase', point: getIndexTip(landmarks) };
  }

  if (isDrawingGesture(landmarks)) {
    if (currentGesture !== 'drawing') {
      if (now - gestureStartTime > GESTURE_HOLD_MS) {
        currentGesture = 'drawing';
        setStatus('drawing', 'Drawing…');
      }
    }
    return { mode: 'draw', point: getIndexTip(landmarks) };
  }

  // No recognized gesture
  if (currentGesture !== 'none') {
    currentGesture = 'none';
    gestureStartTime = now;
    setStatus('idle', 'Show index finger to draw, open palm to erase');
  }
  return null;
}

/* ============================================================
   DRAWING LOGIC
   ============================================================ */
function onHandResults(results) {
  // Clear skeleton canvas each frame
  skCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);

  const hands = results.multiHandLandmarks;

  if (!hands || hands.length === 0) {
    // No hands → lift pen
    if (isDrawing) {
      saveUndo();
      isDrawing = false;
      lastPoint = null;
    }
    if (currentGesture !== 'none') {
      currentGesture = 'none';
      gestureStartTime = Date.now();
      setStatus('idle', 'No hand detected');
    }
    secondHandActive = false;
    updateSecondaryUI('none');
    return;
  }

  // --- Primary hand (first detected) → draw / erase ---
  const primaryLandmarks = hands[0];

  // Draw skeleton for primary hand if enabled
  if (skeletonVisible) {
    drawSkeleton(primaryLandmarks);
  }

  // If paused, still detect gestures for status display but skip drawing
  const primaryResult = detectGesture(primaryLandmarks);

  if (isPaused) {
    if (primaryResult) {
      const label = primaryResult.mode === 'draw' ? 'Paused — ✋ to resume' : 'Paused — ✋ to resume';
      setStatus('paused', label);
    } else {
      setStatus('paused', 'Paused — show ✋ (hand 2) to resume');
    }
  }

  if (!primaryResult) {
    if (isDrawing) {
      saveUndo();
      isDrawing = false;
      lastPoint = null;
    }
  } else if (!isPaused) {
    const { mode, point } = primaryResult;

    if (mode === 'erase') {
      eraseAt(point);
    } else {
      // Drawing mode
      if (!isDrawing) {
        isDrawing = true;
        lastPoint = point;
        ctx.beginPath();
        ctx.moveTo(point.x, point.y);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = currentColor;
        ctx.lineWidth = brushSize;
      } else {
        const smoothed = smoothPoint(lastPoint, point, smoothingFactor);
        const midX = (lastPoint.x + smoothed.x) / 2;
        const midY = (lastPoint.y + smoothed.y) / 2;
        ctx.quadraticCurveTo(lastPoint.x, lastPoint.y, midX, midY);
        ctx.stroke();
        lastPoint = smoothed;
      }
    }
  }

  // --- Secondary hand (second detected) → control gestures ---
  if (hands.length >= 2) {
    secondHandActive = true;
    const secondaryLandmarks = hands[1];

    // Draw skeleton for second hand too (different color)
    if (skeletonVisible) {
      drawSkeleton(secondaryLandmarks, true);
    }

    processSecondaryHand(secondaryLandmarks);
  } else {
    secondHandActive = false;
    updateSecondaryUI('none');
  }
}

/* ============================================================
   SECONDARY HAND PROCESSOR
   ============================================================ */
function processSecondaryHand(landmarks) {
  const now = Date.now();

  // Priority 1: 5-finger open palm → toggle pause
  if (isEraseGesture(landmarks)) {
    if (!pauseGestureHeld) {
      pauseGestureHeld = true;
      pauseGestureStart = now;
    } else if (now - pauseGestureStart > GESTURE_HOLD_MS) {
      // Toggle pause
      isPaused = !isPaused;
      pauseGestureHeld = false; // require re-trigger
      if (isPaused) {
        setStatus('paused', 'Paused — show ✋ to resume');
      } else {
        setStatus('idle', 'Resumed — show index finger to draw');
      }
    }
    updateSecondaryUI('pausing');
    secondHandGesture = 'pausing';
    return;
  }

  // Priority 2: Pinch gesture → resize brush (only if enabled)
  if (pinchResizeEnabled && isPinchGesture(landmarks)) {
    pauseGestureHeld = false;
    const dist = dist2D(landmarks[4], landmarks[8]);
    // Map distance to brush size: typical pinch range ~0.01 (tight) to ~0.08 (wide)
    const MIN_PINCH = 0.01;
    const MAX_PINCH = 0.08;
    const normalized = Math.min(Math.max((dist - MIN_PINCH) / (MAX_PINCH - MIN_PINCH), 0), 1);
    const newSize = Math.round(1 + normalized * 29); // 1–30
    brushSize = newSize;
    brushSizeInput.value = brushSize;
    sizeValue.textContent = brushSize;
    updateSecondaryUI('pinching');
    secondHandGesture = 'pinching';
    return;
  }

  // No recognized second-hand gesture
  pauseGestureHeld = false;
  updateSecondaryUI('active');
  secondHandGesture = 'active';
}

/** Update the secondary hand status UI */
function updateSecondaryUI(state) {
  if (!secondaryDot || !secondaryStatus) return;

  secondaryDot.className = 'dot';
  switch (state) {
    case 'none':
      secondaryStatus.textContent = 'No second hand';
      break;
    case 'active':
      secondaryDot.classList.add('active');
      secondaryStatus.textContent = 'Hand 2 active';
      break;
    case 'pinching':
      secondaryDot.classList.add('pinching');
      secondaryStatus.textContent = `Pinch resize: ${brushSize} px`;
      break;
    case 'pausing':
      secondaryDot.classList.add('pausing');
      secondaryStatus.textContent = isPaused ? 'Paused' : 'Hold ✋ to pause';
      break;
  }
}

/** Exponential smoothing */
function smoothPoint(prev, curr, factor) {
  const alpha = 1 - factor;
  return {
    x: prev.x + (curr.x - prev.x) * alpha,
    y: prev.y + (curr.y - prev.y) * alpha,
  };
}

/** Erase with a circular brush */
function eraseAt(point) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(point.x, point.y, brushSize * 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ============================================================
   HAND SKELETON DRAWING
   ============================================================ */
const BONE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],       // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],       // index
  [0, 9], [9, 10], [10, 11], [11, 12],  // middle
  [0, 13], [13, 14], [14, 15], [15, 16],// ring
  [0, 17], [17, 18], [18, 19], [19, 20],// pinky
  [5, 9], [9, 13], [13, 17],            // palm
];

function drawSkeleton(landmarks, isSecondary) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  const boneColor   = isSecondary ? 'rgba(51, 153, 255, 0.5)' : 'rgba(0, 255, 100, 0.6)';
  const dotColor    = isSecondary ? 'rgba(51, 153, 255, 0.7)' : 'rgba(0, 255, 100, 0.8)';
  const tipColor    = isSecondary ? '#3399ff' : '#ff3366';
  const tipSize     = isSecondary ? 5 : 6;

  // Draw bones
  skCtx.strokeStyle = boneColor;
  skCtx.lineWidth = 2;
  skCtx.lineCap = 'round';

  for (const [a, b] of BONE_CONNECTIONS) {
    const p1 = landmarks[a];
    const p2 = landmarks[b];
    skCtx.beginPath();
    skCtx.moveTo((1 - p1.x) * w, p1.y * h);
    skCtx.lineTo((1 - p2.x) * w, p2.y * h);
    skCtx.stroke();
  }

  // Draw landmark dots
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    const x = (1 - lm.x) * w;
    const y = lm.y * h;

    skCtx.beginPath();
    skCtx.arc(x, y, i === 8 ? tipSize : 3, 0, Math.PI * 2);
    skCtx.fillStyle = i === 8 ? tipColor : dotColor;
    skCtx.fill();
  }
}

/* ============================================================
   UNDO / CLEAR / SAVE
   ============================================================ */
function saveUndo() {
  const imageData = ctx.getImageData(0, 0, drawingCanvas.width, drawingCanvas.height);
  undoStack.push(imageData);
  if (undoStack.length > 20) undoStack.shift();
}

function clearCanvas() {
  saveUndo();
  ctx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  setStatus('idle', 'Canvas cleared');
}

function undo() {
  if (undoStack.length === 0) return;
  const prev = undoStack.pop();
  ctx.putImageData(prev, 0, 0);
  setStatus('idle', 'Undo');
}

function saveAsPNG() {
  const link = document.createElement('a');
  link.download = `air-draw-${Date.now()}.png`;
  link.href = drawingCanvas.toDataURL('image/png');
  link.click();
  setStatus('idle', 'Saved!');
}

/* ============================================================
   STATUS UI
   ============================================================ */
function setStatus(type, text) {
  statusDot.className = type;
  gestureStatus.textContent = text;
}

/* ============================================================
   UI EVENT HANDLERS
   ============================================================ */
brushColorInput.addEventListener('input', (e) => {
  currentColor = e.target.value;
});

brushSizeInput.addEventListener('input', (e) => {
  brushSize = parseInt(e.target.value, 10);
  sizeValue.textContent = brushSize;
});

smoothingInput.addEventListener('input', (e) => {
  smoothingFactor = parseInt(e.target.value, 10) / 100;
  smoothValue.textContent = smoothingFactor.toFixed(2);
});

btnClear.addEventListener('click', clearCanvas);
btnUndo.addEventListener('click', undo);
btnSave.addEventListener('click', saveAsPNG);

btnToggleCam.addEventListener('click', async () => {
  cameraEnabled = !cameraEnabled;
  btnToggleCam.classList.toggle('cam-off', !cameraEnabled);
  btnToggleCam.textContent = cameraEnabled ? '📷 Camera' : '📷 Off';

  if (!cameraEnabled) {
    isDrawing = false;
    lastPoint = null;
    setStatus('idle', 'Camera paused');
  } else {
    setStatus('idle', 'Camera resumed — show hand to draw');
  }
});

// Pinch resize toggle (persisted to localStorage)
if (pinchResizeToggle) {
  pinchResizeToggle.checked = pinchResizeEnabled;
  pinchResizeToggle.addEventListener('change', (e) => {
    pinchResizeEnabled = e.target.checked;
    localStorage.setItem('airdraw_pinchResize', pinchResizeEnabled);
  });
}

btnToggleSkeleton.addEventListener('click', () => {
  skeletonVisible = !skeletonVisible;
  skeletonCanvas.style.display = skeletonVisible ? 'block' : 'none';
  btnToggleSkeleton.classList.toggle('active', skeletonVisible);
  if (!skeletonVisible) {
    skCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
  }
});

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  switch (e.key.toLowerCase()) {
    case 'c':
      clearCanvas();
      break;
    case 'z':
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        undo();
      }
      break;
    case 's':
      if (!e.ctrlKey && !e.metaKey) {
        skeletonVisible = !skeletonVisible;
        skeletonCanvas.style.display = skeletonVisible ? 'block' : 'none';
        btnToggleSkeleton.classList.toggle('active', skeletonVisible);
        if (!skeletonVisible) {
          skCtx.clearRect(0, 0, skeletonCanvas.width, skeletonCanvas.height);
        }
      }
      break;
    case '[':
      brushSize = Math.max(1, brushSize - 2);
      brushSizeInput.value = brushSize;
      sizeValue.textContent = brushSize;
      break;
    case ']':
      brushSize = Math.min(30, brushSize + 2);
      brushSizeInput.value = brushSize;
      sizeValue.textContent = brushSize;
      break;
  }
});

/* ============================================================
   LOADING PROGRESS
   ============================================================ */
function setProgress(pct, text, sub) {
  if (loadingProgress) loadingProgress.style.width = pct + '%';
  if (loadingText && text) loadingText.textContent = text;
  if (loadingSub && sub) loadingSub.textContent = sub;
}

/* ============================================================
   BOOT - Camera first, MediaPipe in background
   ============================================================ */
(async () => {
  // Stage 1: Camera (0-30%)
  setProgress(5, 'Requesting camera...', 'Please allow webcam access');
  await startCameraOnly();
  setProgress(30, 'Camera active', 'Loading hand model...');

  // Stage 2: MediaPipe WASM + model (30-90%)
  // Hide overlay so user sees camera behind it
  loadingOverlay.classList.add('hidden');
  setStatus('loading', 'Loading hand model...');

  // Start MediaPipe in background
  const mediaPipePromise = initMediaPipe();

  // Gradually animate progress while MediaPipe loads
  let progress = 30;
  const progressInterval = setInterval(() => {
    progress += Math.random() * 8;
    if (progress > 90) progress = 90;
    setProgress(progress, 'Loading hand model...', 'Downloading AI model (~6MB)');
  }, 500);

  await mediaPipePromise;
  clearInterval(progressInterval);
  setProgress(100, 'Ready!', 'Show index finger to draw');
})().catch((err) => {
  console.error('Failed to initialize:', err);
  setStatus('idle', 'Error: ' + err.message);
  // Make overlay visible and show error
  loadingOverlay.classList.remove('hidden');
  loadingOverlay.style.display = '';
  if (loadingProgress) loadingProgress.style.width = '0%';
  loadingOverlay.innerHTML =
    '<p style="color:#ff5555; font-size:18px;">⚠️ Failed to load</p>' +
    '<p style="color:#999; font-size:14px; max-width:400px; text-align:center;">' +
      err.message + '<br><br>' +
      'Make sure you're serving this page from a secure context (HTTPS or localhost) ' +
      'and have granted webcam permission.' +
    '</p>';
});

