import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

// SDK mới của Google (thay cho @google/generative-ai đã ngừng hỗ trợ)
import { GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable("x-powered-by");

const port = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === "production";

// ================================
// CẤU HÌNH GEMINI
// ================================
// Model đọc từ .env để đổi được mà không cần sửa code: GEMINI_MODEL=...
// gemini-2.5-flash có thể trả 404 với khóa mới (AQ.) nên mặc định dùng 3.5 Flash.
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-3.5-flash").trim();
const AI_TIMEOUT_MS = 60_000;

// Model dự phòng: khi model chính quá tải (503) hoặc không khả dụng, server tự thử model tiếp theo.
// Có thể đổi trong .env: GEMINI_FALLBACK_MODELS=gemini-3.1-flash-lite,tên-model-khác
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.1-flash-lite")
  .split(",").map((s) => s.trim()).filter((m) => m && m !== GEMINI_MODEL);

const geminiApiKey = (process.env.GEMINI_API_KEY || "").trim();
if (!geminiApiKey) {
  console.error("CẢNH BÁO: Chưa cấu hình GEMINI_API_KEY trong file .env!");
}
const ai = geminiApiKey
  ? new GoogleGenAI({ apiKey: geminiApiKey, httpOptions: { timeout: AI_TIMEOUT_MS } })
  : null;

// ================================
// TIỆN ÍCH
// ================================
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireAi() {
  if (!ai) {
    throw new HttpError(503, "Server chưa cấu hình GEMINI_API_KEY.", "NO_API_KEY");
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isOverloaded = (error) => [500, 502, 503, 504].includes(Number(error?.status));
const shouldTryNextModel = (error) =>
  isOverloaded(error) || [404, 429].includes(Number(error?.status));

// Gọi Gemini: thử lại 1 lần nếu model quá tải, rồi chuyển sang model dự phòng.
// Lỗi do người dùng/khóa (400, 401, 403) thì dừng ngay, không thử tiếp.
async function generateWithFallback(request) {
  requireAi();
  const models = [GEMINI_MODEL, ...FALLBACK_MODELS];
  const attemptsPerModel = 2;
  let firstError;

  for (const model of models) {
    for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
      try {
        return await ai.models.generateContent({ ...request, model });
      } catch (error) {
        firstError ??= error;
        console.warn(
          `[gemini] ${model} lần ${attempt} lỗi: status=${error?.status ?? "n/a"} ${String(error?.message || error).slice(0, 140)}`
        );
        if (isOverloaded(error) && attempt < attemptsPerModel) {
          await sleep(1000 * attempt);
          continue; // thử lại cùng model
        }
        if (shouldTryNextModel(error)) break; // sang model dự phòng
        throw error; // lỗi khác: dừng luôn
      }
    }
  }
  throw firstError;
}

// Trả lỗi có mã (code) rõ ràng để giao diện hiển thị đúng thông báo.
// Chi tiết gốc của Google luôn được in ra terminal để bạn debug.
function sendAiError(res, error, label) {
  const upstream = Number(error?.status) || 0; // ApiError.status = mã HTTP từ Google
  const rawMessage = String(error?.message || error);
  console.error(`[${label}] status=${upstream || "n/a"} :: ${rawMessage}`);

  const detail = isProd ? undefined : rawMessage.slice(0, 500);
  const send = (status, code, message) =>
    res.status(status).json({ error: message, code, detail });

  if (error instanceof HttpError) return send(error.status, error.code, error.message);
  if (upstream === 429) {
    return send(429, "AI_QUOTA", "AI đang quá tải hoặc đã hết lượt miễn phí. Hãy thử lại sau ít phút.");
  }
  if (upstream === 503 || upstream === 500 || upstream === 504) {
    return send(503, "AI_OVERLOADED", "AI đang quá tải, vui lòng thử lại sau ít phút.");
  }
  if (upstream === 404) {
    return send(502, "AI_MODEL_NOT_FOUND", `Model AI "${GEMINI_MODEL}" không khả dụng. Hãy đổi GEMINI_MODEL trong .env.`);
  }
  if (upstream === 401 || upstream === 403 || /api key/i.test(rawMessage)) {
    return send(502, "AI_AUTH", "Khóa API Gemini không hợp lệ hoặc không có quyền. Hãy tạo khóa mới và cập nhật .env.");
  }
  if (upstream === 400) {
    return send(502, "AI_BAD_REQUEST", "AI không xử lý được yêu cầu này (ảnh/âm thanh có thể lỗi hoặc không đọc được).");
  }
  if (error?.name === "AbortError" || /timeout|timed out|ETIMEDOUT/i.test(rawMessage)) {
    return send(504, "AI_TIMEOUT", "AI phản hồi quá lâu. Hãy thử lại với ảnh nhỏ hơn.");
  }
  return send(502, "AI_ERROR", "Lỗi khi gọi AI. Vui lòng thử lại.");
}

// Giới hạn số request/phút cho mỗi IP để không ai "đốt" hạn mức Gemini của bạn.
// Nếu deploy sau proxy (Render, Nginx...) hãy bật: app.set("trust proxy", 1)
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || "unknown";
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({
        error: "Bạn thao tác quá nhanh, hãy đợi một chút rồi thử lại.",
        code: "RATE_LIMITED",
      });
    }
    next();
  };
}
const aiLimiter = rateLimit({ windowMs: 60_000, max: 20 });

