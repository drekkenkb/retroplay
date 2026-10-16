"use strict";

// ROMs live in IndexedDB so they survive reloads (on iPhone especially, picking a file every time is a chore).
// EmulatorJS keeps its own databases for battery saves and save states, keyed by the game name we hand it.

// Keys are EmulatorJS system ids; `badge` is the short label in the game list, `aspect` the shape of the picture.
const SYSTEMS = {
  nes: { name: "NES", badge: "NES", color: "#e5484d", aspect: 4 / 3, exts: ["nes", "unf", "unif", "fds"] },
  snes: { name: "Super Nintendo", badge: "SNES", color: "#8e4ec6", aspect: 4 / 3, exts: ["sfc", "smc", "swc", "fig"] },
  gb: { name: "Game Boy / Color", badge: "GB", color: "#46a758", aspect: 10 / 9, exts: ["gb", "gbc", "dmg", "sgb"] },
  gba: { name: "Game Boy Advance", badge: "GBA", color: "#6e56cf", aspect: 3 / 2, exts: ["gba", "agb"] },
  segaMS: { name: "Master System", badge: "SMS", color: "#3b82f6", aspect: 4 / 3, exts: ["sms", "sg"] },
  segaMD: { name: "Genesis / Mega Drive", badge: "GEN", color: "#db2777", aspect: 4 / 3, exts: ["md", "gen", "smd", "68k", "sgd"] },
  segaGG: { name: "Game Gear", badge: "GG", color: "#0e7490", aspect: 10 / 9, exts: ["gg"] },
  pce: { name: "TurboGrafx-16", badge: "TG16", color: "#f76b15", aspect: 4 / 3, exts: ["pce", "sgx"] },
  atari2600: { name: "Atari 2600", badge: "2600", color: "#a16207", aspect: 4 / 3, exts: ["a26"] },
  atari7800: { name: "Atari 7800", badge: "7800", color: "#b45309", aspect: 4 / 3, exts: ["a78"] },
  ngp: { name: "Neo Geo Pocket", badge: "NGP", color: "#be123c", aspect: 20 / 19, exts: ["ngp", "ngc", "npc"] },
  ws: { name: "WonderSwan", badge: "WS", color: "#4b5563", aspect: 14 / 9, exts: ["ws", "wsc", "pc2"] },
};

// "roms" holds the games; "resume" holds the snapshot taken when leaving a game, keyed by the rom's id.
const db = (() => {
  let opened;
  const open = () => opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("retroplay", 2);
    req.onupgradeneeded = () => {
      const names = req.result.objectStoreNames;
      if (!names.contains("roms")) req.result.createObjectStore("roms", { keyPath: "id" });
      if (!names.contains("resume")) req.result.createObjectStore("resume");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (storeName, mode, fn) => {
    const store = (await open()).transaction(storeName, mode).objectStore(storeName);
    return new Promise((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    all: () => run("roms", "readonly", s => s.getAll()),
    get: id => run("roms", "readonly", s => s.get(id)),
    put: rom => run("roms", "readwrite", s => s.put(rom)),
    delete: id => run("roms", "readwrite", s => s.delete(id)),
    resume: {
      ids: () => run("resume", "readonly", s => s.getAllKeys()),
      get: id => run("resume", "readonly", s => s.get(id)),
      put: (id, state) => run("resume", "readwrite", s => s.put(state, id)),
      delete: id => run("resume", "readwrite", s => s.delete(id)),
    },
  };
})();

const extOf = name => name.toLowerCase().split(".").pop();
const systemForExt = ext => Object.keys(SYSTEMS).find(k => SYSTEMS[k].exts.includes(ext));
const baseName = name => name.replace(/\.[^.]+$/, "");

function ascii(bytes, at, len) {
  return at + len <= bytes.length ? String.fromCharCode(...bytes.subarray(at, at + len)) : "";
}

// File names inside a zip, read from its central directory.
function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let eocd = bytes.length - 22; eocd >= Math.max(0, bytes.length - 65557); eocd--) {
    if (view.getUint32(eocd, true) !== 0x06054b50) continue;
    const names = [];
    let p = view.getUint32(eocd + 16, true);
    for (let i = view.getUint16(eocd + 10, true); i > 0 && p + 46 <= bytes.length; i--) {
      if (view.getUint32(p, true) !== 0x02014b50) break;
      const nameLen = view.getUint16(p + 28, true);
      names.push(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)));
      p += 46 + nameLen + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    return names;
  }
  return [];
}

