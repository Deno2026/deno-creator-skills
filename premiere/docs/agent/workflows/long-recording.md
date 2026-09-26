# 긴 원본(Premiere 밖 통파일)

Premiere 밖의 긴 원본이나 현재 시퀀스에서 안정적으로 재생되지 않는 통파일은 외부 파생 clip으로 준비해 현재 sequence에 배치한다. 정상 재생되는 활성 V/A 통파일은 [오디오](audio-finishing.md)의 direct Razor 경로를 쓴다. 판정: `ffprobe`로 가변 프레임레이트(VFR)·코덱·길이를 확인해, VFR이거나 Premiere에서 스크럽·재생이 끊기거나 사용자가 "프리미어 밖 원본"이라고 지목한 경우에만 이 문서를 쓴다.

## 입력 확인

source path, duration, container, fps/time base와 모든 audio stream의 codec·channels·sample rate를 읽는다. 실제 사용할 audio stream은 `volumedetect`와 decoded PCM hash로 확인해 분석과 렌더에 동일하게 지정한다.

```powershell
ffprobe -v error -show_entries stream=index,codec_type,codec_name,channels,sample_rate:stream_tags=title -of json "<SOURCE>"
ffmpeg -hide_banner -nostdin -i "<SOURCE>" -map 0:<STREAM_INDEX> -vn -af volumedetect -f null NUL
```

## 파생 clip 제작

1. **무음 탐지 + 파생 clip 렌더 + 배치 manifest**(한 번에):

   ```powershell
   npm run premiere:render-active-clips -- --input "<SOURCE>" --out-dir "tmp/<slug>-active" --report "tmp/<slug>-active/report.json" --encoder h264_nvenc
   # 선택: --audio-stream 1  --threshold -48dB  --min-silence 0.8  --lead 0.4  --tail 0.4  --min-keep 0.3  --merge-gap 0.08  --start <s> --end <s>
   ```

   - 기본은 파일 전체. 15분 단위로 나눠 돌리려면 `--start/--end`를 주고 `--out-dir`를 구간별로 나눈다. NVENC가 없거나 실패하면 `--encoder libx264`.
   - 출력: `active_####_<start>-<end>.mp4`(CFR, zero-based, 단일 오디오 AAC, faststart) + `report.json` — `clips[]`가 그대로 배치 manifest다.
2. **검증**: 각 clip을 `ffprobe`로 읽어 영상 1·오디오 1 stream, CFR, `start_time` ≥ 0, duration이 report와 ±1프레임 안인지, clip 수·순서·경로가 report와 같은지 확인한다.
3. **타임라인 배치**:

   ```powershell
   npm run premiere:import-active-clips -- --manifest "tmp/<slug>-active/report.json" --track-index <V index> --audio-track-index <A index>
   # 선택: --start-seconds <n>(기본 현재 시퀀스 끝)  --target-bin <bin>  --batch-size 8
   ```

### 재개 규칙

- 1단계가 중간에 죽으면 같은 명령을 다시 실행한다(기존 mp4를 다시 렌더하므로 큰 파일은 `--start/--end`로 남은 구간만).
- 3단계가 timeout·오류로 멈추면 현재 타임라인을 읽어 마지막으로 놓인 clip 이름을 확인하고 `--start-index <다음 index>`로 이어간다. 미디어가 이미 import돼 있으면 `--no-import`.
- 파생 clip은 원본 해상도·fps를 유지한다(마스터 업스케일은 게시 단계의 일).

## 완료 조건

- 원본 source가 그대로 존재한다.
- 모든 파생 clip이 계획된 ID·duration·CFR·audio stream으로 decode된다.
- 배치한 V/A interval이 연결되고 gap과 unmatched interval이 0이다.
- 결과가 열린 Premiere 타임라인에서 바로 재생된다.

프로젝트 저장, 원본·파생 파일 삭제, project item 정리는 사용자가 요청했을 때만.
