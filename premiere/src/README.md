# Remotion Source

| 경로 | 역할 |
| --- | --- |
| `index.ts` | Remotion 진입점 |
| `Root.tsx` | 영상별 composition 등록 |
| `lib/overlay/` | review·alpha 공용 primitive |
| `templates/` | 여러 영상에서 검증된 공용 template |
| `productions/<video-slug>/` | 영상별 source |

`npm run production:new -- <slug>`가 영상별 source와 registry entry를 만든다. 반복 사용이 검증된 primitive는 `templates/`로 승격한다.