function detectSystem(name, bytes) {
  const ext = extOf(name);
  if (ext === "zip") {
    const entries = zipEntries(bytes);
    for (const entry of entries) {
      const sys = systemForExt(extOf(entry));
      if (sys) return sys;
    }
    return null;
  }
  return systemForExt(ext) ?? sniffHeader(bytes);
}

// For files with a generic extension like .bin or .rom.
function sniffHeader(bytes) {
  const u8 = at => bytes[at] ?? -1;
  if (ascii(bytes, 0, 4) === "NES\x1a" || ascii(bytes, 0, 4) === "FDS\x1a") return "nes";
  if (u8(0xb2) === 0x96 && u8(4) === 0x24 && u8(5) === 0xff) return "gba";
  if (u8(0x104) === 0xce && u8(0x105) === 0xed && u8(0x106) === 0x66) return "gb";
  if (ascii(bytes, 0x100, 4) === "SEGA" || ascii(bytes, 0x101, 4) === "SEGA") return "segaMD";
  if (ascii(bytes, 1, 9) === "ATARI7800") return "atari7800";
  for (const at of [0x7ff0, 0x3ff0, 0x1ff0]) {
    if (ascii(bytes, at, 8) !== "TMR SEGA") continue;
    // The region nibble tells Master System (3, 4) from Game Gear (5-7).
    return (u8(at + 15) >> 4) >= 5 ? "segaGG" : "segaMS";
  }
  if (ascii(bytes, 0, 28).includes("SNK CORPORATION") || ascii(bytes, 0, 28).includes("COPYRIGHT BY SNK")) return "ngp";
  return null;
}

function askSystem(name) {
  const dialog = document.getElementById("pick-system");
  const buttons = document.getElementById("pick-buttons");
  if (!buttons.children.length) {
    buttons.append(...Object.entries(SYSTEMS).map(([id, sys]) => {
      const b = document.createElement("button");
      b.value = id;
      b.textContent = sys.name;
      b.style.background = sys.color;
      return b;
    }));
  }
  document.getElementById("pick-name").textContent = name;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue || null), { once: true }));
}

async function addFiles(files) {
  let last;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const system = detectSystem(file.name, bytes) ?? await askSystem(file.name);
    if (!system) continue;
    last = { id: crypto.randomUUID(), name: file.name, system, added: Date.now(), lastPlayed: 0, data: bytes.buffer };
    // The same file added twice replaces the old copy instead of listing it twice.
    const dupe = (await db.all()).find(r => r.name === file.name && r.system === system);
    if (dupe) last.id = dupe.id;
    await db.put(last);
  }
  await renderLibrary();
  // Picking a single ROM is almost always "I want to play this now".
  if (files.length === 1 && last) play(last.id);
}

async function renderLibrary() {
  const roms = (await db.all()).sort((a, b) => (b.lastPlayed || b.added) - (a.lastPlayed || a.added));
  const resumable = new Set(await db.resume.ids());
  const list = document.getElementById("game-list");
  list.replaceChildren(...roms.map(rom => {
    const li = document.createElement("li");
    li.className = "game";
    li.innerHTML = `<button class="play" type="button"><span class="badge"></span>
        <span class="title"><span class="name"></span><span class="resume-hint" hidden>Resumes where you left off</span></span></button>
      <button class="delete" type="button" aria-label="Remove">×</button>`;
    const badge = li.querySelector(".badge");
    const sys = SYSTEMS[rom.system];
    badge.textContent = sys.badge;
    badge.style.background = sys.color;
    badge.title = sys.name;
    li.querySelector(".name").textContent = baseName(rom.name);
    li.querySelector(".resume-hint").hidden = !resumable.has(rom.id);
    li.querySelector(".play").onclick = () => play(rom.id);
    li.querySelector(".delete").onclick = async () => {
      if (!confirm(`Remove ${baseName(rom.name)} from this device? Its saves are kept.`)) return;
      await db.delete(rom.id);
      await db.resume.delete(rom.id);
      renderLibrary();
    };
    return li;
  }));
  document.getElementById("games").hidden = roms.length === 0;
}

