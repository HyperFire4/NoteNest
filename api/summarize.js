import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

const MODEL = "gemini-3.5-flash-lite"; // change here if Google AI Studio shows a different name

const PROMPTS = {
  bullets:
    "Summarize the notes as a concise bullet-point summary in Markdown. Group related points under short headings. Keep it brief and accurate.",
  cheatsheet:
    "Turn the notes into an exam cheat sheet in Markdown with two sections: '## Definitions' (term: meaning) and '## Formulas' (formula plus one line on when to use it). If there are no formulas, say so. Only use what is in the notes.",
  quiz:
    "Create exactly 5 multiple-choice questions that test understanding of the notes. Each question has exactly 4 options, one correct answer, and a one-sentence explanation.",
};

const quizSchema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          question: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          correctIndex: { type: Type.INTEGER },
          explanation: { type: Type.STRING },
        },
        required: ["question", "options", "correctIndex", "explanation"],
      },
    },
  },
  required: ["questions"],
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });

  const { text, file, mode } = req.body || {};
  if (!PROMPTS[mode]) return res.status(400).json({ error: "Unknown mode." });
  if (!text?.trim() && !file?.data) return res.status(400).json({ error: "Add some text or a file first." });

  const parts = [{ text: PROMPTS[mode] }];
  if (text?.trim()) parts.push({ text: "NOTES:\n" + text });
  if (file?.data) parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });

  const started = Date.now();
  const BUDGET_MS = 50000; // stop before Vercel's 60s limit
  const MODELS = [MODEL, "gemini-3.5-flash", "gemini-3.5-flash"];
  const ai = new GoogleGenAI({ apiKey });
  // "low" thinking = noticeably faster answers
  const config = {
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    ...(mode === "quiz"
      ? { responseMimeType: "application/json", responseSchema: quizSchema }
      : {}),
  };
  let lastErr;

  for (const model of MODELS) {
    const remaining = BUDGET_MS - (Date.now() - started);
    if (remaining < 8000) break;
    const limit = Math.min(28000, remaining);
    let timer;
    try {
      const call = ai.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config,
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("TIMEOUT: " + model + " took too long")), limit);
      });
      const response = await Promise.race([call, timeout]);
      clearTimeout(timer);
      const out = response.text;
      if (mode === "quiz") return res.status(200).json({ quiz: JSON.parse(out) });
      return res.status(200).json({ markdown: out });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      console.error(model, String(err?.message || err));
    }
  }

  return res.status(500).json({
    error: "AI request failed: " + String(lastErr?.message || lastErr || "out of time").slice(0, 300) +
      " (Google may be busy or the file is too big. Wait a minute, or try a shorter PDF.)",
  });
}
