const https = require("https");

function postJSON({ hostname, path, headers, body, timeoutMs = 25000 }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("REQUEST_TIMEOUT")), timeoutMs);
    const req = https.request(
      {
        hostname,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          clearTimeout(timer);
          try {
            resolve({ statusCode: res.statusCode || 500, json: JSON.parse(data || "{}"), raw: data });
          } catch (e) {
            reject(new Error("PARSE_ERROR: " + data.substring(0, 300)));
          }
        });
      }
    );
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function callGemini(apiKey, messages, systemPrompt, model = "gemini-2.5-flash") {
  const contents = messages.map((m) => ({
    role: "user",
    parts: Array.isArray(m.content)
      ? m.content.map((c) =>
          c.type === "image_url"
            ? {
                inline_data: {
                  mime_type: c.image_url.url.split(";")[0].split(":")[1],
                  data: c.image_url.url.split(",")[1],
                },
              }
            : { text: c.text || String(c) }
        )
      : [{ text: m.content }],
  }));

  const body = {
    contents,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { maxOutputTokens: 8192, temperature: 0.05 },
  };

  return postJSON({
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
    body,
    timeoutMs: 25000,
  }).then((res) => {
    if (res.json?.error) throw new Error("GEMINI_ERROR: " + res.json.error.message);
    const text = res.json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!text) throw new Error("GEMINI_EMPTY");
    return text;
  });
}

function callOpenAI(apiKey, messages, systemPrompt, model = "gpt-4.1-mini") {
  const body = {
    model,
    max_tokens: 4096,
    temperature: 0.05,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: "user",
        content: Array.isArray(m.content)
          ? m.content.map((c) =>
              c.type === "image_url"
                ? { type: "image_url", image_url: c.image_url }
                : { type: "text", text: c.text || String(c) }
            )
          : m.content,
      })),
    ],
  };

  return postJSON({
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
    timeoutMs: 25000,
  }).then((res) => {
    if (res.json?.error) throw new Error("OPENAI_ERROR: " + res.json.error.message);
    const text = res.json?.choices?.[0]?.message?.content || "";
    if (!text) throw new Error("OPENAI_EMPTY");
    return text;
  });
}

function callAnthropic(apiKey, messages, systemPrompt, model = "claude-sonnet-4-6") {
  const anthropicMessages = messages.map((m) => ({
    role: "user",
    content: Array.isArray(m.content)
      ? m.content.map((c) => {
          if (c.type === "image_url") {
            const url = c.image_url.url;
            const mediaType = url.split(";")[0].split(":")[1];
            const data = url.split(",")[1];
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data,
              },
            };
          }
          return { type: "text", text: c.text || String(c) };
        })
      : [{ type: "text", text: String(m.content) }],
  }));

  const body = {
    model,
    max_tokens: 4096,
    temperature: 0.05,
    system: systemPrompt,
    messages: anthropicMessages,
  };

  return postJSON({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body,
    timeoutMs: 30000,
  }).then((res) => {
    if (res.json?.error) throw new Error("ANTHROPIC_ERROR: " + (res.json.error.message || res.raw));
    const text = Array.isArray(res.json?.content)
      ? res.json.content.filter((v) => v.type === "text").map((v) => v.text).join("\n")
      : "";
    if (!text) throw new Error("ANTHROPIC_EMPTY");
    return text;
  });
}