let playingId = null;

async function play(id) {
  const rom = await db.get(id);
  if (!rom) return;
  playingId = id;
  const resumeState = await db.resume.get(id);
  rom.lastPlayed = Date.now();
  db.put(rom);

  document.getElementById("library").hidden = true;
  document.getElementById("player").hidden = false;

  Object.assign(window, {
    EJS_player: "#game",
    EJS_core: rom.system,
    EJS_gameUrl: new File([rom.data], rom.name),
    EJS_gameName: baseName(rom.name),
    EJS_pathtodata: "emulatorjs/data/",
    EJS_color: "#e5484d",
    EJS_backgroundColor: "#000",
    EJS_threads: false,
    EJS_startOnLoaded: false,
    // Skip the Start button: tapping the game (or picking its file) already counts as the tap browsers want before
    // playing sound.
    EJS_ready: pressStart,
    // EmulatorJS loads this snapshot as soon as the game starts.
    ...(resumeState && { EJS_loadStateURL: new Uint8Array(resumeState) }),
    EJS_onGameStart: () => {
      layoutGame();
      startAutosave();
      // The touch controls come and go (menu open, rotation), so follow their visibility too.
      const pad = document.querySelector(".ejs_virtualGamepad_parent");
      if (pad) new MutationObserver(layoutGame).observe(pad, { attributes: true, attributeFilter: ["style"] });
    },
  });
  gameAspect = rom.system in SYSTEMS ? SYSTEMS[rom.system].aspect : 4 / 3;
  const loader = document.createElement("script");
  loader.src = "emulatorjs/data/loader.js";
  document.body.append(loader);
}

function pressStart() {
  // EmulatorJS turns on its touch controls only when a finger presses Start, so tell it about the touchscreen first.
  if (matchMedia("(pointer: coarse)").matches) window.EJS_emulator.touch = true;
  document.querySelector("#game .ejs_start_button")?.click();
}

// Nothing may cover the picture. The canvas gets its own box, sized to the largest picture that fits beside or
// between whatever is on screen: our back button, the emulator's menu button and its touch controls. Two shapes are
// tried: a full-height column between the controls on the left and right (landscape) and a full-width row between
// the controls at the top and bottom (portrait). The bigger picture wins.
let gameAspect = 4 / 3;
const GAP = 6;

function layoutGame() {
  const player = document.getElementById("player");
  const canvas = document.querySelector("#game .ejs_canvas");
  if (player.hidden || !canvas) return;
  const pad = document.querySelector(".ejs_virtualGamepad_parent");
  // While the emulator hides its touch controls (menu open), keep the layout we have rather than growing into them.
  if (window.EJS_emulator?.touch && !document.body.classList.contains("has-controller") && pad?.style.display === "none") return;

  const inset = readSafeArea();
  const W = player.clientWidth, H = player.clientHeight;
  const obstacles = [...document.querySelectorAll(
    "#back, .ejs_virtualGamepad_open, .ejs_virtualGamepad_button, .ejs_dpad_main, .ejs_virtualGamepad_parent .nipple"
  )].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden")
    .map(el => el.getBoundingClientRect());

  const fit = (x0, y0, x1, y1) => {
    const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
    const pw = Math.min(w, h * gameAspect), ph = pw / gameAspect;
    return { x: x0 + (w - pw) / 2, y: y0 + (h - ph) / 2, w: pw, h: ph };
  };
  const top = inset.top, bottom = H - inset.bottom, left = inset.left, right = W - inset.right;

  let colL = left, colR = right, colOk = true;
  for (const r of obstacles) {
    const cx = (r.left + r.right) / 2;
    if (r.right > W / 2 && r.left < W / 2) colOk = false;
    else if (cx < W / 2) colL = Math.max(colL, r.right + GAP);
    else colR = Math.min(colR, r.left - GAP);
  }
  let rowT = top, rowB = bottom, rowOk = true;
  for (const r of obstacles) {
    const cy = (r.top + r.bottom) / 2;
    if (r.bottom > H / 2 && r.top < H / 2) rowOk = false;
    else if (cy < H / 2) rowT = Math.max(rowT, r.bottom + GAP);
    else rowB = Math.min(rowB, r.top - GAP);
  }
  const col = colOk && fit(colL, top, colR, bottom);
  const row = rowOk && fit(left, rowT, right, rowB);
  // In a row, sit the picture right under the top bar rather than floating midway down to the controls.
  if (row) row.y = rowT;
  // A screen too small for either shape keeps the full area rather than vanishing.
  const box = [col, row].filter(Boolean).sort((a, b) => b.w - a.w)[0] ?? fit(left, top, right, bottom);

  Object.assign(canvas.style, { left: box.x + "px", top: box.y + "px", width: box.w + "px", height: box.h + "px" });
}

