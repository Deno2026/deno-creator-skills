# Premiere Execution Matrix

이 문서는 Premiere 작업의 실행 경로를 고르는 요약표다. 현재 wrapper, `servers/premiere-uxp-mcp/capabilities.json`, live 호출 결과가 기능 상태를 소유한다.

## 우선순위

1. 현재 작업용 production wrapper
2. official UXP registered handler
3. 이미 live로 검증된 CEP wrapper
4. 호출 오류가 있으면 해당 tool 진단과 지원 경로

`ported-caveat`와 `implemented-live-check` 도구는 필요한 write flag를 붙여 bounded 실행하고 결과를 read-back한다.

## 바로 쓰는 production 경로

| 작업 | 실행 경로 | 기본 검증 |
| --- | --- | --- |
| 통파일/파형 컷 | `premiere:apply-direct-razor-cuts` | target preflight, 20컷 checkpoint, 최종 full read |
| 오디오 Level | `premiere:apply-audio-balance` | 초기 full read, batch Level read, 최종 full read |
| caption 생성/교체 | `premiere:apply-caption-track` | exact project/sequence, active track/cue read-back |
| overlay 배치 | `premiere:place-overlays` | range/track, 무오디오, 최종 placement read-back |
| active sequence render | official UXP `export_sequence` | explicit output/preset or current export settings, output 존재/ffprobe |
| AME queue | `add_to_render_queue` / `start_batch_encode` | queue/event/output read-back |
| marker/effect/property | matching official UXP tool | current value 1회, result 1회 |

작업용 wrapper가 있으면 wrapper의 target preflight와 read-back 계약을 따른다.

## 권한

- `--allow-write`: cut/ripple, Level, marker, effect/property, overlay/caption placement, timeline item removal/overwrite를 실행한다.
- `--allow-dangerous`: save, project/source/sequence 삭제, external export/AME/file write, relink/offline, global preference를 실행한다. `--allow-write`와 함께 사용한다.
- `--allow-experimental`: `local-unverified` handler를 bounded 진단 프로젝트에서 실행한다.
- 사용자가 렌더·저장·삭제를 직접 요청하면 그 요청 범위에 맞는 내부 flag를 사용한다.

## 지원 상태 판정

다음 상태는 `unavailable`이다.

- handler/schema가 없음
- capability가 `blocked-uxp`, `deferred`, `runtime-failed`이고 다른 검증 wrapper도 없음
- 현재 bounded live 호출이 실제 오류로 실패하고 지원 경로가 없음

지원되는 하위 기능은 그대로 실행한다. Caption은 text/timing/track 반영을 지원하며, Track Style 자동 적용은 Adobe API 공백이다.

## Verified

아래 CEP 도구는 production wrapper의 검증된 지원 경로다. 이 표는 capability registry 생성기가 읽는 상태 입력이다.

| 도구 | 현재 판정 |
| --- | --- |
| `ping` / `get_premiere_state` / `get_timeline_summary` / `get_sequence_structure` | live-verified read |
| `list_available_transitions` / `get_effect_properties` | live-verified read |
| `add_marker` / `set_effect_property` / `set_clip_opacity` / `set_clip_scale` | live-verified bounded write |
| `add_transition` / `add_transition_to_clip` | live-verified bounded write |
| `import_media` / `add_to_timeline` | live-verified placement write |
| `create_caption_track` | live-verified caption fallback |
| `execute_extendscript` | live-verified wrapper dependency |
| `set_sequence_in_out_points` / `extract_selection` | live-verified selection edit |
| `capture_frame` | live-verified capture fallback |

## Bounded

| 도구 | 현재 판정 |
| --- | --- |
| `batch_add_transitions` / `apply_effect` / `add_keyframe` / `import_mogrt` | implemented; bounded current call/read-back 필요 |
| `set_clip_position` / `set_clip_rotation` / `set_clip_anchor_point` | implemented; localized live property 확인 필요 |

## Alternate

| 도구 | 현재 판정 |
| --- | --- |
| `add_text_overlay` | Remotion alpha route 사용 |

## 오류 진단

호출 오류가 있으면 `resolve_premiere_tool`, `premiere-uxp-tool-coverage.md`의 해당 행, `premiere-uxp-bridge-protocol.md` 순서로 원인과 지원 경로를 확인한다.
