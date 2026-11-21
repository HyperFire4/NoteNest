import { GoogleGenAI, Type } from "@google/genai";

const MODEL = "gemini-3.8-flash"; // change here if Google AI Studio shows a different name

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

  const MODELS = [MODEL, "gemini-3.5-flash"];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ai = new GoogleGenAI({ apiKey });
  const config = mode === "quiz"
    ? { responseMimeType: "application/json", responseSchema: quizSchema }
    : {};
  let lastErr;

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config,
        });
        const out = response.text;
        if (mode === "quiz") return res.status(200).json({ quiz: JSON.parse(out) });
        return res.status(200).json({ markdown: out });
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message || err);
        const busy = /503|UNAVAILABLE|429|overloaded|high demand/i.test(msg);
        if (!busy) break;
        await wait(1500 * (attempt + 1));
      }
    }
  }

  console.error(lastErr);
  return res.status(500).json({
    error: "AI request failed: " + String(lastErr?.message || lastErr).slice(0, 300),
  });
}
