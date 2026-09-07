# Deno Director 키트

에이전트를 유능한 스태프로 만드는 프로젝트 체계입니다. 이 폴더를 작업 폴더로 복사하면 어떤
에이전트든(Claude Code, Codex, Gemini CLI, Cursor, Windsurf, Copilot) 같은 정본을 읽고 같은
순서로 일합니다.

## 무엇이 들어 있나

| 파일 | 역할 |
|---|---|
| `AGENTS.md` | 유일한 정본. 권위 순서, 시작 절차, 취향이 규칙이 되는 길, 장부, 승인·비밀, 커밋, 갱신 |
| `CLAUDE.md` `GEMINI.md` `.cursor/rules/` `.github/copilot-instructions.md` `.windsurf/rules/` | 각 에이전트가 자동으로 읽는 진입 파일. 전부 `AGENTS.md`를 가리키기만 합니다 |
| `docs/routes.json` | 작업 유형 표. 유형마다 읽을 문서와 순서가 고정돼 있습니다 |
| `docs/session.md` | 세션 시작·중간 보고·마무리·키트 갱신 절차 |
| `craft/gate.md` | 생성 직전 확인 10항목. 생성 작업의 첫 문서 |
| `craft/doctrine.md` | 모델과 무관한 연출 원칙 |
| `craft/taste.md` | 감독의 취향 장부. 에이전트가 대화에서 들은 것을 여기에 적습니다 |
| `craft/guides/` | 모델별 입력법. 생성 전 필독 |
| `projects/_template/` | 작품 폴더 틀 (BRIEF · STATE · DECISIONS · scenes · assets · renders · review) |
| `projects/2026-09-07_첫-작품-예제/` | 채워진 예제 작품. 첫 대화에서 그대로 따라 할 수 있습니다 |
| `tools/route.py` | 작업 유형 → 읽기 목록. 없어도 `routes.json`을 손으로 읽으면 같습니다 |
| `.denomcp/kit.json` | 키트 버전과 갱신 규칙 |

## 설치

1. 이 폴더의 내용을 작업 폴더에 복사합니다.
2. 에이전트를 그 폴더에서 엽니다. 진입 파일은 에이전트가 알아서 읽습니다.
3. "새 작품 시작"이라고 말하면 에이전트가 작업 유형 표대로 진행합니다. 예제 작품을 보려면
   "첫 작품 예제를 이어받아"라고 말합니다.

## 갱신

"키트 갱신"이라고 말하면 에이전트가 `docs/session.md`의 절차대로 정본·교리·가이드·도구만
바꾸고, 취향 장부·작품·결정 기록은 그대로 둡니다.

## 직접 확인

```bash
python tools/route.py --check
```

작업 유형 표와 문서가 맞는지 검사합니다. 어떤 유형이 어떤 문서를 읽는지는 `--list`와
`--task <유형>`으로 볼 수 있습니다.

## 라이선스

노하우와 워크플로우는 출처 표기 조건으로 자유롭게 사용할 수 있습니다(`Deno MCP (denomcp.com)`).
