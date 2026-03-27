// api/query.js — Vercel Serverless Function
// 병렬 처리로 속도 최적화

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const MCP_URL = "https://mcp-server.prod.us-west-2.amplitude.com/v1/mcp?orgId=36958";

// Amplitude MCP를 단일 Claude 호출로 모두 조회 (병렬)
async function fetchAllAmplitudeData(orgIds, startDate, apiKey) {
  const prompt = `You must call ALL FOUR tools in parallel simultaneously right now. Do not wait between calls. Call all four at once:

1. query_agent_analytics_sessions with: {"customerOrgIds": ${JSON.stringify(orgIds)}, "groupBy": ["user_id"], "limit": 200, "startDate": "${startDate}"}
2. query_agent_analytics_sessions with: {"customerOrgIds": ${JSON.stringify(orgIds)}, "groupBy": ["agent_name"], "startDate": "${startDate}"}
3. query_agent_analytics_sessions with: {"customerOrgIds": ${JSON.stringify(orgIds)}, "groupBy": ["primary_topic"], "startDate": "${startDate}"}
4. query_agent_analytics_sessions with: {"customerOrgIds": ${JSON.stringify(orgIds)}, "hasTaskFailure": true, "limit": 8, "responseFormat": "detailed", "startDate": "${startDate}"}

After ALL four tools return results, output ONLY this JSON structure (no other text):
{
  "users": <full result from query 1>,
  "agents": <full result from query 2>,
  "topics": <full result from query 3>,
  "failures": <full result from query 4>
}`;

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
      mcp_servers: [{ type: "url", url: MCP_URL, name: "amplitude" }],
    }),
  });

  if (!res.ok) throw new Error(`Amplitude fetch failed: ${res.status}`);
  const data = await res.json();

  // Extract from text block
  for (const block of data.content || []) {
    if (block.type === "text") {
      try {
        const clean = block.text.replace(/```json\n?|```\n?/g, "").trim();
        const start = clean.indexOf("{");
        if (start !== -1) {
          return JSON.parse(clean.slice(start));
        }
      } catch {}
    }
  }

  // Fallback: extract individual tool results
  const toolResults = (data.content || []).filter(b => b.type === "mcp_tool_result");
  const parsed = toolResults.map(t => {
    try { return JSON.parse(t.content?.[0]?.text || "{}"); } catch { return {}; }
  });

  return {
    users:    parsed[0] || {},
    agents:   parsed[1] || {},
    topics:   parsed[2] || {},
    failures: parsed[3] || {},
  };
}

async function generateAnalysis(customerName, customerId, days, users, agents, topics, fails, apiKey) {
  const prompt = `You are an Amplitude CSM analyst for AB180 (Korean Amplitude partner).
Customer: "${customerName}" (org ${customerId}), last ${days} days.

Users (top 8): ${JSON.stringify(users.slice(0,8))}
Agents: ${JSON.stringify(agents)}
Topics (top 8): ${JSON.stringify(topics.slice(0,8))}
Failed sessions: ${JSON.stringify(fails.slice(0,3))}

Return ONLY valid JSON (no markdown):
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

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Analysis failed: ${res.status}`);
  const data = await res.json();
  const text = data.content?.find(b => b.type === "text")?.text || "{}";
  try {
    return JSON.parse(text.replace(/```json\n?|```\n?/g, "").trim());
  } catch {
    return { summary: "분석 실패", failureCases: [], actionItems: [] };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  try {
    const { orgId, orgName, days } = req.body;
    if (!orgId) return res.status(400).json({ error: "orgId required" });

    const startDate = new Date(Date.now() - (days || 30) * 864e5).toISOString().split("T")[0];

    // Step 1: Fetch all Amplitude data in ONE Claude call (parallel tools)
    const ampData = await fetchAllAmplitudeData([String(orgId)], startDate, apiKey);

    const users  = ampData.users?.data?.aggregations  || ampData.users?.aggregations  || [];
    const agents = ampData.agents?.data?.aggregations || ampData.agents?.aggregations || [];
    const topics = ampData.topics?.data?.aggregations || ampData.topics?.aggregations || [];
    const fails  = ampData.failures?.data?.sessions   || ampData.failures?.sessions   || [];
    const total  = ampData.users?.data?.total_count   || users.reduce((s,u) => s + u.session_count, 0);

    // Step 2: AI analysis (parallel with nothing — already sequential)
    const analysis = await generateAnalysis(orgName, orgId, days || 30, users, agents, topics, fails, apiKey);

    return res.status(200).json({
      ok: true,
      data: { users, agents, topics, fails, total, analysis }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
