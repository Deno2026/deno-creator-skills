# -*- coding: utf-8 -*-
"""교육숏츠 대본 — Gemini 가 처음부터 쓴다 (검수가 아니라 집필).

디노 제안(2026-09-05): 대본 만족도가 60%. 지금은 「Claude 초안 → Gemini 검수」라
Claude 의 어순·설명 습관이 뼈대에 남는다. 순서를 뒤집어 **무엇을 설명할지만 우리가
정하고**(주장·계단·보상·팩트 경계) 글은 Gemini 가 처음부터 쓰게 한다.

입력: 작품 BRIEF 에서 뽑은 설명 명세(JSON). 출력: 구간별 spoken_text JSON.
런북 규칙(3초 후킹, 보상 배치, 계단)은 제약으로 넘기고, 문장은 「듣는 사람에게
자연스러운가」 하나만 기준으로 준다(2026-09-05 디노: TTS 우회용 문장 규칙 전부 은퇴).

  python _infra/script-review/gemini_write.py <명세.json> --out <대본.json> [--model gemini-3.7-flash]
"""
import io, os, sys, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gemini_review import load_key, FALLBACKS, ENDPOINT, _Overloaded, _Fatal  # 키·모델 목록만 빌린다
import time, urllib.request, urllib.error


def ask_plain(model, key, prompt, temperature=0.7):
    # gemini_review.ask() 는 검수 지시문(CRITERIA)을 자동으로 앞에 붙인다. 집필은 그러면
    # 안 되므로 순수 프롬프트로 따로 부른다. 재시도·대체 모델 체인은 같게.
    body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": temperature, "responseMimeType": "application/json"}}
    req = urllib.request.Request(ENDPOINT % model, data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json', 'x-goog-api-key': key})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=180))
    except urllib.error.HTTPError as e:
        msg = e.read().decode('utf-8', 'replace').replace(key, '<KEY>')
        if e.code in (429, 500, 503):
            raise _Overloaded('HTTP %s %s' % (e.code, msg[:160]))
        raise _Fatal('HTTP %s / %s' % (e.code, msg[:800]))
    cand = (r.get('candidates') or [{}])[0]
    txt = ''.join(p.get('text', '') for p in (cand.get('content') or {}).get('parts') or [])
    return txt, r.get('usageMetadata', {})


def ask_with_retry(model, key, prompt, tries=3):
    chain = [model] + [m for m in FALLBACKS if m != model]; last = ''
    for m in chain:
        for i in range(tries):
            try:
                txt, usage = ask_plain(m, key, prompt); return m, txt, usage
            except _Overloaded as e:
                last = str(e); time.sleep(2 + 3 * i)
            except _Fatal as e:
                sys.exit(str(e))
    sys.exit('모든 모델이 과부하다. ' + last[:300])

DEFAULT_MODEL = 'gemini-3.7-flash'

RULES = """당신은 한국어 교육 숏츠(60~90초, 세로 영상) 나레이션 대본 작가입니다.
아래 「설명 명세」에 적힌 것만 말하고, 거기 없는 사실을 지어내지 마세요.
순서와 주장은 명세가 정합니다. 당신이 정하는 것은 **문장**입니다.

[반드시 지킬 것]
1. 첫 20음절 안에 이 영상이 무엇에 관한 것인지 나와야 합니다. 상황 묘사로 시작하지
   마세요. 첫 문장이 곧 결론이어도 됩니다. 아껴야 할 것은 답이 아니라 반전입니다.
2. 시청자가 이 영상을 보고 **달라지는 것**이 있어야 합니다. 명세의 「보상」을 첫 구간에서
   예고하고, 중간에서 회수하고, 마지막 구간에서 시청자 쪽의 변화로 닫으세요.
3. 명세의 「깨달음의 계단」은 한 칸도 건너뛰지 마세요. 숫자가 적혀 있으면 그 숫자가
   어떻게 나오는지 시청자가 따라올 수 있게 말합니다. 결론만 던지지 마세요.
4. 구간 하나는 7~12초입니다. 구간 수는 명세를 따릅니다.
5. 기본 문법은 질문형입니다(운영자 확정 2026-09-12). 구간을 시청자가 속으로 물을 질문(~까요?)으로
   열고, 같은 구간 안에서 바로 답하세요. 질문을 구간 끝에 걸어 다음 구간으로 넘기지 마세요.
   모든 구간을 질문으로 열지는 말고(질문 사이에 평서 구간), 첫 질문은 시청자가 화면에서 본 말을
   묻고, 마지막 질문은 그것을 되받되 같은 질문을 되풀이하지 말고 시청자가 할 일로 물으세요.
6. 파라미터 이름·권장 설정값을 넣지 마세요. 개념 이해가 목표입니다.

[문장의 기준]
시청자가 실제로 **들었을 때** 잘 들리고, 자연스럽고, 이해가 바로 되는 문장. 사람이 옆에서 설명하듯
쓰되, **가볍지 않게** — 이 채널의 톤은 담백하고 신뢰가 있는 정중체입니다.
- 어미의 기본은 `~습니다/~입니다`. `~죠`는 되묻거나 앞말을 물릴 때만 소수(전체의 2할 이하).
- 의문은 `~까요?`. **`~요` 종결(`~에요` `~거든요` `~어요` `~는데요` `~고요`)은 쓰지 않습니다** —
  가볍게 들리기 때문입니다.
- 문장 길이·쉼표 개수에 규칙은 없습니다. 번역투를 피하고, 같은 뜻이면 입에 붙는 쪽을 고릅니다.
  쓴 문장을 소리 내어 읽어 보고 걸리면 고치세요.
- 숫자와 영문 약어는 평소 말하는 대로 적으세요(발음 표기는 나중 단계가 맡습니다).

출력은 아래 JSON 하나만. 다른 말을 붙이지 마세요.
{
  "segments": [
    {"id": "E01", "role": "<이 구간이 하는 일 한 줄>", "spoken_text": "<대사 전문>"}
  ],
  "reward_sentence": "이 영상을 보기 전의 나는 ___ 였는데, 보고 난 나는 ___ 한다.",
  "notes": "<명세와 어긋나게 쓴 곳이 있으면 여기 적기. 없으면 빈 문자열>"
}"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('spec')
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default=DEFAULT_MODEL)
    a = ap.parse_args()
    spec = io.open(a.spec, encoding='utf-8').read()
    key = load_key()
    used, raw, usage = ask_with_retry(a.model, key, RULES + '\n\n=== 설명 명세 ===\n' + spec)
    try:
        d = json.loads(raw)
    except Exception:
        print('JSON 파싱 실패. 원문 앞부분:'); print(raw[:1200]); sys.exit(1)
    io.open(a.out, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=1))
    han = lambda t: len([c for c in t if '가' <= c <= '힣'])
    print('모델 %s | 토큰 입력 %s 출력 %s' % (used, usage.get('promptTokenCount'), usage.get('candidatesTokenCount')))
    tot = 0
    for s in d.get('segments', []):
        n = han(s['spoken_text']); tot += n
        print('%s  %3d음절  %s' % (s['id'], n, s['spoken_text']))
    print('합계 %d음절 ≈ %.1f초' % (tot, tot / 6.4 + 0.5 * len(d.get('segments', []))))
    print('보상:', d.get('reward_sentence'))
    if d.get('notes'): print('메모:', d['notes'])
    print('->', a.out)


if __name__ == '__main__':
    main()
