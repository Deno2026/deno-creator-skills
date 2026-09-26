---
slug: comfyui-desktop-agent-launch
title: ComfyUI 데스크탑(Comfy Desktop) — 에이전트가 화면 클릭 없이 서버를 켜고 주소를 얻는 법
kind: technique
tags: comfyui, comfy desktop, 데스크탑, 데스크톱, 실행, 켜기, 시작, auto-launch, autoLaunchOnStartup, 포트, port, 설정, settings.json, installations.json, app.log, 에이전트, 처음, 설치
models: ComfyUI, Comfy Desktop
execution: local
version: 7
summary: ComfyUI 데스크탑 앱(Comfy Desktop)은 앱 껍데기가 서버 실행을 쥐고 있어 에이전트가 첫 단계에서 막힌다. 밖에서 서버를 켜는 실행 옵션·링크·헤드리스·제어 API가 없고, 유일한 공식 길은 설정 「Auto-launch on startup」에 로컬 설치본을 지정해 두는 것이다. 사람이 설치 때 설정 한 번, 에이전트는 「떠 있나 → 목록 화면이면 정상 종료 → 꺼져 있으면 실행 → 로그·포트로 준비 확인 → 주소」 절차 한 번. 포트는 짐작하지 않고 앱 로그에서 읽는다.
---

# ComfyUI 데스크탑(Comfy Desktop) — 에이전트가 켜는 법

이 꾸러미는 **사람이 한 번 할 설정과 에이전트의 준비 절차**를 준다. 데스크탑을 쓸지 포터블을 쓸지는 사용자가 정한다.
디노의 현재 상태와 전환 계획은 맨 아래 「디노는 이렇게 한다」.

## 무엇을 얻나

- ComfyUI 데스크탑 앱이 깔린 PC에서, 에이전트가 **화면을 클릭하지 않고** ComfyUI 서버를 켜고 그 주소를 알아내, 꾸러미 `comfyui-agent-basics`의 절차(접수·확인·회수·검수)로 이어 간다.
- 결과는 둘 중 하나로 끝난다: 「준비됨 + 주소(예 `http://127.0.0.1:8000`)」 또는 「실패 + 이유 + 사람이 할 일」.

## 목적

- 포터블·수동 설치는 에이전트가 파이썬으로 서버를 바로 띄우면 끝이지만, 데스크탑은 **앱 껍데기가 서버 실행을 쥐고 있어** 에이전트가 첫 단계에서 헤맨다. 그 헤매는 여지를 없앤다 — 매번 앱 구조를 새로 알아내지 않고, 정해진 절차 하나로 끝낸다.
- 사용자의 앱 설정·설치본은 건드리지 않는다. 바꿔야 하는 설정은 사람에게 한 번 부탁하거나, 사람이 허락한 값만 앱이 꺼진 상태에서 넣는다.

## 사실 — 앱이 밖에서 켜지는 길은 하나뿐이다

2026-09-19 조사(앱 1.0.47 코드 직접 확인 + 공식 저장소 `Comfy-Org/Comfy-Desktop` v1.0.47·v1.1.0 + docs.comfy.org). 공식 문서 문장은 2026-09-26 다시 읽었다.

