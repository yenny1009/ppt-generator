const https = require("https");

function callAPI(provider, apiKey, model, messages, systemPrompt) {
  return new Promise((resolve, reject) => {
    let hostname, path, headers, body;

    if (provider === "anthropic") {
      hostname = "api.anthropic.com";
      path = "/v1/messages";
      headers = {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      };
      body = JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      });
    } else if (provider === "openai") {
      hostname = "api.openai.com";
      path = "/v1/chat/completions";
      headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      };
      const msgs = systemPrompt
        ? [{ role: "system", content: systemPrompt }, ...messages]
        : messages;
      body = JSON.stringify({ model, max_tokens: 4096, messages: msgs });
    } else if (provider === "google") {
      hostname = "generativelanguage.googleapis.com";
      path = `/v1beta/models/${model}:generateContent?key=${apiKey}`;
      headers = { "Content-Type": "application/json" };
      const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: Array.isArray(m.content)
          ? m.content.map((c) =>
              c.type === "image_url"
                ? {
                    inline_data: {
                      mime_type: c.image_url.url.split(";")[0].split(":")[1],
                      data: c.image_url.url.split(",")[1],
                    },
                  }
                : { text: c.text || c }
            )
          : [{ text: m.content }],
      }));
      body = JSON.stringify({
        contents,
        systemInstruction: systemPrompt
          ? { parts: [{ text: systemPrompt }] }
          : undefined,
        generationConfig: { maxOutputTokens: 4096 },
      });
    }

    const options = { hostname, path, method: "POST", headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          let text = "";
          if (provider === "anthropic") {
            text = parsed.content?.[0]?.text || "";
          } else if (provider === "openai") {
            text = parsed.choices?.[0]?.message?.content || "";
          } else if (provider === "google") {
            text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
          }
          resolve(text);
        } catch (e) {
          reject(new Error("API 응답 파싱 실패: " + data.substring(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function detectFileType(filename, mimeType) {
  const ext = filename.toLowerCase().split(".").pop();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx"].includes(ext)) return "word";
  if (ext === "hwp" || ext === "hwpx") return "hwp";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "txt") return "text";
  if (mimeType?.startsWith("image/")) return "image";
  return "text";
}

function selectModel(fileType) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const GOOGLE_KEY = process.env.GOOGLE_API_KEY;

  const models = {
    text: {
      provider: "openai",
      model: "gpt-4.1-mini",
      key: OPENAI_KEY,
      supportsVision: false,
    },
    html: {
      provider: "openai",
      model: "gpt-4.1",
      key: OPENAI_KEY,
      supportsVision: false,
    },
    image: {
      provider: "google",
      model: "gemini-2.5-flash",
      key: GOOGLE_KEY,
      supportsVision: true,
    },
    pdf: {
      provider: "google",
      model: "gemini-2.5-flash",
      key: GOOGLE_KEY,
      supportsVision: true,
    },
    word: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      key: ANTHROPIC_KEY,
      supportsVision: true,
    },
    hwp: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      key: ANTHROPIC_KEY,
      supportsVision: true,
    },
  };
  return models[fileType] || models.text;
}

const SYSTEM_PROMPT = `당신은 전문 프레젠테이션 디자이너입니다.
업로드된 파일이나 텍스트를 분석하여 PPT 슬라이드 구조를 JSON으로 반환하세요.

반드시 아래 JSON 형식만 반환하세요. 다른 텍스트는 절대 포함하지 마세요:

{
  "title": "프레젠테이션 제목",
  "theme": {
    "primary": "#HEX색상",
    "secondary": "#HEX색상",
    "accent": "#HEX색상",
    "background": "#HEX색상",
    "text": "#HEX색상"
  },
  "slides": [
    {
      "type": "title",
      "title": "제목",
      "subtitle": "부제목",
      "notes": "발표자 노트"
    },
    {
      "type": "content",
      "title": "슬라이드 제목",
      "layout": "bullets | two-column | image-text | stats | quote",
      "content": ["항목1", "항목2", "항목3"],
      "notes": "발표자 노트"
    }
  ]
}

규칙:
- 슬라이드는 최소 5장, 최대 15장
- 콘텐츠 성격에 맞는 테마 컬러 자동 선정
- 첫 슬라이드는 반드시 type: "title"
- 마지막 슬라이드는 type: "closing" (마무리/감사 슬라이드)
- 한국어 콘텐츠면 한국어로, 영어면 영어로 출력
- JSON 외 어떤 텍스트도 포함하지 말 것`;

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { filename, mimeType, content, isBase64, textContent } = body;

    const fileType = filename
      ? detectFileType(filename, mimeType)
      : "text";
    const modelConfig = selectModel(fileType);

    if (!modelConfig.key) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: `${fileType} 처리에 필요한 API 키가 설정되지 않았습니다.`,
        }),
      };
    }

    let messages = [];

    if (fileType === "image" && isBase64) {
      if (modelConfig.provider === "google") {
        messages = [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${content}` },
              },
              {
                type: "text",
                text: "이 이미지의 내용을 분석하여 PPT 슬라이드 JSON을 생성하세요.",
              },
            ],
          },
        ];
      } else if (modelConfig.provider === "anthropic") {
        messages = [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mimeType, data: content },
              },
              {
                type: "text",
                text: "이 이미지의 내용을 분석하여 PPT 슬라이드 JSON을 생성하세요.",
              },
            ],
          },
        ];
      }
    } else {
      const inputText = textContent || content || "";
      messages = [
        {
          role: "user",
          content: `다음 내용을 분석하여 PPT 슬라이드 JSON을 생성하세요:\n\n${inputText.substring(0, 8000)}`,
        },
      ];
    }

    const rawResponse = await callAPI(
      modelConfig.provider,
      modelConfig.key,
      modelConfig.model,
      messages,
      SYSTEM_PROMPT
    );

    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("AI가 유효한 JSON을 반환하지 않았습니다.");
    }

    const slideData = JSON.parse(jsonMatch[0]);

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ success: true, data: slideData, modelUsed: modelConfig.model }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
