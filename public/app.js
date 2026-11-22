const $ = (id) => document.getElementById(id);
const MAX_BYTES = 2 * 1024 * 1024;
let pages = [];   // { mimeType, data }
let markdown = "";     // text used by "Copy Markdown"

// ---- Theme (remembers choice) ----
const saved = localStorage.getItem("theme");
const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
document.documentElement.dataset.theme = saved || (prefersDark ? "dark" : "light");
$("theme").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
};

// ---- File handling: PDF/images -> base64, Word/PowerPoint/text -> extracted text ----
let extractedText = "";
const OFFICE_MAX = 15 * 1024 * 1024;
const TEXT_CAP = 150000;
const ext = (n) => n.toLowerCase().split(".").pop();
const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function readDocx(buf) {
  const r = await mammoth.extractRawText({ arrayBuffer: buf });
  return r.value;
}
async function readPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const num = (p) => +p.match(/(\d+)\.xml$/)[1];
  const grab = (xml) => xml.split("</a:p>")
    .map((par) => [...par.matchAll(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g)].map((m) => unxml(m[1])).join(""))
    .filter((t) => t.trim()).join("\n");
  const slides = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a, b) => num(a) - num(b));
  const out = [];
  for (const p of slides) {
    let block = "## Slide " + num(p) + "\n" + grab(await zip.file(p).async("string"));
    const notes = zip.file("ppt/notesSlides/notesSlide" + num(p) + ".xml");
    if (notes) {
      const n = grab(await notes.async("string")).replace(/^\d+$/gm, "").trim();
      if (n) block += "\nSpeaker notes: " + n;
    }
    out.push(block);
  }
  return out.join("\n\n");
}
const toBase64 = (f) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result.split(",")[1]);
  r.onerror = rej;
  r.readAsDataURL(f);
});

// ---- Send to backend ----
$("go").onclick = async () => {
  const text = [$("text").value, extractedText].filter(Boolean).join("\n\n"), mode = $("mode").value;
  $("error").textContent = "";
  if (!text.trim() && !pages.length) { $("error").textContent = "Paste some notes or upload a file first."; return; }

  $("go").disabled = true; $("go").textContent = "Working...";
  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, files: pages, mode }),
    });
    const raw = await res.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}: ${raw.slice(0, 150)}`);
    show(mode, data); remember(mode, data, text);
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("go").disabled = false; $("go").textContent = "Summarize notes →";
  }
};

function show(mode, data) {
  $("result").hidden = false;
  const out = $("output");
  if (mode === "quiz") return renderQuiz(data.quiz.questions, out);
  if (mode === "flashcards") return renderCards(data.cards.cards, out);
  markdown = data.markdown;
  out.innerHTML = marked.parse(markdown);
  $("result").scrollIntoView({ behavior: "smooth" });
}

function renderQuiz(questions, out) {
  let answered = 0, correct = 0;
  const letters = "ABCD";
  markdown = questions.map((q, i) =>
    `### Q${i + 1}. ${q.question}\n` + q.options.map((o, j) => `- ${letters[j]}. ${o}`).join("\n") +
    `\n\n**Answer:** ${letters[q.correctIndex]}. ${q.options[q.correctIndex]}\n\n${q.explanation}\n`).join("\n");

  out.innerHTML = '<div class="score" id="score">Answer all 5 questions to see your score.</div>';
  questions.forEach((q, i) => {
    const box = document.createElement("div"); box.className = "q";
    const p = document.createElement("p"); p.textContent = `${i + 1}. ${q.question}`; box.append(p);
    const why = document.createElement("p"); why.className = "why"; why.hidden = true; why.textContent = q.explanation;
    const btns = q.options.map((opt, j) => {
      const b = document.createElement("button"); b.className = "opt"; b.type = "button";
      b.textContent = `${letters[j]}. ${opt}`;
      b.onclick = () => {
        btns.forEach((x, k) => { x.disabled = true; if (k === q.correctIndex) x.classList.add("right"); });
        if (j === q.correctIndex) correct++; else b.classList.add("wrong");
        why.hidden = false; answered++;
        $("score").textContent = answered === questions.length
          ? `Final score: ${correct} / ${questions.length}`
          : `Score so far: ${correct} / ${answered}`;
      };
      box.append(b); return b;
    });
    box.append(why); out.append(box);
  });
  $("result").scrollIntoView({ behavior: "smooth" });
}

// ---- Copy Markdown ----
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText(markdown); $("copy").textContent = "Copied"; }
  catch { $("copy").textContent = "Copy failed"; }
  setTimeout(() => ($("copy").textContent = "Copy Markdown"), 1500);
};

// ---- PWA: service worker + install button ----
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
let installEvent = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); installEvent = e; $("install").hidden = false;
});
$("install").onclick = async () => {
  if (!installEvent) return;
  installEvent.prompt(); await installEvent.userChoice;
  installEvent = null; $("install").hidden = true;
};
addEventListener("appinstalled", () => ($("install").hidden = true));

// ---- Helpers ----
const L = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const S = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt) n.textContent = txt; if (tag === "button") n.type = "button"; return n; };
const LABEL = { bullets: "Summary", cheatsheet: "Cheat sheet", quiz: "Quiz", flashcards: "Flashcards" };