function extractJSON(text) {
  const cleaned = String(text || "").replace(/```json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("JSON_NOT_FOUND");
  return JSON.parse(cleaned.substring(start, end + 1));
}

function sanitizeText(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function sanitizeContentArray(content) {
  if (Array.isArray(content)) {
    return content
      .map((v) => {
        if (typeof v === "string") return sanitizeText(v);
        if (v && typeof v === "object" && typeof v.text === "string") return sanitizeText(v.text);
        return sanitizeText(v);
      })
      .filter(Boolean);
  }
  if (typeof content === "string") {
    return content
      .split(/\r?\n|•|·|▪|▸|●/)
      .map((v) => sanitizeText(v))
      .filter(Boolean);
  }
  return [];
}

function normalizeType(type) {
  const t = sanitizeText(type).toLowerCase();
  if (t === "title" || t === "cover") return "title";
  if (t === "closing" || t === "end") return "closing";
  return "content";
}

function normalizeLayout(layout, content) {
  const l = sanitizeText(layout).toLowerCase();
  if (["bullets", "two-column", "stats", "quote"].includes(l)) return l;
  if (content.length === 1) return "quote";
  if (content.length <= 3 && content.some((v) => /\d/.test(v))) return "stats";
  return "bullets";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function resolveBudget(settings) {
  const rawMax = Number(settings?.maxSlides || 8);
  const maxSlides = rawMax >= 999 ? 30 : clamp(rawMax, 1, 30);
  let includeCover = settings?.includeCover !== false;
  let includeClosing = settings?.includeClosing !== false;

  if (maxSlides === 1) {
    includeCover = false;
    includeClosing = false;
  }

  let contentSlots = maxSlides - (includeCover ? 1 : 0) - (includeClosing ? 1 : 0);

  if (contentSlots < 1) {
    includeClosing = false;
    contentSlots = maxSlides - (includeCover ? 1 : 0);
  }

  if (contentSlots < 1) {
    includeCover = false;
    contentSlots = maxSlides;
  }

  contentSlots = Math.max(1, contentSlots);

  return { maxSlides, includeCover, includeClosing, contentSlots };
}

function guessTitle(inputText, fallbackName) {
  const lines = String(inputText || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  const t = lines[0] || fallbackName || "Presentation";
  return t.length > 60 ? t.slice(0, 60).trim() : t;
}

function mergeSlides(slides, targetCount) {
  if (slides.length <= targetCount) return slides;
  const result = slides.slice(0, targetCount).map((s) => ({ ...s, content: [...s.content] }));
  for (let i = targetCount; i < slides.length; i++) {
    result[targetCount - 1].content.push(...slides[i].content);
  }
  result[targetCount - 1].layout = normalizeLayout(result[targetCount - 1].layout, result[targetCount - 1].content);
  return result;
}

function makeFallbackContentSlides(inputText, contentSlots, fallbackName) {
  const lines = String(inputText || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);

  if (!lines.length) {
    return [
      {
        type: "content",
        title: guessTitle(inputText, fallbackName),
        layout: "bullets",
        content: [""],
        notes: "",
      },
    ];
  }

  const per = Math.max(3, Math.ceil(lines.length / contentSlots));
  const slides = [];
  for (let i = 0; i < lines.length; i += per) {
    const chunk = lines.slice(i, i + per);
    slides.push({
      type: "content",
      title: slides.length === 0 ? guessTitle(inputText, fallbackName) : `내용 ${slides.length + 1}`,
      layout: normalizeLayout("", chunk),
      content: chunk,
      notes: "",
    });
  }
  return slides;
}

function normalizeSlides(aiData, settings, inputText, fallbackName) {
  const budget = resolveBudget(settings);
  const rawSlides = Array.isArray(aiData?.slides) ? aiData.slides : [];

  let titleSlide = null;
  let closingSlide = null;
  const contentSlides = [];

  for (const raw of rawSlides) {
    const type = normalizeType(raw?.type);
    const title = sanitizeText(raw?.title);
    const subtitle = sanitizeText(raw?.subtitle);
    const notes = sanitizeText(raw?.notes);
    const content = sanitizeContentArray(raw?.content);
    const layout = normalizeLayout(raw?.layout, content);

    if (type === "title" && !titleSlide) {
      titleSlide = {
        type: "title",
        title: title || guessTitle(inputText, fallbackName),
        subtitle,
        layout: "bullets",
        content: [],
        notes,
      };
      continue;
    }

    if (type === "closing" && !closingSlide) {
      closingSlide = {
        type: "closing",
        title: title || "감사합니다",
        subtitle: "",
        layout: "bullets",
        content: content.slice(0, 2),
        notes,
      };
      continue;
    }

    const finalContent = content.length ? content : [title || subtitle].filter(Boolean);
    if (!finalContent.length) continue;

    contentSlides.push({
      type: "content",
      title: title || guessTitle(inputText, fallbackName),
      subtitle: "",
      layout,
      content: finalContent.slice(0, 12),
      notes,
    });
  }

  let finalContentSlides = contentSlides.length
    ? mergeSlides(contentSlides, budget.contentSlots)
    : makeFallbackContentSlides(inputText, budget.contentSlots, fallbackName);

  finalContentSlides = finalContentSlides.slice(0, budget.contentSlots);

  const finalTitle = sanitizeText(aiData?.title) || guessTitle(inputText, fallbackName);
  const slides = [];

  if (budget.includeCover) {
    slides.push(
      titleSlide || {
        type: "title",
        title: finalTitle,
        subtitle: "",
        layout: "bullets",
        content: [],
        notes: "",
      }
    );
  }

  slides.push(...finalContentSlides);

  if (budget.includeClosing) {
    slides.push(
      closingSlide || {
        type: "closing",
        title: "감사합니다",
        subtitle: "",
        layout: "bullets",
        content: [],
        notes: "",
      }
    );
  }

  return {
    title: finalTitle,
    slides: slides.slice(0, budget.maxSlides),
  };
}

function buildSystemPrompt(settings) {
  const budget = resolveBudget(settings);
  return [
    "You are a presentation structure engine.",
    "Return JSON only.",
    "Do not use markdown.",
    "Do not use backticks.",
    "Do not add new claims.",
    "Keep wording as close to the source as possible.",
    "Preserve the original language.",
    "Schema:",
    '{"title":"presentation title","slides":[{"type":"title|content|closing","title":"slide title","subtitle":"optional subtitle","layout":"bullets|two-column|stats|quote","content":["item 1","item 2"],"notes":""}]}',
    `Maximum total slides: ${budget.maxSlides}`,
    `Maximum content slides: ${budget.contentSlots}`,
    budget.includeCover ? "At most one title slide is allowed." : "Do not create a title slide.",
    budget.includeClosing ? "At most one closing slide is allowed." : "Do not create a closing slide.",
    "Do not return empty slides.",
    "Prefer fewer slides over too many slides.",
    "Use bullets by default.",
    "Use stats only for slides centered on up to 3 numeric outcomes.",
    "Use quote only for a single dominant statement.",
  ].join("\n");
}

function detectInputType(filename, mimeType, isBase64, textContent) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  const mime = String(mimeType || "").toLowerCase();

  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext) || mime.startsWith("image/")) return "image";
  if (["html", "htm"].includes(ext) || mime.includes("html")) return "html";
  if (["txt", "md"].includes(ext) || mime.startsWith("text/plain")) return "text";
  if (["doc", "docx", "hwp", "hwpx", "pdf"].includes(ext)) {
    if (textContent && String(textContent).trim()) return "document-text";
    return "binary-document";
  }
  if (isBase64 && mime.startsWith("image/")) return "image";
  return "text";
}

function buildMessages(inputType, { mimeType, content, isBase64, textContent }) {
  if (inputType === "image") {
    return [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${content}` } },
          { type: "text", text: "이 이미지의 내용을 발표 슬라이드 구조로 나눠 주세요. 원문 언어를 유지하고 새로운 주장이나 문장을 추가하지 마세요." },
        ],
      },
    ];
  }

  const inputText = String(textContent || content || "").substring(0, 12000);
  return [
    {
      role: "user",
      content: "아래 내용을 발표 슬라이드 구조로 나눠 주세요. 가능한 한 원문 표현을 유지하고 새로운 주장이나 문장을 추가하지 마세요.\n\n" + inputText,
    },
  ];
}

