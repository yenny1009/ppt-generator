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
      generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
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

const SYSTEM_PROMPT = `You are an expert presentation designer and content strategist.
Analyze the input and create a well-structured PPT presentation.

CRITICAL: Return ONLY raw JSON. No markdown, no backticks, no text before or after the JSON.

JSON structure:
{
  "title": "Presentation Title",
  "theme": {
    "primary": "#HEX",
    "secondary": "#HEX",
    "accent": "#HEX",
    "background": "#HEX",
    "text": "#HEX"
  },
  "slides": [
    {"type":"title","title":"...","subtitle":"...","notes":"..."},
    {"type":"content","title":"...","layout":"bullets","content":["item1","item2","item3"],"notes":"..."},
    {"type":"closing","title":"감사합니다","content":["closing message"],"notes":""}
  ]
}

SLIDE STRUCTURE RULES:
- Total 6 to 10 slides
- Slide 1: type="title" (title + subtitle only)
- Slides 2~N-1: type="content" 
- Last slide: type="closing"
- Each content slide covers ONE specific topic only
- Split content logically — do NOT pack everything into 1-2 slides
- Each slide must have 3 to 5 content items maximum
- If input has many topics, create more slides to separate them clearly

LAYOUT RULES — choose the best fit per slide:
- "bullets": default for most content (lists, features, steps)
- "two-column": for comparisons, before/after, pros/cons
- "stats": for numbers, metrics, KPIs (3 items max)
- "quote": for key messages, mission statements, single important point

CONTENT RULES:
- Each content item: 1 concise sentence or phrase (under 20 words)
- Do NOT write paragraphs inside content items
- Use same language as the input (Korean input → Korean output)

THEME COLOR RULES:
- Choose colors that match the topic/industry
- primary: dark strong color for headers
- background: light or white for content slides
- accent: highlight color
- text: dark readable color`;

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
        { type: "text", text: "이 이미지 내용을 분석해서 PPT 슬라이드를 만들어주세요." }
      ]}];
    } else {
      const inputText = (textContent || content || "").substring(0, 8000);
      messages = [{ role: "user", content: `다음 내용으로 PPT 슬라이드를 만들어주세요. 내용을 논리적으로 여러 슬라이드에 나눠서 구성해주세요:\n\n${inputText}` }];
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
