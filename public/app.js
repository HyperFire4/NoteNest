const $ = (id) => document.getElementById(id);
const MAX_BYTES = 2 * 1024 * 1024;
let fileData = null;   // { mimeType, data }
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

$("file").onchange = async (e) => {
  const f = e.target.files[0];
  fileData = null; extractedText = ""; $("fileinfo").textContent = ""; $("error").textContent = "";
  if (!f) return;
  const x = ext(f.name);
  const office = x === "docx" || x === "pptx";
  const plain = x === "txt" || x === "md";
  const reset = (msg) => { e.target.value = ""; $("error").textContent = msg; };

  if (x === "doc" || x === "ppt") return reset("Old .doc/.ppt files aren't supported. Open it and use Save As .docx / .pptx first.");
  if (f.size > (office || plain ? OFFICE_MAX : MAX_BYTES)) {
    return reset(office || plain ? "That file is over 15 MB." : "That file is over 2 MB. Try a smaller file or a lower-resolution photo.");
  }
  try {
    $("fileinfo").textContent = "Reading " + f.name + "...";
    if (office) {
      const buf = await f.arrayBuffer();
      extractedText = (x === "docx" ? await readDocx(buf) : await readPptx(buf)).trim();
      if (!extractedText) throw new Error("No text found");
    } else if (plain) {
      extractedText = (await f.text()).trim();
    } else {
      fileData = { mimeType: f.type || "application/pdf", data: await toBase64(f) };
    }
    extractedText = extractedText.slice(0, TEXT_CAP);
    $("fileinfo").textContent = "Ready: " + f.name + (extractedText ? " (" + extractedText.length.toLocaleString() + " characters read)" : "");
  } catch (err) {
    reset("Couldn't read that file. If it's empty or only has pictures, try exporting it as a PDF.");
    $("fileinfo").textContent = "";
  }
};

// ---- Send to backend ----
$("go").onclick = async () => {
  const text = [$("text").value, extractedText].filter(Boolean).join("\n\n"), mode = $("mode").value;
  $("error").textContent = "";
  if (!text.trim() && !fileData) { $("error").textContent = "Paste some notes or upload a file first."; return; }

  $("go").disabled = true; $("go").textContent = "Working...";
  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, file: fileData, mode }),
    });
    const raw = await res.text();
    let data = {};
    try { data = JSON.parse(raw); } catch {}
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}: ${raw.slice(0, 150)}`);
    show(mode, data);
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