- **밖에서 서버를 켜는 통로가 없다.** 실행 옵션(앱은 `process.argv`를 읽지 않는다), OS 링크(`comfy://` 핸들러 PR #1073 미병합), 헤드리스·서버 전용 모드, 원격 제어 창구 모두 없다. 공식 FAQ: 「Comfy Desktop은 headless, server-only, remote 모드를 지원하지 않는다 — 서버 용도는 수동 설치나 Windows 포터블을 쓰라」.
- **이미 켜져 있는 앱을 다시 실행하면 창만 앞으로 온다**(second-instance). 목록 화면(대시보드)에 멈춘 앱에 「서버 켜」라고 시킬 방법은 없다 — 정상 종료하고 다시 켜야 한다.
- **유일한 공식 길 = 설정 「Auto-launch on startup」.** 공식 설정 문서: 「앱이 열릴 때 시작할 설치본을 고른다. 기본은 None(목록 화면), Last used instance 또는 특정 설치본」. 파일로는 `%APPDATA%\Comfy Desktop\settings.json`의 `autoLaunchOnStartup`(`none` | `last` | 설치본 id). 앱이 **시작될 때 한 번만** 적용되고, 첫 설정을 마친 상태(`firstUseCompleted: true`)여야 한다. 앱은 설정을 접근 때마다 디스크에서 다시 읽으므로 **앱을 끈 상태에서 파일을 고쳐도 된다**(실측 2026-09-19: 값 지정 → 실행 → 15초 만에 서버 응답).
- **트레이가 없다.** 마지막 창을 닫으면 앱이 꺼지고, ComfyUI 창을 닫으면 그 서버도 꺼진다(`onAppClose: quit`). 로그인 시 자동 시작 기능도 없다.
- **포트는 설치본마다 다르다.** 설치본의 시작 인자에 `--port`가 없으면 8188, 옛 데스크탑에서 이관된 설치본은 `--port 8000`. 포트가 막혀 있으면 정책 「Use next available port」(포터블·standalone 기본)은 다음 포트로 비켜 가고, `--port`를 직접 준 설치본은 **확인 창을 띄운다**(공식 문서 「asks if —port is set」) — 그 창에서 에이전트가 또 막힌다.
- **실행 모드**(`installations.json`의 `launchMode`): 「App window」(앱 창 안) 또는 「Console only」(앱 창 없이 콘솔 프로세스로 — 공식 문서에 있으나 실측 전).
- **comfy-cli·comfy-mcp는 데스크탑을 켜거나 찾지 못한다**(comfy-mcp #258 「데스크탑과 어떻게 쓰나」 무응답, 포트 기록을 읽자는 PR #278 미검토). 서버가 떠 있으면 `COMFY_LOCAL_URL=http://127.0.0.1:<포트>`로 comfy-mcp를 붙일 수 있고, `comfy stop --port <p>`로 끌 수는 있다.
- **앱 데이터 위치(Windows, 공식 문서):** 앱 데이터 `%APPDATA%\Comfy Desktop`(settings.json · installations.json · last-session.json · logs\app.log — 이전 세션은 `app.log_*.log`로 회전), 새 설치본 `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs`, 공유 모델 `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared`(옛 설치는 `~\ComfyUI-Installs`·`~\Documents\ComfyUI`). 실행 파일 `%LOCALAPPDATA%\Programs\ComfyUI\Comfy Desktop\Comfy Desktop.exe`(레지스트리 Uninstall 항목 `Comfy Desktop <버전>`, 시작 메뉴 `Comfy Desktop.lnk`). 로그 폴더는 앱 메뉴 Settings → Logs → Diagnostics → Open logs folder.
- **서버 기동 명령이 로그에 그대로 남는다.** `app.log`에 `App started v…` 다음 `> …\python.exe -s ComfyUI\main.py --feature-flag … --base-directory … --user-directory … --port N --extra-model-paths-config …` 줄이 찍힌다. **포트는 이 줄에서 읽는다.** 소스에는 `port-locks\port-<N>.json`(pid·설치본 이름·시각) 기록도 있으나, 디노 PC의 1.0.47은 실제 실행 뒤에도 그 폴더가 비어 있었다(미확인 — 기대지 않는다).

## 진행 순서와 갈림길

**기본 흐름(디노 확정 2026-09-26) — 사람은 켜 두고, 에이전트는 작업만.**

```text
사람   : ① 설치 때 한 번 — Auto-launch에 로컬 설치본 지정(아래 0-1 안내문)
         ② 작업할 때 — 앱을 켜서 ComfyUI 화면이 뜬 채로 뒤에 둔다(창을 닫으면 서버도 꺼진다)
에이전트: ③ 서버를 찾는다(포트는 짐작하지 않고 읽는다) → ④ comfyui-agent-basics 절차로 접수·확인·회수·검수
         앱을 켜거나 끄는 것은 사람 몫. 서버가 없으면 ⑤ 사람에게 「앱을 켜 주세요」 한 줄(설정이 안 돼 있으면 0-1 안내문)
```

- 이렇게 나누면 에이전트가 앱 껍데기와 씨름할 일이 없다 — 켜져 있는 서버에 API로 붙어 코덱스·클로드가 알아서 한다. 아래 1)의 「꺼져 있으면 실행」은 사용자가 원격 기동을 맡겼을 때의 갈래다.

### 0) 사람이 설치할 때 한 번 — 사용자에게 안내한다

1. 데스크탑을 설치하고 **첫 설정을 끝까지 마친다**(안 마치면 자동 실행 설정이 무시된다).
2. **로컬 설치본**을 만든다(Standalone, 또는 기존 git clone·포터블을 「Add Existing Instance」로 등록).
3. 설정 → Preferences → **Auto-launch on startup**에서 **그 설치본을 직접 고른다.** 「Last used instance」는 마지막에 클라우드 항목을 썼으면 클라우드가 떠 로컬 서버가 안 생기니 피한다.
4. (권장) 설치본 Manage → Startup Args에서 「If Port is Busy」를 **Use next available port**로. 같은 PC에 포터블(8188)을 같이 쓰면 포트가 겹치므로 앱이 비켜 가게 둔다. `--port`를 직접 넣으면 막혔을 때 확인 창이 뜬다.
5. (선택) Launch Mode를 Console only로 두면 앱 창 없이 서버만 도는 방식이 된다(실측 전 — 기본은 App window 그대로).
6. 앱을 닫으면 서버도 꺼진다는 것을 안다. 에이전트가 작업하는 동안 앱 창을 닫지 않는다.

### 0-1) 에이전트가 사용자에게 그대로 보여 주는 안내문 — 복사해서 전한다

아래 글을 **그대로** 사용자에게 보여 준다(설명을 덧붙이지 말고, 사용자 PC 상황에 맞춰 이미 끝난 단계만 「건너뛰셔도 됩니다」로 표시한다). 화면 문구는 앱에 영어·중국어만 있어 영어 이름을 그대로 적고 괄호에 뜻을 달았다(공식 문서·앱 문구 기준 2026-09-26, 앱 1.0.47/1.1.0 화면).

```text
ComfyUI 데스크탑을 제가 대신 켤 수 있게 하는 설정입니다. 한 번만 해 두시면 됩니다(5분쯤).

왜 필요한가요 — 이 앱은 켤 때 「어느 설치본을 시작할지 고르는 화면」에서 멈추는데, 그 버튼을 제가 대신 누를 방법이 없습니다.
아래처럼 「앱이 열리면 이 설치본을 바로 시작」으로 정해 두면, 그다음부터는 제가 앱을 켜고 작업까지 이어갑니다.

1. 앱 설치 (이미 깔려 있으면 건너뛰세요)
   - comfy.org 에서 Windows용 Comfy Desktop 설치 파일(.exe)을 받아 실행합니다.
   - 설치가 끝나면 시작 메뉴에서 Comfy Desktop 을 엽니다. 처음이면 Welcome 화면이 나옵니다.

2. 로컬 설치본 만들기 (이미 하나 있으면 건너뛰세요)
   - 첫 화면(Dashboard)에서 「+ New Instance」(새 설치본) → 「Standalone」(파이썬까지 들어 있는 독립 설치본)을 고르고 안내대로 진행합니다. 4.85GB 이상, 몇 분 걸립니다.
   - 이미 쓰던 포터블이나 git 설치가 있으면 「New Instance」 안의 「Add Existing Instance」(기존 설치 등록)로 등록해도 됩니다.
   - 카드가 생기면 한 번 「Launch」(실행)해서 ComfyUI 화면이 뜨는지 확인한 뒤 창을 닫습니다.

3. 자동 시작 설치본 정하기 (핵심)
   - 왼쪽 위 ☰ 메뉴 → 「Desktop Settings」(데스크탑 설정) → 「Preferences」(기본 설정) 탭.
   - 「Auto-launch on startup」(앱을 열 때 자동 실행)에서 방금 만든 설치본의 이름을 고릅니다.
   - 「None (show dashboard)」와 「Last used instance」(마지막에 쓴 것)는 고르지 마세요. 마지막에 Cloud를 썼으면 Cloud가 떠서 제가 쓸 서버가 생기지 않습니다.
   - (선택) 같은 탭의 「Hide Cloud from the Instance Picker」를 켜 두면 실수로 Cloud를 여는 일이 줄어듭니다.

4. 포트가 겹칠 때 알아서 비켜 가게 하기
   - Dashboard로 돌아와 설치본 카드의 「⋮」 → 「Manage」(관리) → 「Startup Args」(시작 인자) 탭.
   - 「If Port is Busy」(포트가 사용 중이면)를 「Use next available port」(다음 빈 포트 사용)로 둡니다.
   - 같은 화면의 **「Enable Manager」 토글을 켭니다**(커스텀 노드 매니저). 켜면 팝업 목록이 뜨는데 매니저를 옛 모습(레거시)으로 볼지 새 모습으로 볼지 고르는 것입니다 — 잘 모르면 새 모습. 이 토글이 인자 칸에 --enable-manager 를 넣어 줍니다(레거시를 고르면 --enable-manager-legacy-ui 도 함께).
   - 「Startup Arguments」 칸에 이미 적혀 있는 것은 **지우지 말고**, 그 뒤에 한 칸 띄우고 --use-ck-attention 을 덧붙입니다(ComfyUI에 들어 있는 어텐션 가속. RTX 20 세대 이상이면 됩니다). 칸을 통째로 바꾸면 매니저 인자가 지워져 매니저 메뉴가 사라집니다(디노 실측 2026-09-26). 새로 --port 를 넣지는 마세요. 넣으면 포트가 겹칠 때 확인 창이 떠서 제가 거기서 막힙니다.
   - 매니저가 안 보이면: 인자 칸에 --enable-manager 라는 글자가 정확히 있는지 봅니다. --enable-manager-legacy-ui 만 있으면 서버는 매니저를 켜지만 화면 쪽이 「매니저 꺼짐」으로 보고 버튼을 안 그립니다(2026-09-27 실측). 「Enable Manager」 토글을 켜면 해결됩니다.
   - 「Launch Mode」는 「App window」 그대로 두시면 됩니다.

5. 확인
   - 앱을 완전히 끕니다(창을 닫으면 앱이 종료됩니다). 시작 메뉴에서 다시 켭니다.
   - 고르는 화면 없이 ComfyUI 화면이 바로 뜨면 성공입니다.

6. 알아 두실 것
   - 작업 중에는 ComfyUI 창을 닫지 마세요. 창을 닫으면 서버도 같이 꺼집니다.
   - 앱이 자동 업데이트를 받은 직후에는 첫 실행이 평소보다 오래 걸릴 수 있습니다. 정상입니다.

다 되셨으면 「됐어」 한마디만 해 주세요. 그다음은 제가 합니다.
```

- 사용자가 「네가 넣어」라고 하면 3번만은 에이전트가 대신 한다: 앱이 **꺼진 상태**에서 `%APPDATA%\Comfy Desktop\settings.json`을 백업하고 `autoLaunchOnStartup`에 `installations.json`의 로컬 설치본 `id`(`sourceId`가 `cloud`가 아닌 것)를 넣는다. 4번은 앱 화면에서 하는 것이 안전하다(`installations.json`의 `portConflict`를 직접 고치는 것은 실측 전).
- 화면 경로가 안 맞으면(앱 판이 바뀜) 사용자에게 보이는 이름을 물어 맞추고, 이 안내문의 판을 올린다.

### 1) 에이전트 준비 절차 — 매번 같은 순서

```text
① 서버가 이미 떠 있나 → 있으면 주소만 돌려주고 끝
② 앱이 목록 화면에 켜져 있나 → 설치·업데이트 중이면 멈추고 사람에게 / 아니면 정상 종료 → ③
③ 꺼져 있나 → 설정 확인(firstUseCompleted·autoLaunchOnStartup = 로컬 설치본 id) → 없으면 사람에게 0)의 3번을 한 번 부탁
④ 실행 파일을 찾아 켠다 → 로그에 「App started」 → 「> … main.py … --port N」 줄 → 그 포트에 /system_stats 응답까지 기다린다(넉넉히 3분, 업데이트 직후·첫 실행은 더)
⑤ 결과: 「준비됨 + 주소 + 설치본 이름 + ComfyUI 버전」을 상태.md에 적고 comfyui-agent-basics 2)부터 / 안 되면 「실패 + 이유(로그 줄) + 사람이 할 일」
```

- **① 서버 판별**: 듣고 있는 포트(Windows `Get-NetTCPConnection -State Listen`, python.exe 소유)마다 `GET /system_stats`. 응답의 `system.argv`에 `--base-directory`·`--feature-flag`·`--extra-model-paths-config`가 있으면 데스크탑 앱이 띄운 서버다(포터블은 `--windows-standalone-build` 등 다른 인자). 후보 포트는 로그의 마지막 `> … --port N` 줄 → 8188 → 그 다음 몇 개 순으로 보되 **짐작으로 8188에 넣지 않는다.**
- **② 목록 화면 판별**: `Comfy Desktop.exe` 프로세스는 있는데 데스크탑 서버가 없다(`last-session.json`이 `{"kind": "dashboard"}`). 정상 종료는 주 창 닫기(`CloseMainWindow`) → 몇 초 대기 → 프로세스 소멸 확인. 목록 화면에서는 확인 창 없이 닫혔다(실측 2026-09-19). 로그에 업데이트·설치 진행 줄이 찍히는 중이면 끄지 않는다.
- **③ 설정 확인**은 읽기만. `settings.json`에 `autoLaunchOnStartup`이 없거나 `none`·`last`이면 **0-1)의 안내문을 그대로 보여 주고** 사용자가 「됐어」라고 할 때까지 기다린다(이미 끝난 단계는 건너뛰라고 표시). 사용자가 「네가 넣어」라고 하면 앱이 꺼진 상태에서 `settings.json`을 백업하고 `autoLaunchOnStartup`에 `installations.json`의 로컬 설치본 `id`를 넣는다(클라우드 항목 `sourceId: cloud`는 제외).
- **④ 실행**: 실행 파일 위치는 레지스트리 Uninstall 항목(`DisplayIcon`) → 시작 메뉴 바로가기 → 기본 경로 순으로 찾는다. `Start-Process`로 켠다(앱은 스스로 서버를 자식 프로세스로 띄운다). 앱 프로세스가 사라지면 즉시 실패 보고. 로그에 오류 줄이 찍히면 기다리지 않고 보고.
- **끝날 때**: 앱은 사용자의 것이라 에이전트가 끄지 않는다. 다만 「창을 닫으면 서버도 꺼진다」는 것을 사용자에게 알린다. 작업 단위가 끝나면 `POST /free`로 모델만 내린다(basics 10).

