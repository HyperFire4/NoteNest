const $ = (id) => document.getElementById(id);
const MAX_BYTES = 3 * 1024 * 1024;
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

// ---- File -> base64 ----
$("file").onchange = (e) => {
  const f = e.target.files[0];
  fileData = null; $("fileinfo").textContent = ""; $("error").textContent = "";
  if (!f) return;
  if (f.size > MAX_BYTES) {
    e.target.value = "";
    $("error").textContent = "That file is over 3 MB. Try a smaller file or a lower-resolution photo.";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    fileData = { mimeType: f.type || "application/pdf", data: reader.result.split(",")[1] };
    $("fileinfo").textContent = "Ready: " + f.name;
  };
  reader.readAsDataURL(f);
};

// ---- Send to backend ----
$("go").onclick = async () => {
  const text = $("text").value, mode = $("mode").value;
  $("error").textContent = "";
  if (!text.trim() && !fileData) { $("error").textContent = "Paste some notes or upload a file first."; return; }

  $("go").disabled = true; $("go").textContent = "Working...";
  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, file: fileData, mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
    show(mode, data);
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("go").disabled = false; $("go").textContent = "Summarize notes";
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
