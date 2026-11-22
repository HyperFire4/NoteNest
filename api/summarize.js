import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

const MODEL = "gemini-3.5-flash-lite"; // change here if you want a different model
const FALLBACKS = [MODEL, "gemini-3.5-flash", "gemini-3.5-flash"];

const PROMPTS = {
  bullets: "Summarize the notes as a concise bullet-point summary in Markdown. Group related points under short headings. Keep it brief and accurate.",
  cheatsheet: "Turn the notes into an exam cheat sheet in Markdown with two sections: '## Definitions' (term: meaning) and '## Formulas' (formula plus one line on when to use it). If there are no formulas, say so. Only use what is in the notes.",
  quiz: "Create exactly 5 multiple-choice questions that test understanding of the notes. Each question has exactly 4 options, one correct answer, and a one-sentence explanation.",
  flashcards: "Create 12 to 15 study flashcards from the notes. 'front' is a short question or term. 'back' is a concise answer (max 2 sentences). Cover the most important ideas only.",
};

const quizSchema = {
  type: Type.OBJECT,
  properties: { questions: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    question: { type: Type.STRING }, options: { type: Type.ARRAY, items: { type: Type.STRING } },
    correctIndex: { type: Type.INTEGER }, explanation: { type: Type.STRING } },
    required: ["question", "options", "correctIndex", "explanation"] } } },
  required: ["questions"],
};
const cardsSchema = {
  type: Type.OBJECT,
  properties: { cards: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
    front: { type: Type.STRING }, back: { type: Type.STRING } }, required: ["front", "back"] } } },
  required: ["cards"],
};
const SCHEMAS = { quiz: quizSchema, flashcards: cardsSchema };

// Simple per-visitor limit (best effort: resets when the server restarts)
const hits = new Map();
const LIMIT = 20, WINDOW_MS = 60 * 60 * 1000;
function limited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) { hits.set(ip, recent); return true; }
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "You've reached the limit of 20 requests per hour. Please try again later." });

  const { text, files, mode } = req.body || {};
  if (!PROMPTS[mode]) return res.status(400).json({ error: "Unknown mode." });
  const list = Array.isArray(files) ? files.slice(0, 12) : [];
  if (!String(text || "").trim() && !list.length) return res.status(400).json({ error: "Add some text or a file first." });
  if (String(text || "").length > 200000) return res.status(400).json({ error: "That's too much text. Try a shorter section." });
  for (const f of list) {
    if (!f?.data || !/^(application\/pdf|image\/)/.test(f.mimeType || "")) return res.status(400).json({ error: "Unsupported file type." });
  }

  const parts = [{ text: PROMPTS[mode] }];
  if (String(text || "").trim()) parts.push({ text: "NOTES:\n" + text });
  for (const f of list) parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });

  const started = Date.now(), BUDGET_MS = 50000;
  const ai = new GoogleGenAI({ apiKey });
  const config = {
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    ...(SCHEMAS[mode] ? { responseMimeType: "application/json", responseSchema: SCHEMAS[mode] } : {}),
  };
  let lastErr;

  for (const model of FALLBACKS) {
    const remaining = BUDGET_MS - (Date.now() - started);
    if (remaining < 8000) break;
    let timer;
    try {
      const call = ai.models.generateContent({ model, contents: [{ role: "user", parts }], config });
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("TIMEOUT: " + model + " took too long")), Math.min(28000, remaining)); });
      const response = await Promise.race([call, timeout]);
      clearTimeout(timer);
      const out = response.text;
      if (mode === "quiz") return res.status(200).json({ quiz: JSON.parse(out) });
      if (mode === "flashcards") return res.status(200).json({ cards: JSON.parse(out) });
      return res.status(200).json({ markdown: out });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      console.error(model, String(err?.message || err));
    }
  }
  return res.status(500).json({
    error: "AI request failed: " + String(lastErr?.message || lastErr || "out of time").slice(0, 300) + " (Google may be busy or the file is too big. Wait a minute and try again.)",
  });
}