### 하지 않을 것

- **화면 클릭·키 입력**(computer use)으로 버튼 누르기 — 화면이 조금만 바뀌어도 깨지고, 사용자가 피하고 싶은 방식이다.
- 원격 디버깅 포트로 앱 내부를 조종하기 — 켜져 있는 동안 다른 프로그램도 조종할 수 있는 구멍이 된다.
- **앱을 거치지 않고 서버만 따로 띄우기** — 설치본마다 파이썬 위치·시작 인자(`--base-directory`·`--extra-model-paths-config`·환경변수)가 달라 따라 하기 어렵고, 나중에 사람이 앱을 켜면 서버가 두 벌 떠 GPU 메모리를 나눠 쓴다. 비상용으로만, 사용자가 시킬 때.
- 앱이 켜져 있는데 또 실행하기(창만 앞으로 올 뿐).

### 갈림길

- **포터블과 데스크탑을 같이 쓰는 PC**: 8188은 포터블이 쥐고 있을 수 있다. 데스크탑 서버는 비켜 간 포트에 있으니 ①에서 읽는다.
- **커스텀 노드가 데스크탑에서 안 올라온다**(예: 디노 PC에서 `ComfyUI-LTXVideo` 로드 실패, 2026-09-19 — ComfyUI 본체와 노드 버전 불일치). 워크플로가 요구하는 노드는 `/object_info`로 대조하고, 없으면 사용자에게 알린다(basics 3).
- **자동 업데이트**(`autoInstallUpdates: true`)가 켜져 있으면 업데이트 직후 첫 실행이 오래 걸린다. 업데이트가 앱 동작을 바꿀 수 있으니 실패하면 앱 버전부터 적는다.
- **메모리 함정은 같다** — 데스크탑이 깔아 주는 환경 묶음에도 Windows 드라이버의 「시스템 메모리 대체」 문제와 특정 torch 판의 디코더 버그가 그대로 있다(basics 「함정」).

