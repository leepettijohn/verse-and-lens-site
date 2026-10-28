// Rebuilds share/index.html from whatever is sitting in the share/ folder.
// Netlify runs this on every deploy. Nothing to install.
//
// Counts as a page:
//   share/reading-plan.html            ->  /share/reading-plan.html
//   share/reading-plan/index.html      ->  /share/reading-plan/
// Ignored: share/index.html itself, anything starting with "_" or "."
//
// Label = the page's <title>, falling back to a tidied filename.
// Date  = <meta name="date" content="2026-10-01"> if present,
//         else the date the file was first committed to git.
// Code  = set SHARE_CODE in Netlify > Site configuration > Environment variables.
//         The list is encrypted with it (AES-256-GCM, key from PBKDF2-SHA256,
//         600,000 rounds, random salt each build). Neither the code nor the list
//         is in the page; only the right code can unscramble it in the browser.
//         Use a long code (four random words, 20+ characters): a short one can be
//         guessed offline against the scrambled list.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SHARE_DIR = path.join(ROOT, "share");
const OUT = path.join(SHARE_DIR, "index.html");
// Copy always hands out the live link, wherever the index is opened from.
const SHARE_URL = "https://verseandlens.com/share/";

const tidy = (n) =>
  n.replace(/\.html?$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function readHtml(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (e) { return ""; }
}

function titleOf(html, fallback) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1].trim()) return fallback;
  return m[1].trim().replace(/\s+/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function dateOf(html, file) {
  const m = html.match(/<meta\s+name=["']date["']\s+content=["']([^"']+)["']/i);
  if (m) {
    // A bare YYYY-MM-DD parses as UTC midnight, which can slip back a day
    // once formatted in Central time, so anchor it at midday.
    const raw = /^\d{4}-\d{2}-\d{2}$/.test(m[1].trim()) ? m[1].trim() + "T12:00:00" : m[1];
    const d = new Date(raw);
    if (!isNaN(d)) return d;
  }
  try {
    const rel = path.relative(ROOT, file);
    const log = execSync(`git log --diff-filter=A --format=%aI -- "${rel}"`, {
      cwd: ROOT, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim().split("\n").filter(Boolean);
    if (log.length) return new Date(log[log.length - 1]);
  } catch (e) {}
  return new Date();
}

function collect() {
  if (!fs.existsSync(SHARE_DIR)) return [];
  const found = [];
  for (const e of fs.readdirSync(SHARE_DIR, { withFileTypes: true })) {
    const n = e.name;
    if (n.startsWith("_") || n.startsWith(".")) continue;
    if (e.isFile() && /\.html?$/i.test(n) && n.toLowerCase() !== "index.html") {
      found.push({ href: n, file: path.join(SHARE_DIR, n), fallback: tidy(n) });
    } else if (e.isDirectory()) {
      const f = path.join(SHARE_DIR, n, "index.html");
      if (fs.existsSync(f)) found.push({ href: n + "/", file: f, fallback: tidy(n) });
    }
  }
  return found
    .map((p) => {
      const html = readHtml(p.file);
      return { href: p.href, title: titleOf(html, p.fallback), date: dateOf(html, p.file) };
    })
    .sort((a, b) => b.date - a.date);
}

const KDF_ROUNDS = 600000;

// Encrypts the list so the browser can open it with the code. WebCrypto's AES-GCM
// expects the auth tag on the end of the ciphertext, so it's appended here.
function seal(text, code) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(code, salt, KDF_ROUNDS, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  return { salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64") };
}

function render(pages, code) {
  const fmt = (d) =>
    d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Chicago" });

  const rows = pages.map((p) => `      <li>
        <div class="info">
          <a href="${esc(p.href)}" target="_blank" rel="noopener">${esc(p.title)}</a>
          <span class="date">${esc(fmt(p.date))}</span>
        </div>
        <button class="copy" type="button" data-url="${esc(SHARE_URL + p.href)}">Copy</button>
      </li>`).join("\n");

  const listHtml = `  <h1>Shared Pages</h1>
  <p class="sub">${pages.length} page${pages.length === 1 ? "" : "s"} &middot; newest first &middot; Copy puts the link on your clipboard</p>
  ${pages.length ? `<ul>\n${rows}\n  </ul>` : `<p class="empty">Nothing in share/ yet.</p>`}`;
  const sealed = code ? JSON.stringify(seal(listHtml, code)) : "null";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Shared Pages · Verse &amp; Lens</title>
<meta name="theme-color" content="#3A4E31">
<meta name="color-scheme" content="light">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,700&family=IBM+Plex+Mono:wght@400&family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,700;1,7..72,400&display=swap" rel="stylesheet">
<style>
  /* Verse & Lens tokens, matched to the site's index.html */
  :root {
    --paper:#FBF7EC; --vellum:#F0E8D6; --clay:#CBB394; --loam:#8A6A47;
    --stone:#7D7466; --bark:#2E241C; --canopy:#3A4E31;
    --display:"Fraunces", Georgia, serif;
    --body:"Literata", Georgia, serif;
    --mono:"IBM Plex Mono", ui-monospace, monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--bark);
         font-family:var(--body); font-size:17px; line-height:1.6; font-optical-sizing:auto; }
  :focus-visible { outline:2px solid var(--canopy); outline-offset:3px; }
  .band { background:var(--canopy); color:var(--paper); }
  .band :focus-visible { outline-color:var(--paper); }
  .band .inner { max-width:680px; margin:0 auto; padding:16px; display:flex;
                 align-items:center; justify-content:space-between; gap:12px; }
  .band img { display:block; width:56px; height:auto; }
  .tag { font-family:var(--mono); font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:var(--vellum); }
  main { max-width:680px; margin:0 auto; padding:40px 16px 64px; }
  h1 { font-family:var(--display); font-weight:700; letter-spacing:-0.01em;
       font-size:34px; line-height:1.1; margin:0 0 6px; }
  .sub { color:var(--stone); margin:0 0 28px; font-size:14px; }
  ul { list-style:none; padding:0; margin:0; }
  li { display:flex; align-items:center; gap:12px; background:var(--vellum);
       border-left:3px solid var(--canopy); border-radius:2px;
       padding:14px 16px; margin-bottom:10px; }
  .info { flex:1; min-width:0; }
  .info a { color:var(--bark); font-weight:700; text-decoration:none; display:block; overflow-wrap:anywhere; }
  .info a:hover { color:var(--canopy); text-decoration:underline; text-underline-offset:0.18em; }
  .date { font-family:var(--mono); color:var(--stone); font-size:13px; }
  button { font:inherit; font-size:15px; font-weight:700; border:1px solid var(--stone); background:var(--paper);
           color:var(--bark); border-radius:2px; padding:7px 14px; cursor:pointer; }
  button:hover { border-color:var(--canopy); color:var(--canopy); }
  button.primary { background:var(--paper); border-color:var(--paper); color:var(--canopy); width:100%; padding:10px 14px; }
  button.primary:hover { background:var(--vellum); border-color:var(--vellum); }
  #gate { min-height:100vh; background:var(--canopy); color:var(--paper); padding:14vh 16px 32px; }
  #gate .inner { max-width:340px; margin:0 auto; text-align:center; }
  #gate img { display:block; width:120px; height:auto; margin:0 auto 32px; }
  #gate h1 { font-size:30px; }
  #gate input { font:inherit; width:100%; padding:11px 12px; border:1px solid var(--clay);
                border-radius:2px; background:var(--paper); color:var(--bark); margin:18px 0 10px;
                text-align:center; letter-spacing:1px; }
  #gate input:focus-visible { outline:2px solid var(--paper); outline-offset:2px; }
  #err { color:var(--vellum); font-size:14px; min-height:20px; margin-top:12px; }
  .hidden { display:none !important; }
  .empty { color:var(--stone); }
  footer { border-top:1px solid var(--clay); max-width:680px; margin:0 auto; padding:20px 16px 32px;
           font-family:var(--mono); font-size:12px; color:var(--stone); }
</style>
</head>
<body>
<div id="gate">
  <div class="inner">
    <a href="/"><img src="/assets/verse-and-lens-mark-reversed.svg" width="741" height="606" alt="Verse &amp; Lens"></a>
    <h1>Shared Pages</h1>
    <form id="codeForm">
      <label for="code" class="hidden">Code</label>
      <input id="code" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" placeholder="Code" autofocus>
      <button type="submit" class="primary">Open</button>
    </form>
    <div id="err" role="status">${code ? "" : "SHARE_CODE is not set in Netlify yet."}</div>
  </div>
</div>

<div id="list" class="hidden">
<header class="band"><div class="inner">
  <a href="/"><img src="/assets/verse-and-lens-mark-reversed.svg" width="741" height="606" alt="Verse &amp; Lens"></a>
  <span class="tag">Shared pages</span>
</div></header>
<main id="main"></main>
<footer>Verse &amp; Lens &middot; verseandlens.com</footer>
</div>

<script>
  // The list is encrypted; only the right code turns it back into the page list.
  var SEALED = ${sealed};
  var ROUNDS = ${KDF_ROUNDS};
  var STORE = "shareKey";
  var gate = document.getElementById("gate");
  var list = document.getElementById("list");
  var err = document.getElementById("err");

  function b64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function toB64(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))); }

  async function keyFromCode(code) {
    var base = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: b64(SEALED.salt), iterations: ROUNDS, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
  }

  async function unlockWith(key) {
    var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(SEALED.iv) }, key, b64(SEALED.ct));
    document.getElementById("main").innerHTML = new TextDecoder().decode(plain);
    wireCopy();
    gate.classList.add("hidden");
    list.classList.remove("hidden");
  }

  // Stay open for this tab: keep the derived key (not the code), tied to this build's salt.
  (async function () {
    try {
      var saved = sessionStorage.getItem(STORE);
      if (SEALED && saved && saved.indexOf(SEALED.salt + "|") === 0) {
        var raw = b64(saved.slice(SEALED.salt.length + 1));
        await unlockWith(await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]));
      }
    } catch (e) {}
  })();

  document.getElementById("codeForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!SEALED) return;
    var btn = e.target.querySelector("button");
    btn.disabled = true; err.textContent = "";
    try {
      var key = await keyFromCode(document.getElementById("code").value.trim());
      await unlockWith(key);
      try { sessionStorage.setItem(STORE, SEALED.salt + "|" + toB64(await crypto.subtle.exportKey("raw", key))); } catch (e2) {}
    } catch (e3) {
      err.textContent = "Wrong code.";
    }
    btn.disabled = false;
  });

  function wireCopy() {
    Array.prototype.forEach.call(document.querySelectorAll("button.copy"), function (btn) {
      btn.addEventListener("click", async function () {
        var url = btn.dataset.url;
        try { await navigator.clipboard.writeText(url); btn.textContent = "Copied"; }
        catch (e) { btn.textContent = "Copy failed"; }
        setTimeout(function () { btn.textContent = "Copy"; }, 1500);
      });
    });
  }
</script>
</body>
</html>
`;
}

const code = (process.env.SHARE_CODE || "").trim();
if (code && code.length < 16) console.log("WARNING: SHARE_CODE is short; use four random words (20+ characters).");
if (!fs.existsSync(SHARE_DIR)) fs.mkdirSync(SHARE_DIR, { recursive: true });
const pages = collect();
fs.writeFileSync(OUT, render(pages, code));
console.log("share/index.html built with " + pages.length + " page(s)" + (code ? "" : " -- WARNING: SHARE_CODE not set, list left out"));
