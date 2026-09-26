# DENO Premiere UXP

Premiere Pro 26.3에서 `plugin-data:/bridge`의 JSON 명령을 처리하는 설치형 UXP bridge다. `localFileSystem: "plugin"` 권한과 plugin-level lifecycle을 사용한다.

## 설치

1. Premiere Pro와 UXP Developer Tool을 닫는다.
2. package와 내용을 검증한다.

   ```powershell
   npm run premiere:uxp:package
   npm run premiere:uxp:verify-package
   ```

3. package를 설치한다.

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/install-premiere-uxp-package.ps1 -Install
   ```

4. Premiere를 실행하고 기능 wrapper의 첫 read로 bridge 응답을 확인한다.

Premiere가 시작되면 plugin-level lifecycle이 bridge polling을 자동으로 시작한다.

## 개발

소스 디버깅은 Adobe UXP Developer Tool에서 이 폴더의 `manifest.json`을 추가해 `Load` 또는 `Reload`한다. 실제 왕복 대상은 `npm run premiere:lifecycle:doctor`가 반환하는 active bridge directory를 사용한다.

새 명령은 schema catalog의 category와 같은 `handlers/<category>.js`에 구현하고 다음 항목을 함께 연결한다.

- Premiere 26.3 stable API
- public schema
- write policy
- Adobe lint
- offline behavior test
- capability registry entry

설치형 package에는 `enabled-tools.json`에 등록된 handler만 포함한다.
