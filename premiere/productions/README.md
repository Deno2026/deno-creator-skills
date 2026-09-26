# 작업 폴더(productions)

세션을 넘기는 A–Z·모션·게시 작업은 영상별 현재 상태와 확정 artifact 포인터를 한 폴더에 둔다. 이 폴더의 내용은 개인 작업물이라 추적하지 않는다(README만 남는다).

```text
productions/<video-slug>/
  STYLE_BRIEF.md      # 영상 목적과 시각 방향(연출 결정은 docs/agent/workflows/channel-motion-profile.md로 승격)
  ROUTE_SHEET.md      # 블록별 연출 메모 6칸 표(양식: motion-production §2)
  STATE.json          # 단계별 status·revision·manifest
  STATE.md            # 마지막 live 확인과 다음 한 작업
  identity/ edit/ audio/ motion/ captions/ thumbnail/ delivery/ publishing/ plans/ placement/ reports/
```

## 생성

```powershell
npm run production:new -- <video-slug>
```

production 폴더, `src/productions/<slug>/`, `assets/<slug>/`, `renders/<slug>/`와 Remotion registry 항목을 만든다. slug는 소문자 영문·숫자·하이픈이다. 창작 상류(대본·클립 생성)가 따로 있으면 `STYLE_BRIEF.md` 첫 절에 원본 작품 경로와 가져올 자산 목록을 적고, 필요한 파일만 `assets/<slug>/`로 복사한다(원본은 옮기거나 지우지 않는다).

## 운영

- `STATE.md`에는 마지막 live 상태와 다음 한 작업을, `STATE.json`에는 현재 status·revision·manifest pointer를 기록한다.
- `delivery/master-manifest.json`은 exact master와 final KO revision을 묶는다. `publishing/`은 헬퍼 READY와 YouTube read-back을 보관한다.
- 모션 review는 실제 배경·오디오로 렌더하고, 같은 source generation의 alpha를 Premiere에 배치한다.
