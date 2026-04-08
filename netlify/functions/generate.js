const https = require("https");

function callAPI(provider, apiKey, model, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("API 응답 시간 초과 (22초)")), 22000);

    const hostname = "generativelanguage.googleapis.com";
    const path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const headers = { "Content-Type": "application/json" };

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
      generationConfig: {
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    });

    const options = { hostname, path, method: "POST", headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error("Gemini 오류: " + parsed.error.message));
            return;
          }
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

const SYSTEM_PROMPT = `You are a presentation designer. Analyze the input and return ONLY a valid JSON object with this exact structure. No markdown, no explanation, no code blocks - pure JSON only:

{"title":"presentation title","theme":{"primary":"#1E2761","secondary":"#CADCFC","accent":"#6C63FF","background":"#FFFFFF","text":"#1a1a2e"},"slides":[{"type":"title","title":"slide title","subtitle":"subtitle","notes":"notes"},{"type":"content","title":"slide title","layout":"bullets","content":["item1","item2","item3"],"notes":"notes"}]}

Rules:
- 5 to 12 slides total
- First slide must be type "title"
- Last slide must be type "closing"
- Layout options: bullets, two-column, stats, quote
- Match language of input content
- Return ONLY the JSON object, nothing else`;

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
        { type: "text", text: "Analyze this image and create a PPT slide structure." }
      ]}];
    } else {
      const inputText = (textContent || content || "").substring(0, 8000);
      messages = [{ role: "user", content: `Create PPT slides from this content:\n\n${inputText}` }];
    }

    const rawResponse = await callAPI("google", GOOGLE_KEY, "gemini-2.5-flash-preview-04-17", messages, SYSTEM_PROMPT);

    let slideData;
    try {
      slideData = JSON.parse(rawResponse);
    } catch {
      const match = rawResponse.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("AI가 올바른 JSON을 반환하지 않았습니다. 다시 시도해주세요.");
      slideData = JSON.parse(match[0]);
    }

    if (!slideData.slides || !Array.isArray(slideData.slides)) {
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