function buildModelPlan(inputType, keys) {
  const plan = [];

  if (inputType === "text") {
    if (keys.OPENAI_KEY) plan.push({ vendor: "openai", model: "gpt-4.1-mini" });
    if (keys.ANTHROPIC_KEY) plan.push({ vendor: "anthropic", model: "claude-sonnet-4-6" });
    if (keys.GOOGLE_KEY) plan.push({ vendor: "gemini", model: "gemini-2.5-flash" });
    return plan;
  }

  if (inputType === "html") {
    if (keys.OPENAI_KEY) plan.push({ vendor: "openai", model: "gpt-4.1" });
    if (keys.ANTHROPIC_KEY) plan.push({ vendor: "anthropic", model: "claude-sonnet-4-6" });
    if (keys.GOOGLE_KEY) plan.push({ vendor: "gemini", model: "gemini-2.5-flash" });
    return plan;
  }

  if (inputType === "image") {
    if (keys.GOOGLE_KEY) plan.push({ vendor: "gemini", model: "gemini-2.5-flash" });
    if (keys.ANTHROPIC_KEY) plan.push({ vendor: "anthropic", model: "claude-sonnet-4-6" });
    if (keys.OPENAI_KEY) plan.push({ vendor: "openai", model: "gpt-4.1-mini" });
    return plan;
  }

  if (inputType === "document-text") {
    if (keys.ANTHROPIC_KEY) plan.push({ vendor: "anthropic", model: "claude-sonnet-4-6" });
    if (keys.OPENAI_KEY) plan.push({ vendor: "openai", model: "gpt-4.1" });
    if (keys.GOOGLE_KEY) plan.push({ vendor: "gemini", model: "gemini-2.5-flash" });
    return plan;
  }

  return plan;
}

