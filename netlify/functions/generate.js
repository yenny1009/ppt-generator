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
      generationConfig: { maxOutputTokens: 4096, temperature: 0.3 },
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
          reject(new Error("응답 파싱 실패: " + data.substring(0, 200)));
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

const SYSTEM_PROMPT = `You are a presentation designer. Analyze the input content and return a JSON object for a PPT presentation.

IMPORTANT: Return ONLY raw JSON. No markdown, no backticks, no explanation text before or after.

Required JSON structure:
{
  "title": "Presentation Title",
  "theme": {
    "primary": "#1E2761",
    "secondary": "#CADCFC",
    "accent": "#6C63FF",
    "background": "#FFFFFF",
    "text": "#1a1a2e"
  },
  "slides": [
    {
      "type": "title",
      "title": "Main Title",
      "subtitle": "Subtitle here",
      "notes": "Speaker notes"
    },
    {
      "type": "content",
      "title": "Slide Title",
      "layout": "bullets",
      "content": ["Point 1", "Point 2", "Point 3"],
      "notes": "Speaker notes"
    },
    {
      "type": "closing",
      "title": "Thank You",
      "content": ["Contact info or closing message"],
      "notes": ""
    }
  ]
}

Rules:
- Generate 5 to 10 slides
- First slide: type must be "title"
- Last slide: type must be "closing"
- Layout choices: bullets, two-column, stats, quote
- Use same language as the input content
- Choose appropriate theme colors for the topic
- Return ONLY the JSON object with no other text`;

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
    const { filename, mimeType, content, isBase64, textContent } = body;

    const GOOGLE_KEY = process.env.GOOGLE_API_KEY;
    if (!GOOGLE_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "GOOGLE_API_KEY가 설정되지 않았습니다." }) };

    const ext = (filename || "").toLowerCase().split(".").pop();
    const isImage = ["jpg","jpeg","png","gif","webp"].includes(ext) || (mimeType || "").startsWith("image/");

    let messages = [];
    if (isImage && isBase64) {
      messages = [{ role: "user", content: [
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${content}` } },
        { type: "text", text: "Analyze this image and create PPT slides." }
      ]}];
    } else {
      const inputText = (textContent || content || "").substring(0, 8000);
      messages = [{ role: "user", content: `Create PPT slides from this content:\n\n${inputText}` }];
    }

    const rawResponse = await callGemini(GOOGLE_KEY, messages, SYSTEM_PROMPT);
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