// Gọi Gemini và bắt buộc trả JSON theo schema
async function generateJson({ parts, schema, systemInstruction, maxOutputTokens = 8192 }) {
  const response = await generateWithFallback({
    contents: [{ role: "user", parts }],
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: schema,
      maxOutputTokens,
    },
  });

  const text = response.text; // Trong SDK mới, text là thuộc tính (không phải hàm)
  if (!text) {
    throw new HttpError(502, "AI không trả về nội dung (có thể bị bộ lọc an toàn chặn).", "EMPTY_AI_RESPONSE");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, "AI trả về dữ liệu không hợp lệ (có thể bị cắt ngắn). Hãy thử lại.", "BAD_AI_JSON");
  }
}

// ================================
// MULTER - UPLOAD (giới hạn an toàn)
// ================================
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // Tối đa 10MB
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (allowed.has(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, "Chỉ hỗ trợ ảnh JPG, PNG, WEBP.", "BAD_FILE_TYPE"));
  },
});

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // Tối đa 12MB
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      "audio/webm", "audio/ogg", "audio/wav", "audio/x-wav",
      "audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac", "audio/m4a",
    ]);
    const mime = String(file.mimetype || "").split(";")[0].trim();
    if (allowed.has(mime)) cb(null, true);
    else cb(new HttpError(400, "Định dạng ghi âm không được hỗ trợ.", "BAD_AUDIO_TYPE"));
  },
});

// ================================
// MIDDLEWARE
// ================================
app.use(express.json({ limit: "5mb" }));

// CORS: giao diện chạy cùng cổng với server nên KHÔNG cần mở "*".
// - Khi phát triển: cho phép localhost/127.0.0.1 (ví dụ Live Server cổng 5500).
// - Khi deploy: khai báo ALLOWED_ORIGINS=https://ten-mien-cua-ban.com trong .env
const extraOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const isLocalOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (extraOrigins.includes(origin) || (!isProd && isLocalOrigin(origin)))) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// STATIC: chỉ phục vụ file giao diện, KHÔNG để lộ server.mjs, package.json,
// file .sql, README, node_modules, file ẩn (.env, .git...).
// (Cách gọn hơn về lâu dài: đưa index.html và asset vào thư mục "public".)
const PUBLIC_EXT = new Set([
  ".html", ".css", ".js", ".json", ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".svg", ".ico", ".woff", ".woff2", ".mp3", ".webmanifest", ".txt",
]);
const PRIVATE_FILES = new Set(["package.json", "package-lock.json", "index-backup.html"]);

function isPublicPath(rawPath) {
  let p;
  try {
    p = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  p = p.replaceAll("\\", "/").toLowerCase();
  if (p.includes("..")) return false;
  if (p === "/") return true;
  const segments = p.split("/").filter(Boolean);
  if (segments.some((seg) => seg.startsWith(".") || seg === "node_modules")) return false;
  const file = segments[segments.length - 1] || "";
  if (PRIVATE_FILES.has(file)) return false;
  return PUBLIC_EXT.has(path.extname(file));
}

app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || isPublicPath(req.path)) return next();
  return res.sendStatus(404);
});
app.use(express.static(__dirname, { dotfiles: "ignore" }));

