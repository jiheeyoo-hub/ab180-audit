// api/query.js — Vercel Serverless Function (CommonJS)

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-5-20251001";
const MCP_URL = "https://mcp-server.prod.us-west-2.amplitude.com/v1/mcp?orgId=36958";

async function callAnthropic(apiKey, body, useMcp) {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (useMcp) {
    headers["anthropic-beta"] = "mcp-client-2025-04-04";
  }
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

function extractText(data) {
  return data.content?.find(b => b.type === "text")?.text || "";
}

function extractToolResults(data) {
  return (data.content || [])
    .filter(b => b.type === "mcp_tool_result")
    .map(t => {
      try { return JSON.parse(t.content?.[0]?.text || "{}"); } catch { return {}; }
    });
}

function safeParseJson(text) {
  try {
    const clean = text.replace(/```json\n?|```\n?/g, "").trim();
    const start = clean.indexOf("{");
    if (start !== -1) return JSON.parse(clean.slice(start));
  } catch {}
  return null;
}

// 쿼리 1개 — 빠른 단일 MCP 호출
async function amplitudeQuery(apiKey, params) {
  const prompt = `Call the query_agent_analytics_sessions tool with exactly these parameters and return ONLY the raw JSON result:
${JSON.stringify(params)}`;

  const data = await callAnthropic(apiKey, {
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
    mcp_servers: [{ type: "url", url: MCP_URL, name: "amplitude" }],
  }, true);

  const toolResults = extractToolResults(data);
  if (toolResults.length > 0) return toolResults[toolResults.length - 1];

  const parsed = safeParseJson(extractText(data));
  return parsed || {};
}

// AI 분석 — MCP 없이
async function generateAnalysis(apiKey, customerName, customerId, days, users, agents, topics, fails) {
  const prompt = `You are an Amplitude CSM analyst for AB180 (Korean Amplitude partner).
Customer: "${customerName}" (org ${customerId}), last ${days} days.

Users (top 8): ${JSON.stringify(users.slice(0,8))}
Agents: ${JSON.stringify(agents)}
Topics (top 8): ${JSON.stringify(topics.slice(0,8))}
Failed sessions: ${JSON.stringify(fails.slice(0,3))}

Return ONLY valid JSON (no markdown, no explanation):
{
  "summary": "3문장 한국어 요약",
  "failureCases": [
    {
      "user": "이메일",
      "agent": "에이전트명",
      "quality": 0.5,
      "date": "날짜",
      "asked": "유저가 시도한 것 (한국어 2문장)",
      "happened": "무엇이 잘못됐는지 (한국어 2문장)",
      "rootCause": "근본 원인 (한국어 1문장)",
      "solution": "해결 방법 (한국어 1문장)"
    }
  ],
  "actionItems": [
    {
      "priority": "urgent|high|medium",
      "title": "짧은 액션 제목 (한국어)",
      "description": "설명 (한국어 2문장)"
    }
  ]
}`;

  const data = await callAnthropic(apiKey, {
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  }, false);

  const parsed = safeParseJson(extractText(data));
  return parsed || { summary: "분석 데이터 없음", failureCases: [], actionItems: [] };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    const { orgId, orgName, days = 30 } = req.body;
    if (!orgId) return res.status(400).json({ error: "orgId required" });

    const startDate = new Date(Date.now() - days * 864e5).toISOString().split("T")[0];
    const orgIds = [String(orgId)];

    // 4개 쿼리를 Promise.all로 병렬 실행
    const [userData, agentData, topicData, failData] = await Promise.all([
      amplitudeQuery(apiKey, { customerOrgIds: orgIds, groupBy: ["user_id"], limit: 200, startDate }),
      amplitudeQuery(apiKey, { customerOrgIds: orgIds, groupBy: ["agent_name"], startDate }),
      amplitudeQuery(apiKey, { customerOrgIds: orgIds, groupBy: ["primary_topic"], startDate }),
      amplitudeQuery(apiKey, { customerOrgIds: orgIds, hasTaskFailure: true, limit: 8, responseFormat: "detailed", startDate }),
    ]);

    const users  = userData?.data?.aggregations  || userData?.aggregations  || [];
    const agents = agentData?.data?.aggregations || agentData?.aggregations || [];
    const topics = topicData?.data?.aggregations || topicData?.aggregations || [];
    const fails  = failData?.data?.sessions      || failData?.sessions      || [];
    const total  = userData?.data?.total_count   || users.reduce((s, u) => s + u.session_count, 0);

    // AI 분석 (데이터 수집 완료 후)
    const analysis = await generateAnalysis(apiKey, orgName, orgId, days, users, agents, topics, fails);

    return res.status(200).json({ ok: true, data: { users, agents, topics, fails, total, analysis } });

  } catch (err) {
    console.error("Handler error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};
