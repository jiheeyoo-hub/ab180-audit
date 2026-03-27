# AB180 Agent Audit Dashboard

AB180 고객사의 Amplitude Agent Analytics 현황을 조회하는 내부 대시보드입니다.

## 구조

```
ab180-audit/
├── api/
│   └── query.js          # Vercel Serverless Function (Anthropic API 프록시)
├── public/
│   └── index.html        # 프론트엔드 대시보드
├── vercel.json           # Vercel 라우팅 설정
├── package.json
└── .env.example          # 환경변수 예시
```

## 배포 방법 (Vercel, 약 5분)

### 1. GitHub에 올리기

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/ab180-audit.git
git push -u origin main
```

### 2. Vercel 배포

1. https://vercel.com 에서 로그인 (GitHub 계정으로)
2. **Add New Project** → GitHub 저장소 선택
3. **Environment Variables** 탭에서 추가:
   - Key: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-...` (Anthropic API 키)
4. **Deploy** 클릭

### 3. 완료

`https://ab180-audit.vercel.app` (또는 설정한 도메인)으로 접근 가능

---

## 로컬 테스트 방법

```bash
# Vercel CLI 설치
npm i -g vercel

# 환경변수 설정
cp .env.example .env.local
# .env.local 에 ANTHROPIC_API_KEY 입력

# 로컬 실행
vercel dev
# → http://localhost:3000
```

---

## 환경변수

| 변수명 | 설명 |
|--------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 키 (필수) |

---

## 고객사 목록 수정

`public/index.html` 파일 내 `CUSTOMERS` 배열에 추가/수정:

```js
{id: "12345", name: "새 고객사"},
```

---

## 주의사항

- Amplitude MCP 서버 URL이 `orgId=36958`로 고정되어 있습니다. AB180 org ID에 맞게 수정 필요 시 `api/query.js` 내 `MCP_URL` 변경
- API 응답 시간: 고객사당 약 20~40초 (Amplitude MCP 조회 4회 + AI 분석 1회)
