const https = require("https");

function callGemini(apiKey, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), 18000);
    const contents = messages.map((m) => ({
      role: "user",
      parts: Array.isArray(m.content)
        ? m.content.map((c) =>
            c.type === "image_url"
              ? { inline_data: { mime_type: c.image_url.url.split(";")[0].split(":")[1], data: c.image_url.url.split(",")[1] } }
              : { text: c.text || String(c) }
          )
        : [{ text: m.content }],
    }));
    const body = JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { maxOutputTokens: 8192, temperature: 0.1 },
    });
    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { reject(new Error("GEMINI_ERROR: " + parsed.error.message)); return; }
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (!text) { reject(new Error("GEMINI_EMPTY")); return; }
          resolve(text);
        } catch (e) { reject(new Error("PARSE_ERROR: " + data.substring(0, 200))); }
      });
    });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

function callOpenAI(apiKey, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenAI 응답 시간 초과")), 20000);
    const msgs = [{ role: "system", content: systemPrompt }, ...messages.map(m => ({
      role: "user",
      content: Array.isArray(m.content)
        ? m.content.map(c => c.type === "image_url"
            ? { type: "image_url", image_url: c.image_url }
            : { type: "text", text: c.text || String(c) })
        : m.content
    }))];
    const body = JSON.stringify({ model: "gpt-4.1-mini", max_tokens: 4096, messages: msgs });
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { reject(new Error("OpenAI 오류: " + parsed.error.message)); return; }
          const text = parsed.choices?.[0]?.message?.content || "";
          if (!text) { reject(new Error("OpenAI 응답이 비어있습니다.")); return; }
          resolve(text);
        } catch (e) { reject(new Error("OpenAI 파싱 실패: " + data.substring(0, 200))); }
      });
    });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.write(body);
    req.end();
  });
}

function extractJSON(text) {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("JSON을 찾을 수 없습니다.");
  return JSON.parse(cleaned.substring(start, end + 1));
}

function buildSystemPrompt(settings) {
  const includeCover = settings?.includeCover !== false;
  const includeClosing = settings?.includeClosing !== false;
  const maxSlides = settings?.maxSlides || 8;
  const maxStr = maxSlides >= 999 ? "내용에 맞게 최적화" : `최대 ${maxSlides}장`;
  const coreColor = settings?.coreColor || "#2196F3";
  const mood = settings?.colorMood || "dark";
  const moodDesc = {
    clean: "화이트 베이스, 선명한 포인트 컬러",
    dark: "딥 다크 배경, 세련되고 고급스러운",
    soft: "파스텔 톤, 밝고 부드러운",
    bold: "강한 대비, 임팩트 있는",
    minimal: "무채색 계열, 심플하고 깔끔한",
    warm: "따뜻한 톤, 친근하고 자연스러운",
  }[mood] || "딥 다크 배경";

  return `You are a presentation slide formatter. Organize input content into slides WITHOUT changing, summarizing, or rewriting any text.

CRITICAL RULES:
1. NEVER rewrite, summarize, or paraphrase — use EXACT words from input
2. Only split and organize content into logical slide groups
3. Return ONLY raw JSON — no markdown, no backticks, no explanation

JSON structure:
{"title":"exact title","theme":{"primary":"#HEX","secondary":"#HEX","accent":"#HEX","background":"#HEX","text":"#HEX"},"slides":[{"type":"title","title":"exact title","subtitle":"exact subtitle","notes":""},{"type":"content","title":"exact heading","layout":"bullets","content":["exact item 1","exact item 2"],"notes":""},{"type":"closing","title":"감사합니다","content":[""],"notes":""}]}

SLIDE STRUCTURE:
- Total: ${maxStr}
- Cover (type="title"): ${includeCover ? "INCLUDE as first slide" : "DO NOT include"}
- Closing (type="closing"): ${includeClosing ? "INCLUDE as last slide" : "DO NOT include"}
- Group ONLY thematically related items on same slide
- Max 5 items per slide — split if more
- Short input (under 5 lines): use minimum slides needed

LAYOUT: "bullets"(default) | "two-column"(comparisons) | "stats"(max 3 numbers) | "quote"(single statement)

THEME — generate harmonious colors based on:
- Core color: ${coreColor}
- Mood: ${moodDesc}
- primary: main background/header matching mood
- accent: use ${coreColor} or close variation
- All colors must harmonize with core color and mood

Use same language as input. Return ONLY the JSON.`;
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: JSON.stringify({ error: "Method Not Allowed" }) };

  try {
    const body = JSON.parse(event.body);
    const { filename, mimeType, content, isBase64, textContent, settings } = body;

    const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;

    const ext = (filename || "").toLowerCase().split(".").pop();
    const isImage = ["jpg","jpeg","png","gif","webp"].includes(ext) || (mimeType || "").startsWith("image/");

    let messages = [];
    if (isImage && isBase64) {
      messages = [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${content}` } },
        { type: "text", text: "이 이미지의 텍스트 내용을 그대로 PPT 슬라이드로 구성해주세요. 내용을 절대 수정하지 마세요." }
      ]}];
    } else {
      const inputText = (textContent || content || "").substring(0, 8000);
      messages = [{ role: "user", content: `아래 내용을 슬라이드로 구성해주세요. 텍스트를 절대 수정하거나 요약하지 말고 원문 그대로 사용하세요:\n\n${inputText}` }];
    }

    const systemPrompt = buildSystemPrompt(settings);
    let rawResponse = "";
    let modelUsed = "";

    // Gemini 1순위, 실패 시 OpenAI 자동 폴백
    if (GOOGLE_KEY) {
      try {
        rawResponse = await callGemini(GOOGLE_KEY, messages, systemPrompt);
        modelUsed = "gemini-2.5-flash";
      } catch (geminiErr) {
        console.log("Gemini 실패, OpenAI로 전환:", geminiErr.message);
        if (OPENAI_KEY) {
          rawResponse = await callOpenAI(OPENAI_KEY, messages, systemPrompt);
          modelUsed = "gpt-4.1-mini (fallback)";
        } else {
          throw new Error("Gemini 오류: " + geminiErr.message + " / OpenAI 키 없음");
        }
      }
    } else if (OPENAI_KEY) {
      rawResponse = await callOpenAI(OPENAI_KEY, messages, systemPrompt);
      modelUsed = "gpt-4.1-mini";
    } else {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "API 키가 설정되지 않았습니다." }) };
    }

    const slideData = extractJSON(rawResponse);

    if (!slideData.slides || !Array.isArray(slideData.slides) || slideData.slides.length === 0) {
      throw new Error("슬라이드 데이터가 올바르지 않습니다. 다시 시도해주세요.");
    }

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, data: slideData, modelUsed }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
