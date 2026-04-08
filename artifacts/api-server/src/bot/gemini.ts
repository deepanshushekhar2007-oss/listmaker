import { GoogleGenAI } from "@google/genai";
import { logger } from "../lib/logger.js";

export interface GroupEntry {
  name: string;
  count: number;
}

const PROMPT = `You are analyzing a WhatsApp screenshot. Your job is to extract the group name and a count number.

The screenshot may show ONE of two views:

━━━━━━━━━━━━━━━━━━━━━━━━
VIEW 1: GROUP CHAT / MESSAGE VIEW (usually has a light/white background)
━━━━━━━━━━━━━━━━━━━━━━━━
This view shows the WhatsApp chat or group info page.
- The GROUP NAME is shown as the LARGE BOLD TEXT at the very top (in the header/title bar). It may be a long name like "Expedia 酒店回饋活動PK 78", "Escuela Dominical", "SPIDY200", etc.
- If you see a system message like: "You changed the group name from X to Y" — use Y (the NEW name after "to")
- The COUNT may come from: "Pending Requests" badge number (green badge), or "X members", or "Review X requests to join"

━━━━━━━━━━━━━━━━━━━━━━━━
VIEW 2: GROUP INFO / SETTINGS PAGE (usually has a dark/black background with profile at top)
━━━━━━━━━━━━━━━━━━━━━━━━
This view is the WhatsApp group info/settings page.
- The GROUP NAME is shown as the LARGE BOLD TEXT below the group profile picture at the top (e.g. "Expedia 酒店回饋活動PK 78", "AA70", "FH101", "SPIDY200")
- Do NOT use the small subtext like "Group · 5 members" as the name
- The COUNT may come from: "Pending Requests" badge (green number), or "X members"

━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULE — PENDING REQUESTS vs MEMBERS COUNT:
━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ THIS IS THE MOST IMPORTANT RULE — READ CAREFULLY:

If BOTH "Pending Requests" badge AND "X members" are visible in the screenshot:
→ You MUST use the "Pending Requests" badge number as the count
→ IGNORE the "X members" number completely
→ Do NOT confuse members count with pending requests count
→ Example: if screen shows "7 members" AND "Pending Requests: 32" badge → count = 32, NOT 7

PRIORITY ORDER FOR COUNT:
1. FIRST (HIGHEST PRIORITY): "Pending Requests" badge number (green badge like 31, 24, 15, 30, 32)
   → This is ALWAYS the correct count when visible — even if "X members" shows a different number
2. SECOND: "Review X requests to join" number at top of screen
3. LAST RESORT: "X members" number (ONLY use this if there is absolutely NO pending requests badge visible anywhere)

━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ READ NUMBERS FULLY AND CAREFULLY:
━━━━━━━━━━━━━━━━━━━━━━━━
- Badge numbers are almost always 2-digit numbers (e.g. 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 36, 45, 47)
- NEVER return just "2" if the badge clearly shows "28" — always read ALL digits of the number
- If you see a badge with two digits like "28", return 28, NOT 2
- Double-check: a single-digit count (1-9) is extremely rare for pending members — if you see what looks like a single digit, look again more carefully at the full badge

━━━━━━━━━━━━━━━━━━━━━━━━
GROUP NAME RULES:
━━━━━━━━━━━━━━━━━━━━━━━━
- Extract the FULL name exactly as shown — including Chinese/Japanese/Korean characters, numbers, spaces, AND emojis
- Examples of valid names: "Expedia 酒店回饋活動PK 78", "AA70", "FH101", "SPIDY200", "NOKUS 🔥", "chemistry ⚡", "Escuela Dominical 🌟"
- The name may contain letters, numbers, spaces, non-Latin characters, AND emoji characters
- IMPORTANT: If the group name contains emojis (e.g. 🔥, ⚡, 🌟, 💎, 🏆), include them in the name exactly as they appear
- Do NOT truncate the name — use the complete visible text including any emojis
- If name ends with "..." it means it was cut off — extract as much as visible including any emojis

RESPOND ONLY with a valid JSON array (no markdown, no explanation):
[{"name":"Expedia 酒店回饋活動PK 78","count":36}]

Rules:
- No markdown, no code blocks, no explanation — ONLY the JSON array
- If no group name or count found, respond with: []
- One screenshot = one group entry`;

function extractJsonArray(raw: string): GroupEntry[] {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  const startIdx = text.indexOf("[");
  const endIdx = text.lastIndexOf("]");
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    logger.warn({ raw }, "No JSON array brackets found");
    return [];
  }

  const jsonStr = text.slice(startIdx, endIdx + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    logger.warn({ jsonStr }, "JSON parse failed");
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const results: GroupEntry[] = [];
  for (const item of parsed) {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      const name = typeof obj["name"] === "string" ? obj["name"].trim() : null;
      const count = typeof obj["count"] === "number" ? obj["count"] : null;
      if (name && count !== null && count >= 0) {
        results.push({ name, count });
      }
    }
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getGroqKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`GROQ_API_KEY_${i}`] ?? process.env[`GROQ_KEY_${i}`];
    if (key) keys.push(key);
  }
  const single = process.env["GROQ_API_KEY"];
  if (single && !keys.includes(single)) keys.push(single);
  return keys;
}

