# Caption core

사용자 승인 전후의 한국어 SRT를 구조적으로 검증하고 문맥 단위로 다듬는 source-only 모듈이다. 음성 타이밍 생성·forced alignment는 이 패키지의 책임이 아니며, 실제 오디오 기준 싱크는 Premiere caption workflow가 소유한다.

운영은 [문서 라우터](../../docs/agent/README.md)에서 시작하고 [자막 제작](../../docs/agent/workflows/caption-production.md)을 따른다. 게시 입력 전환은 [게시 인계](../../docs/agent/workflows/publishing-handoff.md), READY 이후 자막 업로드·현지화는 [YouTube 실행](../../docs/agent/workflows/youtube-upload-execution.md)으로 이어간다.

## 정본 파일

- `tools/srt_tool.py`: SRT 검증, 문맥 병합, Premiere 포맷, clean KO, caption source lock
- `tools/correction_feedback_digest.py`: 현재 교정 규칙·용어집 preflight
- `references/CORRECTION_PATTERNS.md`: 반복 교정 규칙
- `references/GLOSSARY.md`: 기술 용어 정본
- `tests/test_srt_tool.py`: 구조·포맷·production path 회귀 테스트

## production 계약

한 영상의 자막 파일은 `productions/<slug>/captions/` 안에서만 관리한다.

- `final-ko.srt`: 사용자가 확정한 한국어 자막
- `clean-ko.srt`: 태그만 제거한 YouTube용 한국어 자막
- `reviewed-en.srt`: final KO와 같은 cue 구조의 검수된 영어 자막
- `english-review.md`: 영어 품질 PASS 근거
- `caption-source-lock.json`: 위 파일들의 SHA-256·timeline·cue 구조 잠금

마스터 제작 단계는 `delivery/master-manifest.json`이 exact 영상과 `final-ko.srt`를 하나의 revision으로 묶는다. Helper 완료 이후에는 사용자가 확정한 READY의 영상·최종 KO를 현재 게시 source로 사용한다. 입력 전환은 `docs/agent/workflows/publishing-handoff.md`가 소유한다.

## 검증

```powershell
python .\packages\caption-core\tests\test_srt_tool.py
```

대표 명령:

```powershell
python .\packages\caption-core\tools\srt_tool.py validate <srt>
python .\packages\caption-core\tools\srt_tool.py semantic-lint <srt>
python .\packages\caption-core\tools\srt_tool.py compare-grouped <cue-locked.srt> <grouped.srt>
```