// ================================
// SUPABASE CONFIG API
// ================================
app.get("/api/config", (_req, res) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: "Thiếu cấu hình Supabase." });
  }
  res.json({ supabaseUrl, supabaseAnonKey });
});

// ================================
// KIỂM TRA SỨC KHỎE / CHẨN ĐOÁN
// ================================
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: GEMINI_MODEL,
    hasGeminiKey: Boolean(geminiApiKey),
    hasSupabaseConfig: Boolean(
      process.env.SUPABASE_URL &&
      (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY)
    ),
  });
});

// Gọi thử Gemini thật để biết khóa + model có chạy không.
// Mở http://localhost:3000/api/health/ai trên trình duyệt. Chỉ bật khi không phải production.
if (!isProd) {
  app.get("/api/health/ai", aiLimiter, async (_req, res) => {
    try {
      const response = await generateWithFallback({
        contents: "Reply with the single word: OK",
      });
      res.json({ ok: true, model: response.modelVersion || GEMINI_MODEL, reply: response.text });
    } catch (error) {
      sendAiError(res, error, "health/ai");
    }
  });
}

// ================================
// 1. AI TUTOR (TEXT)
// ================================
app.post("/api/ai-tutor", aiLimiter, async (req, res) => {
  try {
    const { message, profile } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Thiếu câu hỏi cho AI Tutor.", code: "MISSING_MESSAGE" });
    }
    requireAi();

    const safeProfile = {
      xp: Number(profile?.xp || 0),
      streak: Number(profile?.streak || 0),
      weak_words: String(profile?.weak_words || "").slice(0, 500),
    };

    const response = await generateWithFallback({
      contents: message.slice(0, 1000),
      config: {
        systemInstruction: `Bạn là AI Tutor tiếng Anh LingoPulse. Trả lời tiếng Việt, ngắn gọn. Hồ sơ học viên: ${JSON.stringify(safeProfile)}`,
        maxOutputTokens: 4096,
      },
    });

    const reply = response.text;
    if (!reply) throw new HttpError(502, "AI không trả về nội dung.", "EMPTY_AI_RESPONSE");
    res.json({ reply });
  } catch (error) {
    sendAiError(res, error, "ai-tutor");
  }
});

// ================================
// 2. AI IMAGE VOCABULARY (VISION)
// ================================
const vocabularySchema = {
  type: Type.OBJECT,
  properties: {
    detected_topic: { type: Type.STRING },
    detected_level: { type: Type.STRING },
    source_summary: { type: Type.STRING },
    vocabulary: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          synonyms: { type: Type.ARRAY, items: { type: Type.STRING } },
          meaning_vi: { type: Type.STRING },
          part_of_speech: { type: Type.STRING },
          pronunciation: { type: Type.STRING },
          cefr: { type: Type.STRING },
          example: { type: Type.STRING },
          example_vi: { type: Type.STRING },
          importance: { type: Type.INTEGER },
        },
        required: ["word", "meaning_vi", "part_of_speech", "pronunciation", "cefr", "example", "example_vi", "importance"],
      },
    },
  },
  required: ["detected_topic", "detected_level", "source_summary", "vocabulary"],
};

const VISION_PROMPT = `You are LingoPulse's OCR engine for Vietnamese learners of English.
Extract EVERY English vocabulary word or phrase that is actually visible in the image (including phrasal verbs and collocations such as "cope with").
Do not invent words that are not in the image. Fix obvious OCR/handwriting errors.
For each item give: Vietnamese meaning, part of speech, IPA pronunciation, CEFR level, one natural English example sentence with its Vietnamese translation, and an importance score from 1 to 5.
Also give 1 to 3 common English synonyms (or near-synonyms) for the word/phrase when they exist, as a "synonyms" array; use an empty array if there is no good synonym (do not repeat the word itself, do not invent rare/unnatural synonyms).
If the image contains no English vocabulary, return an empty vocabulary array and explain briefly in source_summary (in Vietnamese).`;

