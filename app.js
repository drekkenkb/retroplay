"use strict";

// ROMs live in IndexedDB so they survive reloads (on iPhone especially, picking a file every time is a chore).
// EmulatorJS keeps its own databases for battery saves and save states, keyed by the game name we hand it.

const SYSTEMS = {
  nes: { label: "NES", exts: ["nes", "unf", "unif", "fds"] },
  segaMS: { label: "SMS", exts: ["sms", "sg"] },
};

const db = (() => {
  let opened;
  const open = () => opened ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("retroplay", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("roms", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, fn) => {
    const store = (await open()).transaction("roms", mode).objectStore("roms");
    return new Promise((resolve, reject) => {
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    all: () => run("readonly", s => s.getAll()),
    get: id => run("readonly", s => s.get(id)),
    put: rom => run("readwrite", s => s.put(rom)),
    delete: id => run("readwrite", s => s.delete(id)),
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
    for (const entry of zipEntries(bytes)) {
      const sys = systemForExt(extOf(entry));
      if (sys) return sys;
    }
    return null;
  }
  const byExt = systemForExt(ext);
  if (byExt) return byExt;
  if (ascii(bytes, 0, 4) === "NES\x1a" || ascii(bytes, 0, 4) === "FDS\x1a") return "nes";
  if ([0x7ff0, 0x3ff0, 0x1ff0].some(at => ascii(bytes, at, 8) === "TMR SEGA")) return "segaMS";
  return null;
}

function askSystem(name) {
  const dialog = document.getElementById("pick-system");
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
  const list = document.getElementById("game-list");
  list.replaceChildren(...roms.map(rom => {
    const li = document.createElement("li");
    li.className = "game";
    li.innerHTML = `<button class="play" type="button"><span class="badge"></span><span class="name"></span></button>
      <button class="delete" type="button" aria-label="Remove">×</button>`;
    const badge = li.querySelector(".badge");
    badge.classList.add(rom.system);
    badge.textContent = SYSTEMS[rom.system].label;
    li.querySelector(".name").textContent = baseName(rom.name);
    li.querySelector(".play").onclick = () => play(rom.id);
    li.querySelector(".delete").onclick = async () => {
      if (!confirm(`Remove ${baseName(rom.name)} from this device? Its saves are kept.`)) return;
      await db.delete(rom.id);
      renderLibrary();
    };
    return li;
  }));
  document.getElementById("games").hidden = roms.length === 0;
}

async function play(id) {
  const rom = await db.get(id);
  if (!rom) return;
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
  });
  const loader = document.createElement("script");
  loader.src = "emulatorjs/data/loader.js";
  document.body.append(loader);
}

function saveBatteryRam() {
  try {
    if (window.EJS_emulator?.started) window.EJS_emulator.gameManager.saveSaveFiles();
  } catch (e) {
    console.warn("Couldn't save game data", e);
  }
}

// EmulatorJS saves on beforeunload, which iOS often skips; pagehide and backgrounding are the reliable signals there.
addEventListener("pagehide", saveBatteryRam);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && saveBatteryRam());

document.getElementById("back").onclick = () => {
  saveBatteryRam();
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