// ---- Files: several at once, camera, photos shrunk before sending ----
const PDF_MAX = 2 * 1024 * 1024, B64_TOTAL = 3200000;
async function shrink(f) {
  const bmp = await createImageBitmap(f), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82).split(",")[1];
}
function updateInfo() {
  const n = pages.length, t = extractedText.length;
  $("fileinfo").textContent = n || t ? "Ready: " + (n ? n + " page/file(s)" : "") + (n && t ? " + " : "") + (t ? t.toLocaleString() + " characters of text" : "") : "";
  $("clearfiles").hidden = !(n || t);
}
async function addFiles(list, input) {
  $("error").textContent = "";
  try {
    for (const f of list) {
      const x = ext(f.name);
      if (x === "doc" || x === "ppt") throw new Error("Old .doc/.ppt files aren't supported. Save as .docx / .pptx first.");
      $("fileinfo").textContent = "Reading " + f.name + "...";
      if (["docx", "pptx", "txt", "md"].includes(x)) {
        if (f.size > OFFICE_MAX) throw new Error(f.name + " is over 15 MB.");
        const t = x === "txt" || x === "md" ? await f.text() : x === "docx" ? await readDocx(await f.arrayBuffer()) : await readPptx(await f.arrayBuffer());
        if (!t.trim()) throw new Error("No text found in " + f.name + ". Try exporting it as a PDF.");
        extractedText += (extractedText ? "\n\n" : "") + "### " + f.name + "\n" + t.trim();
      } else if (f.type.startsWith("image/")) {
        pages.push({ name: f.name, mimeType: "image/jpeg", data: await shrink(f) });
      } else {
        if (f.size > PDF_MAX) throw new Error(f.name + " is over 2 MB.");
        pages.push({ name: f.name, mimeType: f.type || "application/pdf", data: await toBase64(f) });
      }
      if (pages.reduce((n, p) => n + p.data.length, 0) > B64_TOTAL) { pages.pop(); throw new Error("Too much to send at once. Remove some pages."); }
    }
    extractedText = extractedText.slice(0, TEXT_CAP);
  } catch (err) { $("error").textContent = err.message || "Couldn't read that file."; }
  input.value = ""; updateInfo();
}
$("file").onchange = (e) => addFiles(e.target.files, e.target);
$("camfile").onchange = (e) => addFiles(e.target.files, e.target);
$("cam").onclick = () => $("camfile").click();
$("clearfiles").onclick = () => { pages = []; extractedText = ""; updateInfo(); };

// ---- Flashcards ----
function renderCards(cards, out) {
  markdown = cards.map((c, n) => `**${n + 1}. ${c.front}**\n\n${c.back}\n`).join("\n");
  let deck = cards.slice(), i = 0, missed = [], got = 0;
  const restart = (d) => { deck = d; missed = []; i = 0; got = 0; draw(); };
  const draw = () => {
    out.innerHTML = "";
    if (i >= deck.length) {
      out.append(el("div", "score", `Round done: ${got} got it, ${missed.length} to review`));
      const row = el("div", "fcact");
      if (missed.length) { const b = el("button", "primary", "Review missed cards"); const m = missed; b.onclick = () => restart(m); row.append(b); }
      const again = el("button", null, "Start over"); again.onclick = () => restart(cards.slice());
      row.append(again); out.append(row); return;
    }
    const c = deck[i], card = el("button", "fc", c.front), acts = el("div", "fcact");
    let back = false; acts.hidden = true;
    card.onclick = () => { back = !back; card.textContent = back ? c.back : c.front; card.classList.toggle("flip", back); acts.hidden = !back; };
    const no = el("button", null, "Review again"), yes = el("button", "primary", "Got it");
    no.onclick = () => { missed.push(c); i++; draw(); };
    yes.onclick = () => { got++; i++; draw(); };
    acts.append(no, yes);
    out.append(card, el("p", "hint", `Tap the card to flip. Card ${i + 1} of ${deck.length}`), acts);
  };
  draw(); $("result").scrollIntoView({ behavior: "smooth" });
}

// ---- History (saved on this device only) ----
function remember(mode, data, text) {
  const title = (text.trim().slice(0, 60) || pages.map((p) => p.name).join(", ") || "Untitled").replace(/\s+/g, " ");
  const h = L("nn_hist", []); h.unshift({ id: Date.now(), mode, title, data });
  S("nn_hist", h.slice(0, 25)); drawHistory();
}
function drawHistory() {
  const h = L("nn_hist", []), box = $("histlist");
  box.innerHTML = ""; $("history").hidden = !h.length;
  h.forEach((it) => {
    const row = el("div", "hrow"), open = el("button", "hopen", (LABEL[it.mode] || "Result") + ": " + it.title), del = el("button", null, "Delete");
    open.onclick = () => show(it.mode, it.data);
    del.onclick = () => { S("nn_hist", L("nn_hist", []).filter((x) => x.id !== it.id)); drawHistory(); };
    row.append(open, del); box.append(row);
  });
}
$("clearhist").onclick = () => { S("nn_hist", []); drawHistory(); };
drawHistory();

// ---- PDF export + first-launch guide ----
$("pdf").onclick = () => window.print();
$("help").onclick = () => { try { $("intro").showModal(); } catch {} };
$("introok").onclick = () => { S("nn_seen", true); $("intro").close(); };
if (!L("nn_seen", false)) { try { $("intro").showModal(); } catch {} }
