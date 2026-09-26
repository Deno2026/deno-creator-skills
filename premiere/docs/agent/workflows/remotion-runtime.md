# Remotion 런타임과 폰트

이 키트의 기본 모션 제작·렌더 경로다. 연출은 [모션 제작](motion-production.md)에서 정하고, 이 문서는 확정된 연출의 source·렌더 경로와 폰트 runtime을 담당한다.

## 장면 종류와 출력 계약

전체 화면을 덮는다는 연출 선택과 파일의 alpha 유무는 별개다. 아래 경로는 파일의 실제 합성 방식으로 정한다.

| 경로 | 쓰는 상황 | 검수와 배치 |
| --- | --- | --- |
| 원래 화면 유지 | 클릭·값 입력 안내, 이미 충분한 사용자 편집 | 새 모션 파일을 만들지 않는다. 확정 컷·오디오를 보존한다. |
| 알파 합성 | 배경을 희미하게 남기는 과정 도식, 투명 요소·패널 | review → 같은 generation의 무음 ProRes 4444 → overlay manifest 경로. 장면 중간의 전체 점유도 가능하며 입출구 alpha 계약은 유지한다. |
| 전체 합성 | 배경·결과 영상·마스크를 포함하는 연속 장면 | 같은 시각의 실제 음성과 합쳐 내부 검수하고, 최종 시각 파일에는 원래 음성을 중복 삽입하지 않는다. 해상도·FPS·길이·입출구·미디어 재생을 검사한다. |

**해상도는 대상 시퀀스를 따른다.** 4K 시퀀스면 3840×2160(1920×1080으로 짠 구성은 Remotion `scale: 2`)이며, 1920×1080 파일을 200% 확대해 넣으면 흐려진다. 시각 파일에 작업 UI를 포함할 때는 확정 컷의 정확한 구간을 쓰고 복귀 프레임과 원래 타임라인의 화면 시각을 맞춘다. 반투명 덮개의 밝기·배경 글자 중복은 최종 Premiere 합성 프레임에서도 확인한다.

## Source와 렌더

1. 지속 production은 `npm run production:new -- <slug>`로 만들고 `src/productions/<slug>/index.tsx`와 `productions/<slug>/plans/overlay-plan.json`을 채운다. 등록부는 `src/productions/registry.tsx`(표식 자리에 자동 등록).
2. review는 실제 타임라인 배경·오디오와 함께 렌더한다.

   ```powershell
   npm run production:render-overlays -- --production <slug> --mode review --generation <label>
   ```

3. 알파 경로는 연출이 맞는 generation을 같은 source와 plan으로 alpha 렌더한다.

   ```powershell
   npm run production:render-overlays -- --production <slug> --mode alpha --generation <label>
   ```

4. review의 duration·H.264 재생과 alpha의 ProRes 4444·alpha pixel format·audio stream 0·투명 입출구를 확인한다.
5. 타임라인 배치는 현재 sequence를 `premiere:capture-placement-inputs`로 읽고 `production:build-overlay-placement`가 만든 manifest를 `premiere:place-overlays`에 전달한다. 같은 이름의 이전 generation이 project bin에 남아 있어도 파일명과 정규화한 전체 media 경로가 모두 일치하는 항목만 선택한다.

### 알파 ProRes 렌더 옵션(정본 — `remotion.config.ts`)

| 항목 | 값 | 비고 |
| --- | --- | --- |
| `codec` | `'prores'` | |
| `proResProfile` | `'4444'` | **대소문자 주의**: `proresProfile`로 쓰면 무시되어 알파가 사라진다 |
| `pixelFormat` | `'yuva444p10le'` | 결과 파일을 ffprobe하면 `yuva444p12le`로 표시된다 — 둘 다 정상 |
| `imageFormat` | `'png'` | 알파 보존 |
| `muted` | `true` | 오버레이는 무음. 배치 검사기가 오디오 스트림을 거부한다 |
| `concurrency` | 2~3 | `--gl=angle` 권장. GPU가 다른 작업으로 차 있으면 올리지 않는다(ProRes 인코딩은 CPU 병목) |

- 프리뷰 합성(`--preview`)은 알파 렌더를 실제 화면 녹화·음성 위에 ffmpeg `overlay`로 얹되 입력을 `format=rgba`로 맞춘다(아니면 알파가 무시된다).
- 컷 편집된 타임라인의 배경을 V1 조각으로 다시 만들 때 조각마다 `-shortest`로 자르면 이음새마다 프레임이 빠져 뒤로 갈수록 싱크가 밀린다. 조각은 `-frames:v`로 프레임 수를 고정하고, 음성은 시퀀스 오디오 클립(위치·원본 구간·클립 볼륨)으로 섞는다.
- 공용 코드의 변경 추적: `buildProductionSourceBundle`은 entry·registry·`src/lib` 전체·영상별 source를 추적한다. 외부 미디어·로컬 폰트는 해당 source 폴더의 `render-dependencies.json`에 `{ "files": ["assets/..."] }`로 선언한다. 검수→alpha 사이와 렌더 시작→완료 사이 변경을 거부한다.
- `production.tsx.template`의 기본 카드에는 시스템 폰트가 남아 있다. `scaffoldOnly`는 실제 렌더를 막는 장치이므로, 플래그만 풀지 말고 발화별 장면과 검증된 서체를 쓰는 production source로 교체한 뒤 렌더한다.

## 폰트

- Adobe Fonts를 쓸 때는 Creative Cloud/CoreSync를 실행하고 실제 font family와 `measureText` 폭을 확인한다.
- 지정 face가 없으면 [서체](motion-typography.md)에 따라 확보하거나 역할에 맞는 실제 face를 다시 고른다. 조용한 fallback·가짜 볼드는 허용하지 않으며 렌더에서 실제 로딩을 확인한다.
- 리포 공용 폰트는 라이선스가 명확한 배포 가능 파일만 `assets/fonts/`에 둔다(추적하지 않음).

## Windows 런타임

- version은 `package.json`·lockfile·설치 runtime에서 읽는다. 업그레이드는 로그에 찍힌 package 명령을 PowerShell에서 직접 실행하고 → `package.json`·lockfile 일치 확인 → 알파 ProRes 1블록·H.264 review 1회 재렌더로 회귀 검증.
- `EBUSY`는 해당 파일을 소유한 render process의 PID를 확인하고 그 process가 끝난 뒤 재시도한다.

## 경로

- 입력 `assets/<slug>/`, source `src/productions/<slug>/`, plan·manifest `productions/<slug>/`, 결과 `renders/<slug>/`, 재생성 가능한 작업 파일 `tmp/`.
- duration이 달라진 media는 새 파일명으로 렌더해 Premiere가 정확한 길이를 다시 읽게 한다.
- 내용 교체 검수에서 `renderStill`을 직접 호출할 때는 선택한 composition의 `props`와 `inputProps`를 같은 값으로 맞추고, 출력 프레임에서 실제 새 문구를 확인한다.