## 내용 자리 — 사용자가 채우는 칸

| 칸 | 어디에 | 비고 |
|---|---|---|
| 데스크탑/포터블 중 무엇을 쓰나, 설치본 이름 | `BRIEF.md` | 0)에서 |
| 준비 절차 결과(주소·설치본·버전·시각) | `상태.md` | 판마다 |
| 사람이 한 설정(Auto-launch 대상, 포트 정책) | `BRIEF.md` | 바뀌면 갱신 |

## 실행 — 로컬(내 PC)

- 필요한 것: Comfy Desktop(공식 설치기), 첫 설정 완료, 로컬 설치본 하나, 위 0)의 설정. 에이전트가 쓸 것은 PowerShell(프로세스·포트·레지스트리 조회)과 HTTP(`/system_stats`)뿐이다.
- 준비 스크립트는 에이전트가 사용자 리포에 만든다(입력: 없음 / 출력: `{ready, url, install, version}` 또는 `{ready: false, reason, ask_user}`). 위 ①~⑤가 곧 명세다. 디노도 아직 만들지 않았다(아래).

## 디노 실측 — 2026-09-19, 디노 PC(앱 1.0.47)

| 시도 | 결과 |
|---|---|
| 앱만 실행(`Comfy Desktop.exe`) | 목록 화면에서 멈춤. 150초를 기다려도 서버 없음 |
| 앱을 정상 종료 → `settings.json`에 `autoLaunchOnStartup: <로컬 설치본 id>` → 다시 실행 | **15초 만에** 포트 8000에서 `/system_stats` 응답(ComfyUI 0.36.0), 앱 창이 서버에 붙음, 이전에 열어 둔 워크플로가 다시 열림 |
| 목록 화면 상태의 앱을 `CloseMainWindow`로 닫기 | 확인 창 없이 정상 종료 |
| 시험 뒤 설정 파일 | 백업과 바이트 단위로 같게 되돌림 |

