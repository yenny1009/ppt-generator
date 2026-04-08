const https = require("https");

function callGemini(apiKey, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("API 응답 시간 초과")), 22000);
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
    const options = {
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { reject(new Error("Gemini 오류: " + parsed.error.message)); return; }
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
          resolve(text);
        } catch (e) {
          reject(new Error("응답 파싱 실패: " + data.substring(0, 300)));
        }
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

  return `You are a presentation slide formatter. Your job is to organize the input content into slides WITHOUT changing, summarizing, or rewriting any of the text.

CRITICAL RULES — NEVER VIOLATE:
1. NEVER rewrite, summarize, or paraphrase the input content
2. Use the EXACT words from the input as-is
3. Only split and organize the content into logical slide groups
4. Return ONLY raw JSON — no markdown, no backticks, no explanation

JSON structure:
{
  "title": "exact title from input or first line",
  "theme": {
    "primary": "#HEX",
    "secondary": "#HEX", 
    "accent": "#HEX",
    "background": "#HEX",
    "text": "#HEX"
  },
  "slides": [
    {"type":"title","title":"exact title","subtitle":"exact subtitle if exists","notes":""},
    {"type":"content","title":"exact section heading","layout":"bullets","content":["exact item 1","exact item 2"],"notes":""},
    {"type":"closing","title":"감사합니다","content":[""],"notes":""}
  ]
}

SLIDE STRUCTURE:
- Total slides: ${maxStr}
- Cover slide (type="title"): ${includeCover ? 'INCLUDE as first slide' : 'DO NOT include'}
- Closing slide (type="closing"): ${includeClosing ? 'INCLUDE as last slide' : 'DO NOT include'}
- Content slides: group ONLY thematically related items together on the same slide
- Each slide: maximum 5 items — if a group has more, split into multiple slides with same heading
- If input is very short (under 5 lines), use minimum slides needed

GROUPING RULES:
- Items that belong to the same category/topic go on the same slide
- Items from different categories go on separate slides
- Never mix unrelated content on one slide
- Use the exact heading/title text from the input for slide titles

LAYOUT SELECTION:
- "bullets": lists, features, action items (default)
- "two-column": explicitly comparative content
- "stats": numeric metrics, KPIs (max 3 items)
- "quote": single key statement

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
    if (!GOOGLE_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "GOOGLE_API_KEY가 설정되지 않았습니다." }) };

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
    const rawResponse = await callGemini(GOOGLE_KEY, messages, systemPrompt);
    const slideData = extractJSON(rawResponse);

    if (!slideData.slides || !Array.isArray(slideData.slides) || slideData.slides.length === 0) {
      throw new Error("슬라이드 데이터가 올바르지 않습니다. 다시 시도해주세요.");
    }

    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, data: slideData, modelUsed: "gemini-2.5-flash" }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