async function runModel(step, apiKeys, messages, systemPrompt) {
  if (step.vendor === "gemini") {
    const text = await callGemini(apiKeys.GOOGLE_KEY, messages, systemPrompt, step.model);
    return { raw: text, modelUsed: step.model };
  }
  if (step.vendor === "openai") {
    const text = await callOpenAI(apiKeys.OPENAI_KEY, messages, systemPrompt, step.model);
    return { raw: text, modelUsed: step.model };
  }
  if (step.vendor === "anthropic") {
    const text = await callAnthropic(apiKeys.ANTHROPIC_KEY, messages, systemPrompt, step.model);
    return { raw: text, modelUsed: step.model };
  }
  throw new Error("UNKNOWN_VENDOR");
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { filename, mimeType, content, isBase64, textContent, settings } = body;

    const apiKeys = {
      GOOGLE_KEY: process.env.GOOGLE_API_KEY,
      OPENAI_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_KEY: process.env.ANTHROPIC_API_KEY,
    };

    if (!apiKeys.GOOGLE_KEY && !apiKeys.OPENAI_KEY && !apiKeys.ANTHROPIC_KEY) {
      throw new Error("API 키가 설정되지 않았습니다.");
    }

    const inputType = detectInputType(filename, mimeType, isBase64, textContent);

    if (inputType === "binary-document") {
      throw new Error("DOC/DOCX/HWP/HWPX/PDF는 지금 구조에서 바로 읽을 수 없습니다. 먼저 서버에서 텍스트 추출 또는 PDF 렌더링 파서를 붙여야 합니다.");
    }

    const messages = buildMessages(inputType, { mimeType, content, isBase64, textContent });
    const systemPrompt = buildSystemPrompt(settings);
    const plan = buildModelPlan(inputType, apiKeys);

    if (!plan.length) {
      throw new Error("사용 가능한 모델 라우팅이 없습니다.");
    }

    let lastError = null;
    let rawResponse = "";
    let modelUsed = "";

    for (const step of plan) {
      try {
        const result = await runModel(step, apiKeys, messages, systemPrompt);
        rawResponse = result.raw;
        modelUsed = result.modelUsed;
        break;
      } catch (e) {
        lastError = e;
      }
    }

    if (!rawResponse) {
      throw new Error(lastError ? lastError.message : "모델 응답 실패");
    }

    let aiData = {};
    try {
      aiData = extractJSON(rawResponse);
    } catch (e) {
      aiData = {};
    }

    const inputTextForFallback = inputType === "image" ? "이미지 입력" : String(textContent || content || "").substring(0, 12000);
    const finalData = normalizeSlides(aiData, settings, inputTextForFallback, filename || "Presentation");

    if (!Array.isArray(finalData.slides) || !finalData.slides.length) {
      throw new Error("슬라이드 데이터가 비어 있습니다.");
    }

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        data: finalData,
        modelUsed,
        inputType,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: error.message || "UNKNOWN_ERROR" }),
    };
  }
};