function readSafeArea() {
  const probe = document.getElementById("safe-area");
  const s = getComputedStyle(probe);
  return { top: parseFloat(s.paddingTop), right: parseFloat(s.paddingRight), bottom: parseFloat(s.paddingBottom), left: parseFloat(s.paddingLeft) };
}

addEventListener("resize", () => requestAnimationFrame(layoutGame));

function saveBatteryRam() {
  try {
    if (window.EJS_emulator?.started) window.EJS_emulator.gameManager.saveSaveFiles();
  } catch (e) {
    console.warn("Couldn't save game data", e);
  }
}

// EmulatorJS saves on beforeunload, which iOS often skips; pagehide and backgrounding are the reliable signals there.
addEventListener("pagehide", saveBatteryRam);
// Also covers closing the app or switching away without pressing back, as long as the browser gives us the moment.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden") return;
  saveBatteryRam();
  saveResumeState();
});

// A physical controller makes the on-screen one redundant. Browsers only report a controller after its first button
// press, so the touch controls stay until then.
function updateTouchControls() {
  const connected = [...(navigator.getGamepads?.() ?? [])].some(Boolean);
  document.body.classList.toggle("has-controller", connected);
  layoutGame();
}
addEventListener("gamepadconnected", updateTouchControls);
addEventListener("gamepaddisconnected", updateTouchControls);

// Snapshot the whole machine so the next launch picks up exactly here.
async function saveResumeState() {
  const emu = window.EJS_emulator;
  if (!playingId || !emu?.started) return;
  try {
    await db.resume.put(playingId, emu.gameManager.getState().slice().buffer);
  } catch (e) {
    console.warn("Couldn't save the resume point", e);
  }
}

// A safety net for when the page never gets a chance to save on the way out: a crash, the tab being killed in the
// background, or the browser closing. Only runs while the game is visible and not paused.
const AUTOSAVE_MS = 30_000;
let autosaveTimer = null;
function startAutosave() {
  autosaveTimer ??= setInterval(() => {
    if (document.visibilityState !== "visible" || window.EJS_emulator?.paused) return;
    saveBatteryRam();
    saveResumeState();
  }, AUTOSAVE_MS);
}

document.getElementById("back").onclick = async () => {
  saveBatteryRam();
  await saveResumeState();
  // EmulatorJS can't be torn down and restarted in place, so going back is a fresh page load.
  location.reload();
};

document.getElementById("file").onchange = e => {
  addFiles([...e.target.files]);
  e.target.value = "";
};

const drop = document.getElementById("drop");
drop.ondragover = e => { e.preventDefault(); drop.classList.add("dragging"); };
drop.ondragleave = () => drop.classList.remove("dragging");
drop.ondrop = e => {
  e.preventDefault();
  drop.classList.remove("dragging");
  addFiles([...e.dataTransfer.files]);
};

renderLibrary();
navigator.serviceWorker?.register("sw.js");