app.post("/api/analyze-vocabulary-image", aiLimiter, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Chưa có ảnh.", code: "MISSING_IMAGE" });

    const result = await generateJson({
      parts: [
        { text: VISION_PROMPT },
        { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } },
      ],
      schema: vocabularySchema,
      maxOutputTokens: 16384,
    });

    if (!Array.isArray(result.vocabulary)) result.vocabulary = [];
    result.vocabulary.forEach((item) => {
      if (!Array.isArray(item.synonyms)) item.synonyms = [];
    });
    return res.json(result);
  } catch (error) {
    return sendAiError(res, error, "ai-vision");
  }
});

// ================================
// 3. AI PRONUNCIATION ASSESSMENT (AUDIO)
// ================================
const pronunciationSchema = {
  type: Type.OBJECT,
  properties: {
    heard_text: { type: Type.STRING },
    overall_score: { type: Type.INTEGER },
    pronunciation_score: { type: Type.INTEGER },
    stress_score: { type: Type.INTEGER },
    clarity_score: { type: Type.INTEGER },
    difficult_sounds: { type: Type.ARRAY, items: { type: Type.STRING } },
    stress_feedback: { type: Type.STRING },
    comparison: { type: Type.STRING },
    short_feedback: { type: Type.STRING },
  },
  required: [
    "heard_text", "overall_score", "pronunciation_score", "stress_score",
    "clarity_score", "stress_feedback", "comparison", "short_feedback",
  ],
};

app.post("/api/analyze-pronunciation", aiLimiter, audioUpload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Chưa có file ghi âm.", code: "MISSING_AUDIO" });

    const target = String(req.body?.target || "").trim().slice(0, 200);
    if (!target) return res.status(400).json({ error: "Thiếu từ cần đọc.", code: "MISSING_TARGET" });

    const prompt = `Listen to this audio file. The learner is a Vietnamese speaker trying to pronounce the English phrase: "${target}".
First transcribe exactly what you heard into heard_text (if it is unintelligible, use an empty string).
Then evaluate pronunciation, stress, and clarity out of 100. Give constructive feedback in Vietnamese.`;

    const mimeType = String(req.file.mimetype || "").split(";")[0].trim();
    const result = await generateJson({
      parts: [
        { text: prompt },
        { inlineData: { data: req.file.buffer.toString("base64"), mimeType } },
      ],
      schema: pronunciationSchema,
      maxOutputTokens: 4096,
    });

    return res.json(result);
  } catch (error) {
    return sendAiError(res, error, "pronunciation");
  }
});

// ================================
// XỬ LÝ LỖI TOÀN CỤC
// ================================
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API endpoint không tồn tại.", code: "NOT_FOUND" })
);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const tooBig = error.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig
        ? "File quá lớn (ảnh tối đa 10MB, ghi âm tối đa 12MB)."
        : `Lỗi tải file lên: ${error.message}`,
      code: error.code,
    });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "Dữ liệu gửi lên quá lớn.", code: "PAYLOAD_TOO_LARGE" });
  }
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ error: "Dữ liệu JSON không hợp lệ.", code: "BAD_JSON" });
  }

  console.error("Global Server error:", error);
  const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500;
  res.status(status).json({
    error: status === 500 ? "Lỗi hệ thống máy chủ." : error.message,
    code: error?.code || "SERVER_ERROR",
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

const server = app.listen(port, () => {
  console.log(`✅ LingoPulse Server is running on http://localhost:${port}`);
  console.log(`   AI model: ${GEMINI_MODEL} | Gemini key: ${geminiApiKey ? "đã có" : "THIẾU"}`);
  if (FALLBACK_MODELS.length) console.log(`   Model dự phòng: ${FALLBACK_MODELS.join(", ")}`);
  if (!isProd) console.log(`   Kiểm tra AI: http://localhost:${port}/api/health/ai`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`❌ Cổng ${port} đang được dùng. Hãy tắt server cũ hoặc đổi PORT trong .env.`);
  } else {
    console.error("Server error:", error);
  }
  process.exit(1);
});