- 2026-09-26 다시 읽은 이 PC 상태: 앱 1.0.47 그대로(자동 업데이트 켜짐, 1.1.0 미적용), 로컬 설치본 1개(옛 데스크탑에서 이관, 포트 8000, launchMode window, 포트 정책 auto) + 클라우드 항목 1개, `autoLaunchOnStartup` 없음(원상태), `port-locks` 폴더 비어 있음.

## 디노는 이렇게 한다 — 예시 (참고이지 기준이 아니다)

- 디노의 제작 정본은 아직 **포터블(Easy-Install) + 세이지 어텐션 기동 배치**를 보이는 콘솔로 켜는 방식이고, 데스크탑은 순정 기준점으로 보존해 왔다. 2026-09-26 디노 방향: **앞으로 차츰 데스크탑으로 넘어가고, 구독자 안내도 데스크탑 기준으로** 한다. 전환 때 확인할 것: 로컬 패치 둘(LTX 디코더 프레임 분할·H3 컴파일러 우회), VRAM 상한 폴더, 커스텀 노드 버전. 어텐션은 2026-09-26 Comfy Kitchen으로 통일해 세이지 휠은 더 이상 필요 없다(Startup Args에 `--use-ck-attention`).
- 디노가 만든 에이전트 런타임도 새 데스크탑을 못 켰다 — 옛 `ComfyUI.exe` 경로만 찾고, 다시 켜면 목록 화면에서 멈추고, 준비 대기가 20초뿐이었다. 공유 전에 고칠 대상이다.
- 이 주제로 안내 영상을 찍을지는 보류(디노 2026-09-19).

