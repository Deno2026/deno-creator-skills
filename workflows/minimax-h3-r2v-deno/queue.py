"""ComfyUI 큐잉 스크립트 — 워크플로에 프롬프트·레퍼런스를 끼워 생성 대기줄에 넣는다.

사용 예 (E1: 고수 정면 1장 + 한 줄 프롬프트):
  python queue.py --prompt "한 줄 프롬프트" --ref "C:\\경로\\고수_정면.png"

- --ref 에 실제 파일 경로를 주면 ComfyUI 입력함에 자동 업로드한다.
  이미 입력함에 있는 파일이면 파일명만 줘도 된다.
- --ref 를 두 번 주면 레퍼런스 2장(<Picture 1>, <Picture 2>)으로 배선된다.
- 기술 설정(샘플러·스케줄러·스텝)은 디노 검증값이므로 여기서 건드리지 않는다.
"""
import argparse
import json
import mimetypes
import os
import random
import sys
import urllib.request
import uuid

# Windows 한글 콘솔(cp949)에서 도움말·안내문의 특수문자로 죽지 않도록 출력을 UTF-8로 고정한다.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WORKFLOW = os.path.join(HERE, "workflows", "video_minimax_h3_r2v.api.json")

def submit_vdn(args, prompt):
    from h3_vdn import build_graph
    if args.ratio and args.ratio.split()[0] not in ('16:9', '9:16'):
        raise ValueError('queue.py supports 16:9 or 9:16; use h3_vdn.build_graph(width=..., height=...) for another ratio')
    quality = args.quality
    if args.mp is not None:
        if args.mp >= 3:
            raise ValueError('--mp 3 이상 화질은 없다 — 1088p급은 --quality general(기본) 또는 action(액션)')
        quality = 'draft' if args.mp < 0.6 else 'standard'
    names = [upload_image(args.server, ref) if os.path.isfile(ref) else ref for ref in args.ref]
    seed = args.seed if args.seed is not None else random.randint(0, 2**48)
    wf = build_graph(prompt=prompt, images=names, quality=quality, seconds=args.duration,
                     seed=seed, prefix=args.prefix or 'H3_VDN/R2V',
                     orientation='portrait' if args.ratio and '9:16' in args.ratio else 'landscape')
    wf['7']['inputs']['ref_image_size'] = args.ref_size
    if args.ref_video:
        name = upload_image(args.server, args.ref_video) if os.path.isfile(args.ref_video) else args.ref_video
        wf['300'] = {'class_type': 'LoadVideo', 'inputs': {'file': name}}
        wf['301'] = {'class_type': 'GetVideoComponents', 'inputs': {'video': ['300', 0]}}
        wf['7']['inputs']['ref_videos.ref_video_0'] = ['301', 0]
        if args.ref_video_audio == 'on':
            wf['7']['inputs']['ref_video_audios.ref_video_audio_0'] = ['301', 1]
    if args.ref_audio:
        name = upload_image(args.server, args.ref_audio) if os.path.isfile(args.ref_audio) else args.ref_audio
        wf['310'] = {'class_type': 'LoadAudio', 'inputs': {'audio': name}}
        wf['7']['inputs']['ref_audios.ref_audio_0'] = ['310', 0]
    req = urllib.request.Request(f'{args.server}/prompt', data=json.dumps({'prompt': wf}).encode('utf-8'),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.load(resp)
    print(f"큐잉 완료  작업번호: {result['prompt_id']}  시드: {seed}")

# 워크플로 안에서 역할이 정해진 노드 번호들
NODE_PROMPT = "138"      # 프롬프트 글상자
NODE_SEED = "129"        # 시드
NODE_DURATION = "132"    # 길이(초)
NODE_RESOLUTION = "115"  # 화면비율·크기
NODE_MAIN = "136"        # 지휘 노드 (레퍼런스 연결부)
NODE_REF1 = "137"        # 레퍼런스 1장째
NODE_REF2 = "139"        # 레퍼런스 2장째
NODE_SAVE = "92"         # 저장(파일 이름 접두어)


def upload_image(server: str, path: str) -> str:
    """실제 파일을 ComfyUI 입력함에 올리고, 워크플로에서 쓸 파일명을 돌려준다."""
    filename = os.path.basename(path)
    with open(path, "rb") as f:
        data = f.read()
    boundary = uuid.uuid4().hex
    ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode("utf-8") + data + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        f"{server}/upload/image",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read())
    name = result["name"]
    sub = result.get("subfolder", "")
    return f"{sub}/{name}" if sub else name