function getGeminiKeys(): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`] ?? process.env[`GOOGLE_API_KEY_${i}`];
    if (key) keys.push(key);
  }
  const single = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_API_KEY"];
  if (single && !keys.includes(single)) keys.push(single);
  return keys;
}

let groqKeyIndex = 0;
let geminiKeyIndex = 0;

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const status = e["status"] ?? e["statusCode"] ?? e["code"];
  if (status === 429 || status === "RESOURCE_EXHAUSTED") return true;
  const msg = String(e["message"] ?? "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("resource_exhausted") || msg.includes("quota") || msg.includes("429");
}

async function callGroqWithKey(key: string, imageBase64: string, mimeType: string): Promise<GroupEntry[]> {
  const body = {
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
    max_tokens: 512,
    temperature: 0.1,
  };

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    const err: Record<string, unknown> = { status: resp.status, message: errText };
    throw err;
  }

  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  const results = extractJsonArray(content);
  logger.info({ count: results.length }, "Groq response parsed");
  return results;
}

async function callGroq(imageBase64: string, mimeType: string): Promise<GroupEntry[]> {
  const keys = getGroqKeys();
  if (keys.length === 0) throw new Error("No Groq API keys available");

  let attempts = 0;
  const maxAttempts = keys.length * 2;

  while (attempts < maxAttempts) {
    const key = keys[groqKeyIndex % keys.length]!;
    const keyNum = (groqKeyIndex % keys.length) + 1;

    try {
      logger.info({ keyNum, totalKeys: keys.length }, "Calling Groq");
      const result = await callGroqWithKey(key, imageBase64, mimeType);
      return result;
    } catch (err) {
      attempts++;
      if (isRateLimitError(err)) {
        logger.warn({ keyNum, attempts }, "Groq rate limit hit, rotating key");
        groqKeyIndex++;
        if (groqKeyIndex % keys.length === 0 && attempts < maxAttempts) {
          const waitMs = 2000 * Math.ceil(attempts / keys.length);
          logger.info({ waitMs }, "All Groq keys rate-limited, waiting before retry");
          await sleep(waitMs);
        }
      } else {
        logger.error({ err, keyNum }, "Groq non-rate-limit error");
        throw err;
      }
    }
  }

  throw new Error("All Groq API keys are rate-limited");
}

async function callGeminiWithKey(key: string, imageBase64: string, mimeType: string): Promise<GroupEntry[]> {
  const ai = new GoogleGenAI({ apiKey: key });

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: imageBase64, mimeType } },
          { text: PROMPT },
        ],
      },
    ],
    config: { maxOutputTokens: 512, temperature: 0.1 },
  });

  const rawText = response.text?.trim() ?? "";
  logger.info({ geminiResponse: rawText.slice(0, 100) }, "Gemini raw response");

  return extractJsonArray(rawText);
}

async function callGeminiReplit(imageBase64: string, mimeType: string): Promise<GroupEntry[]> {
  const replitBaseUrl = process.env["REPLIT_AI_BASE_URL"];
  const replitApiKey = process.env["REPLIT_AI_API_KEY"];

  if (!replitBaseUrl || !replitApiKey) throw new Error("No Replit AI integration configured");

  const ai = new GoogleGenAI({
    apiKey: replitApiKey,
    httpOptions: { apiVersion: "", baseUrl: replitBaseUrl },
  });

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: imageBase64, mimeType } },
          { text: PROMPT },
        ],
      },
    ],
    config: { maxOutputTokens: 512, temperature: 0.1 },
  });

  const rawText = response.text?.trim() ?? "";
  return extractJsonArray(rawText);
}

async function callGemini(imageBase64: string, mimeType: string): Promise<GroupEntry[]> {
  try {
    return await callGeminiReplit(imageBase64, mimeType);
  } catch (replitErr) {
    logger.info({ replitErr }, "Replit Gemini not available, trying direct keys");
  }

  const keys = getGeminiKeys();
  if (keys.length === 0) throw new Error("No Gemini API keys available");

  let attempts = 0;
  const maxAttempts = keys.length * 2;

  while (attempts < maxAttempts) {
    const key = keys[geminiKeyIndex % keys.length]!;
    const keyNum = (geminiKeyIndex % keys.length) + 1;

    try {
      logger.info({ keyNum, totalKeys: keys.length }, "Calling Gemini");
      const result = await callGeminiWithKey(key, imageBase64, mimeType);
      return result;
    } catch (err) {
      attempts++;
      if (isRateLimitError(err)) {
        logger.warn({ keyNum, attempts }, "Gemini rate limit hit, rotating key");
        geminiKeyIndex++;
        if (geminiKeyIndex % keys.length === 0 && attempts < maxAttempts) {
          const waitMs = 3000 * Math.ceil(attempts / keys.length);
          logger.info({ waitMs }, "All Gemini keys rate-limited, waiting before retry");
          await sleep(waitMs);
        }
      } else {
        logger.error({ err, keyNum }, "Gemini non-rate-limit error");
        throw err;
      }
    }
  }

  throw new Error("All Gemini API keys are rate-limited");
}

export async function extractGroupDataFromImage(
  imageBase64: string,
  mimeType: string
): Promise<GroupEntry[]> {
  try {
    const groqKeys = getGroqKeys();
    if (groqKeys.length > 0) {
      return await callGroq(imageBase64, mimeType);
    }
    return await callGemini(imageBase64, mimeType);
  } catch (err) {
    logger.error({ err }, "AI API error — all keys failed");
    return [];
  }
}
