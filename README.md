# AI PPT 생성기 — Netlify 배포 가이드

## 파일 구조
```
ppt-generator/
├── index.html                    ← 메인 앱 (여기에 다 들어있음)
├── netlify.toml                  ← Netlify 설정
├── package.json                  ← 패키지 정보
└── netlify/
    └── functions/
        └── generate.js           ← AI API 호출 서버 함수
```

## 필요한 API 키 3개
- OPENAI_API_KEY     : https://platform.openai.com/api-keys
- ANTHROPIC_API_KEY  : https://console.anthropic.com/settings/keys
- GOOGLE_API_KEY     : https://aistudio.google.com/app/apikey

## 배포 순서 (총 10분)

### 1단계: GitHub에 올리기
1. https://github.com 접속 → 로그인
2. 우측 상단 + 버튼 → New repository
3. Repository name: ppt-generator 입력
4. Create repository 클릭
5. "uploading an existing file" 링크 클릭
6. 폴더 전체 드래그앤드롭 업로드
7. Commit changes 클릭

### 2단계: Netlify 배포
1. https://netlify.com 접속 → 로그인 (GitHub 계정으로 가능)
2. Add new site → Import an existing project
3. GitHub 선택 → ppt-generator 저장소 선택
4. Deploy 클릭 (자동으로 빌드됨)

### 3단계: API 키 등록
1. Netlify 대시보드 → 해당 사이트 클릭
2. Site configuration → Environment variables
3. Add a variable 클릭해서 아래 3개 추가:
   - Key: OPENAI_API_KEY     / Value: sk-...
   - Key: ANTHROPIC_API_KEY  / Value: sk-ant-...
   - Key: GOOGLE_API_KEY     / Value: AIza...
4. Deploys → Trigger deploy → Deploy site

완료! 생성된 URL로 팀원들과 공유하세요.