def main() -> None:
    ap = argparse.ArgumentParser(description="ComfyUI 큐잉")
    ap.add_argument("--prompt", help="프롬프트 본문")
    ap.add_argument("--prompt-file", help="프롬프트를 담은 텍스트 파일 경로")
    ap.add_argument("--ref", action="append", default=[],
                    help="레퍼런스 이미지 (경로 또는 입력함 파일명, 최대 9번)")
    ap.add_argument("--ref-video", default=None,
                    help="레퍼런스 영상 (경로 또는 입력함 파일명, 2~15초, 소리는 --ref-video-audio로 정함)")
    ap.add_argument("--ref-video-audio", choices=["on", "off"], default="on",
                    help="레퍼런스 영상의 소리도 넣을지(기본 on). 앞 채택판 이어 쓰기는 off — 원본 소리를 통째로 넣으면 여러 인물 목소리가 섞인다. "
                         "목소리가 필요하면 그 인물 대사만 잘라 --ref-audio로 (2026-09-28 실측)")
    ap.add_argument("--ref-audio", default=None,
                    help="독립 레퍼런스 오디오 (경로 또는 입력함 파일명, 2~15초 — 목소리 전이용)")
    ap.add_argument("--seed", type=int, default=None,
                    help="시드 (재현·비교용일 때만 지정, 기본은 무작위)")
    ap.add_argument("--duration", type=float, default=5.0, help="길이(초), 기본이자 하한 5")
    ap.add_argument("--ratio", default=None,
                    help='화면비율, 예: "16:9 (Widescreen)" (기본은 템플릿 값)')
    ap.add_argument("--mp", type=float, default=None,
                    help="크기(메가픽셀), 예: 0.4 프리뷰 / 1.0 네이티브 (기본은 템플릿 값)")
    ap.add_argument("--ref-size", choices=["match", "max"], default="max",
                    help="레퍼런스 처리 크기: max=정체성 재현력 우선(기본, 디노 확정 2026-08-03) / match=빠름")
    ap.add_argument("--prefix", default=None,
                    help='결과 파일 이름 접두어, 예: "video/H3_T1" (기본은 템플릿 값)')
    ap.add_argument("--workflow", default=DEFAULT_WORKFLOW, help="워크플로 JSON 경로")
    ap.add_argument("--quality", choices=["draft", "standard", "general", "action"], default="standard")
    ap.add_argument("--server", default="http://127.0.0.1:8188")
    args = ap.parse_args()

    if args.duration < 5.0:
        ap.error("--duration은 5초 이상이어야 한다. 더 짧은 호흡은 원본 내부 샷 전환과 편집으로 만든다")

    if args.prompt_file:
        with open(args.prompt_file, encoding="utf-8") as f:
            prompt_text = f.read().strip()
    elif args.prompt:
        prompt_text = args.prompt
    else:
        ap.error("--prompt 또는 --prompt-file 이 필요하다")
    if len(args.ref) < 1 or len(args.ref) > 9:
        ap.error("--ref 는 1~9번 지정해야 한다 (이 워크플로는 레퍼런스 기반)")

    if args.workflow == DEFAULT_WORKFLOW:
        submit_vdn(args, prompt_text)
        return

    with open(args.workflow, encoding="utf-8") as f:
        wf = json.load(f)

    wf[NODE_PROMPT]["inputs"]["value"] = prompt_text
    wf[NODE_DURATION]["inputs"]["value"] = args.duration
    seed = args.seed if args.seed is not None else random.randint(0, 2**48)
    wf[NODE_SEED]["inputs"]["noise_seed"] = seed
    if args.ratio is not None:
        wf[NODE_RESOLUTION]["inputs"]["aspect_ratio"] = args.ratio
    if args.mp is not None:
        wf[NODE_RESOLUTION]["inputs"]["megapixels"] = args.mp
    if args.ref_size is not None:
        wf[NODE_MAIN]["inputs"]["ref_image_size"] = args.ref_size
    if args.prefix is not None:
        wf[NODE_SAVE]["inputs"]["filename_prefix"] = args.prefix

    ref_names = []
    for ref in args.ref:
        if os.path.isfile(ref):
            name = upload_image(args.server, ref)
            print(f"업로드: {ref} -> 입력함 '{name}'")
        else:
            name = ref
        ref_names.append(name)

    # 템플릿의 레퍼런스 배선을 걷어내고 장수에 맞게 처음부터 다시 깐다
    for key in [k for k in list(wf[NODE_MAIN]["inputs"]) if k.startswith("ref_images.")]:
        del wf[NODE_MAIN]["inputs"][key]
    wf.pop(NODE_REF1, None)
    wf.pop(NODE_REF2, None)
    for i, name in enumerate(ref_names):
        nid = str(200 + i)
        wf[nid] = {"inputs": {"image": name}, "class_type": "LoadImage",
                   "_meta": {"title": f"Ref Image {i + 1}"}}
        wf[NODE_MAIN]["inputs"][f"ref_images.ref_image_{i}"] = [nid, 0]

    if args.ref_video:
        if os.path.isfile(args.ref_video):
            vname = upload_image(args.server, args.ref_video)
            print(f"업로드: {args.ref_video} -> 입력함 '{vname}'")
        else:
            vname = args.ref_video
        # 영상을 프레임(그림 연속)과 소리로 분해해서 지휘 노드에 꽂는다
        wf["300"] = {"inputs": {"file": vname}, "class_type": "LoadVideo",
                     "_meta": {"title": "Ref Video"}}
        wf["301"] = {"inputs": {"video": ["300", 0]}, "class_type": "GetVideoComponents",
                     "_meta": {"title": "Ref Video 분해"}}
        wf[NODE_MAIN]["inputs"]["ref_videos.ref_video_0"] = ["301", 0]
        if args.ref_video_audio == "on":
            wf[NODE_MAIN]["inputs"]["ref_video_audios.ref_video_audio_0"] = ["301", 1]

    if args.ref_audio:
        if os.path.isfile(args.ref_audio):
            aname = upload_image(args.server, args.ref_audio)
            print(f"업로드: {args.ref_audio} -> 입력함 '{aname}'")
        else:
            aname = args.ref_audio
        wf["310"] = {"inputs": {"audio": aname}, "class_type": "LoadAudio",
                     "_meta": {"title": "Ref Audio"}}
        wf[NODE_MAIN]["inputs"]["ref_audios.ref_audio_0"] = ["310", 0]

    payload = json.dumps({"prompt": wf}).encode("utf-8")
    req = urllib.request.Request(
        f"{args.server}/prompt", data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print("큐잉 실패:", e.read().decode("utf-8", "replace"))
        sys.exit(1)

    print(f"큐잉 완료  작업번호: {result['prompt_id']}  시드: {seed}")
    print(f"상태 확인:  python status.py {result['prompt_id']}")


if __name__ == "__main__":
    main()
