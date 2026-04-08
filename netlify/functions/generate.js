const https = require("https");

function callGemini(apiKey, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), 20000);
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
    const body = JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: 8192, temperature: 0.05 },
    });
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error("GEMINI_ERROR: " + parsed.error.message));
              return;
            }
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (!text) {
              reject(new Error("GEMINI_EMPTY"));
              return;
            }
            resolve(text);
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
    req.write(body);
    req.end();
  });
}

function callOpenAI(apiKey, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OPENAI_TIMEOUT")), 22000);
    const msgs = [
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
    ];
    const body = JSON.stringify({
      model: "gpt-4.1-mini",
      max_tokens: 4096,
      temperature: 0.05,
      messages: msgs,
    });
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              reject(new Error("OPENAI_ERROR: " + parsed.error.message));
              return;
            }
            const text = parsed.choices?.[0]?.message?.content || "";
            if (!text) {
              reject(new Error("OPENAI_EMPTY"));
              return;
            }
            resolve(text);
          } catch (e) {
            reject(new Error("OPENAI_PARSE_ERROR: " + data.substring(0, 300)));
          }
        });
      }
    );
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

function extractJSON(text) {
  const cleaned = String(text || "").replace(/```json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("JSON_NOT_FOUND");
  return JSON.parse(cleaned.substring(start, end + 1));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function resolveBudget(settings) {
  const rawMax = Number(settings?.maxSlides || 8);
  const unlimited = rawMax >= 999;
  const maxSlides = unlimited ? 30 : clamp(rawMax, 1, 30);
  let includeCover = settings?.includeCover !== false;
  let includeClosing = settings?.includeClosing !== false;

  if (maxSlides <= 1) {
    includeCover = false;
    includeClosing = false;
  } else {
    if (includeCover && maxSlides - 1 < 1) includeCover = false;
    if (includeClosing && maxSlides - (includeCover ? 1 : 0) - 1 < 1) includeClosing = false;
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

  return {
    maxSlides,
    includeCover,
    includeClosing,
    contentSlots,
    unlimited,
  };
}

function buildSystemPrompt(settings) {
  const budget = resolveBudget(settings);
  const coreColor = settings?.coreColor || "#2196F3";
  const mood = settings?.colorMood || "dark";
  const moodDesc = {
    clean: "white-base, crisp, editorial, bright",
    dark: "deep, premium, cinematic",
    soft: "soft, pastel, airy",
    bold: "high-contrast, striking, energetic",
    minimal: "neutral, simple, restrained",
    warm: "warm, friendly, natural",
  }[mood] || "clean";

  return `
You are a presentation structure engine.

Your job:
- Split the source text into slide groups
- Preserve the original language
- Preserve original meaning
- Do not add new claims
- Keep wording as close to the input as possible
- Return JSON only

Return this exact schema:
{
  "title": "presentation title",
  "slides": [
    {
      "type": "title | content | closing",
      "title": "slide title",
      "subtitle": "optional subtitle",
      "layout": "bullets | two-column | stats | quote",
      "content": ["item 1", "item 2"],
      "notes": ""
    }
  ]
}

Hard constraints:
- Total slides must be at most ${budget.maxSlides}
- Content slides must be at most ${budget.contentSlots}
- ${budget.includeCover ? 'Include one title slide if it fits naturally' : 'Do not include any title slide'}
- ${budget.includeClosing ? 'Include one closing slide only if useful' : 'Do not include any closing slide'}
- Never return more than 1 title slide
- Never return more than 1 closing slide
- Do not return empty slides
- Prefer fewer slides over too many slides
- Max 6 content items per slide
- If source is short, use the minimum number of slides needed
- If source is very short, 1 content slide is allowed
- No markdown
- No backticks
- JSON only

Layout guidance:
- bullets: default
- two-column: clear comparison or parallel lists
- stats: only when the slide mainly contains up to 3 numeric outcomes
- quote: only when a single statement dominates

Context:
- Requested mood: ${moodDesc}
- Core color: ${coreColor}
`;
}

function toTextLines(inputText) {
  return String(inputText || "")
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function guessTitle(inputText, fallbackName) {
  const lines = toTextLines(inputText);
  const first = lines[0] || fallbackName || "Presentation";
  return first.length > 60 ? first.slice(0, 60).trim() : first;
}

function sanitizeText(v) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim();
}

function sanitizeContentArray(content) {
  if (Array.isArray(content)) {
    return content
      .map((v) => {
        if (typeof v === "string") return sanitizeText(v);
        if (v && typeof v === "object") {
          if (typeof v.text === "string") return sanitizeText(v.text);
          return sanitizeText(JSON.stringify(v));
        }
        return sanitizeText(v);
      })
      .filter(Boolean);
  }
  if (typeof content === "string") {
    return content
      .split(/\r?\n|•|·|▪|▸|●|-/)
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
  if (content.length <= 1) return "quote";
  if (content.length <= 3 && content.some((v) => /\d/.test(v))) return "stats";
  return "bullets";
}

function makeFallbackContentSlides(inputText, contentSlots) {
  const lines = toTextLines(inputText);
  if (lines.length === 0) {
    return [
      {
        type: "content",
        title: "내용",
        layout: "bullets",
        content: [""],
        notes: "",
      },
    ];
  }
  const maxPerSlide = Math.max(3, Math.ceil(lines.length / contentSlots));
  const slides = [];
  let idx = 0;
  while (idx < lines.length) {
    const chunk = lines.slice(idx, idx + maxPerSlide);
    slides.push({
      type: "content",
      title: slides.length === 0 ? guessTitle(inputText, "내용") : `내용 ${slides.length + 1}`,
      layout: chunk.length <= 3 && chunk.some((v) => /\d/.test(v)) ? "stats" : "bullets",
      content: chunk,
      notes: "",
    });
    idx += maxPerSlide;
  }
  return slides;
}

function mergeSlides(slides, targetCount) {
  if (slides.length <= targetCount) return slides;
  const result = slides.slice(0, targetCount).map((s) => ({
    ...s,
    content: [...s.content],
  }));
  for (let i = targetCount; i < slides.length; i++) {
    result[targetCount - 1].content.push(...slides[i].content);
  }
  result[targetCount - 1].layout = normalizeLayout(result[targetCount - 1].layout, result[targetCount - 1].content);
  return result;
}

function trimSlideContent(slide) {
  const maxItems = 12;
  slide.content = slide.content.filter(Boolean).slice(0, maxItems);
  if (slide.layout === "stats") slide.content = slide.content.slice(0, 3);
  if (slide.layout === "quote") slide.content = slide.content.slice(0, 1);
  return slide;
}

function normalizeSlides(aiData, settings, inputText, fallbackName) {
  const budget = resolveBudget(settings);
  const rawSlides = Array.isArray(aiData?.slides) ? aiData.slides : [];
  const normalized = rawSlides
    .map((sl) => {
      const content = sanitizeContentArray(sl?.content);
      const title = sanitizeText(sl?.title);
      const subtitle = sanitizeText(sl?.subtitle);
      const notes = sanitizeText(sl?.notes);
      const type = normalizeType(sl?.type);
      const layout = normalizeLayout(sl?.layout, content);
      return {
        type,
        title,
        subtitle,
        layout,
        content,
        notes,
      };
    })
    .filter((sl) => sl.title || sl.subtitle || sl.content.length);

  let titleSlide = null;
  let closingSlide = null;
  const contentSlides = [];

  for (const sl of normalized) {
    if (sl.type === "title" && !titleSlide) {
      titleSlide = {
        type: "title",
        title: sl.title || guessTitle(inputText, fallbackName),
        subtitle: sl.subtitle || "",
        layout: "bullets",
        content: [],
        notes: sl.notes || "",
      };
      continue;
    }
    if (sl.type === "closing" && !closingSlide) {
      closingSlide = {
        type: "closing",
        title: sl.title || "감사합니다",
        subtitle: "",
        layout: "bullets",
        content: sl.content.length ? sl.content.slice(0, 2) : [],
        notes: sl.notes || "",
      };
      continue;
    }
    const content = sl.content.length ? sl.content : [sl.title || sl.subtitle].filter(Boolean);
    if (content.length) {
      contentSlides.push(
        trimSlideContent({
          type: "content",
          title: sl.title || guessTitle(inputText, fallbackName),
          subtitle: "",
          layout: normalizeLayout(sl.layout, content),
          content,
          notes: sl.notes || "",
        })
      );
    }
  }

  let finalContentSlides = contentSlides.length
    ? contentSlides
    : makeFallbackContentSlides(inputText, budget.contentSlots);

  finalContentSlides = mergeSlides(finalContentSlides, budget.contentSlots);

  if (finalContentSlides.length > budget.contentSlots) {
    finalContentSlides = finalContentSlides.slice(0, budget.contentSlots);
  }

  if (!finalContentSlides.length) {
    finalContentSlides = [
      {
        type: "content",
        title: guessTitle(inputText, fallbackName),
        layout: "bullets",
        content: toTextLines(inputText).slice(0, 8),
        notes: "",
      },
    ];
  }

  const finalSlides = [];
  const finalTitle = sanitizeText(aiData?.title) || guessTitle(inputText, fallbackName);

  if (budget.includeCover) {
    finalSlides.push(
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

  finalSlides.push(...finalContentSlides.slice(0, budget.contentSlots));

  if (budget.includeClosing) {
    finalSlides.push(
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

  const finalTrimmed = finalSlides.slice(0, budget.maxSlides);

  return {
    title: finalTitle,
    slides: finalTrimmed,
  };
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
    return {
      statusCode: 405,
      headers: cors,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { filename, mimeType, content, isBase64, textContent, settings } = body;

    const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    if (!GOOGLE_KEY && !OPENAI_KEY) {
      return {
        statusCode: 500,
        headers: cors,
        body: JSON.stringify({ error: "API 키가 설정되지 않았습니다." }),
      };
    }

    const ext = String(filename || "").toLowerCase().split(".").pop();
    const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext) || String(mimeType || "").startsWith("image/");

    let inputText = "";
    let messages = [];

    if (isImage && isBase64) {
      inputText = "이미지 입력";
      messages = [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${content}` } },
            {
              type: "text",
              text: "이 이미지 안의 텍스트 구조를 발표 슬라이드로 나눠 주세요. 원문의 언어를 유지하고 새로운 내용을 추가하지 마세요.",
            },
          ],
        },
      ];
    } else {
      inputText = String(textContent || content || "").substring(0, 12000);
      messages = [
        {
          role: "user",
          content:
            "아래 내용을 발표 슬라이드 구조로 나눠 주세요. 가능한 한 원문 표현을 유지하고 새로운 주장이나 문장을 추가하지 마세요.\n\n" +
            inputText,
        },
      ];
    }

    const systemPrompt = buildSystemPrompt(settings);
    let rawResponse = "";
    let modelUsed = "";

    if (GOOGLE_KEY) {
      try {
        rawResponse = await callGemini(GOOGLE_KEY, messages, systemPrompt);
        modelUsed = "gemini-2.5-flash";
      } catch (geminiErr) {
        if (OPENAI_KEY) {
          rawResponse = await callOpenAI(OPENAI_KEY, messages, systemPrompt);
          modelUsed = "gpt-4.1-mini (fallback)";
        } else {
          throw new Error("Gemini 오류: " + geminiErr.message);
        }
      }
    } else {
      rawResponse = await callOpenAI(OPENAI_KEY, messages, systemPrompt);
      modelUsed = "gpt-4.1-mini";
    }

    let aiData = {};
    try {
      aiData = extractJSON(rawResponse);
    } catch (e) {
      aiData = {};
    }

    const finalData = normalizeSlides(aiData, settings, inputText, filename || "Presentation");

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        data: finalData,
        modelUsed,
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