## 포함되지 않은 것

- 준비 스크립트 실물(미구현 — 절차대로 에이전트가 만든다). 디노가 만들면 다음 판에 첨부한다.
- 데스크탑 설치·첫 설정 화면 안내(공식 문서가 있다: docs.comfy.org Installation → Comfy Desktop).

## 바뀐 점

- v4 (2026-09-26 밤): 안내문 4번에 `--use-ck-attention` 추가(어텐션 Kitchen 통일), 전환 확인 목록에서 세이지 휠 제거.
- v7 (2026-09-27 새벽, v6 정정): 정확한 원인은 프론트엔드(1.52.7)의 판정식 — 서버 `argv`에 문자열 `--enable-manager`가 **정확히** 있어야 매니저 UI를 켜고, 그 위에 `--enable-manager-legacy-ui`가 있으면 레거시 모습, 없으면 새 모습; `--enable-manager-legacy-ui`**만** 있으면(ComfyUI 서버는 이것이 enable을 함축해 매니저를 켜지만) 프론트엔드는 「disabled」로 보고 버튼을 전혀 안 그린다. 데스크탑 Startup Args의 「Enable Manager」 토글이 그 문자열을 넣고, 팝업이 레거시 여부(`--enable-manager-legacy-ui`)를 정한다 — 디노가 토글을 켜서 해결(같은 날). v6에서 말한 「레거시 스크립트가 새 메뉴에 버튼을 안 꽂음」은 사실이지만 결정적 원인이 아니었다(그 묶음이 없어도 프론트엔드가 자기 버튼을 그린다). 포터블의 8/24 손패치 사실은 그대로.
- v6 (2026-09-27 새벽): 데스크탑에서는 `--enable-manager-legacy-ui`를 쓰지 않는다 — 정품 매니저 4.2.2의 레거시 UI 스크립트는 새 상단 메뉴에 버튼을 꽂지 않아(`app.menu.settingsGroup`에 붙이는 줄이 없음) 프론트엔드 1.52.7의 새 메뉴에서는 매니저가 안 보인다(디노 데스크탑 실측·DOM 확인). 디노 포터블에서 보이는 것은 2026-08-24에 손으로 그 줄을 넣은 패치본이라 매니저 업데이트 때 사라진다. 데스크탑 기본값 `--enable-manager`(새 UI)를 쓴다.
- v5 (2026-09-26 밤, 정정): 안내문 4번을 「있는 인자 뒤에 덧붙인다」로. 데스크탑은 매니저를 기동 때 몰래 켜지 않고 **Startup Arguments 칸에 `--enable-manager`를 적어 두는 방식**이다(앱 1.1.3 코드: 자기 설치본 기본값 `--enable-manager`, 입양 설치본은 옛 설정을 변환해 `--port 8000` + 없으면 `--enable-manager` / 있으면 `--enable-manager-legacy-ui` 유지; 사용자가 지우면 그대로 둠). v4 문장대로 칸을 `--use-ck-attention` 하나로 바꾸면 매니저 메뉴가 사라지고 포트도 자동 배정으로 바뀐다 — 디노 PC에서 그대로 일어났다.
- v3 (2026-09-26 밤): 「기본 흐름」을 맨 앞에 — 사람은 설정 한 번 + 앱 켜 두기, 에이전트는 서버 찾아 API로 작업, 켜고 끄기는 사람 몫(디노 확정). 에이전트의 「꺼져 있으면 실행」은 위임받았을 때의 갈래로.
- v2 (2026-09-26 밤): 「0-1) 에이전트가 사용자에게 그대로 보여 주는 안내문」 추가(디노 — 사람이 할 설정을 에이전트가 쉽게 단계별로 전해야 한다). 화면 이름은 앱 문구(영어·중국어만 있음)와 공식 문서로 확인. 절차 ③이 이 안내문을 쓴다.
- v1 (2026-09-26): 첫 판. 2026-09-19 조사(앱 코드·공식 저장소·문서·디노 PC 실측)를 옮기고, 2026-09-26 이 PC 상태와 공식 문서 문장을 다시 확인해 적음.
