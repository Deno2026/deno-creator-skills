# -*- coding: utf-8 -*-
"""교육숏츠 대본 검수 — Gemini 에 런북 합격 기준으로 물어본다.

디노 확정(2026-09-03): "네가 대본 쓰고 제미나이한테 한 번 검수 받아서 다듬은 다음에
나한테 보여주는 식으로." 검수는 **GATE 1 전에** 들어간다. 디노가 보는 것은 이미 한
바퀴 돈 판이다.

근거: safetensors 편 대본이 실제로 그 순서로 합격했다. 초안은 디노 판정 "한국말투가
좀 어색하다"였고, 제미나이가 다듬은 것을 다시 양식에 맞춰 정리하자 "이대로 진행해"가
나왔다. 이 스크립트는 그 왕복을 고정한다.

**단정은 작업자가 진다.** 지적을 그대로 받아 적지 않고 맞는지 판단해서 반영한다.
대본의 권위는 런북과 디노이지 검수 모델이 아니다. 실제로 두 번 틀렸다 —
(1) 디노가 금지한 `요` 종결을 쓰라고 권했고, (2) 「그래서 어쩌라고」 빈칸을
`알게 된 것이다`로 채워 놓고 합격을 줬다. 둘 다 기준을 고쳐 막았고, 두 번째는
모델 판정을 못 믿는 자리라 코드가 직접 뒤집는다(`KNOWLEDGE_ONLY`).

기준 [0] 보상이 이 검수의 바닥이다. 나머지가 전부 좋아도 여기서 막히면 불합격이다
(런북 「시청자가 가져갈 것을 먼저 정한다」, 디노 확정 2026-09-04).

키: 환경변수 `GEMINI_API_KEY`, 없으면 `~/.deno/gemini_api_key.txt`(저장소 밖, 한 줄). 값은 출력하지 않는다.
무료 등급으로 된다(기본 모델 Flash — 공식 요금표 2026-09-27 확인, 무료 등급 입력은 구글 제품 개선에 쓰일 수 있다).

  python _infra/script-review/gemini_review.py <대본파일> [--model gemini-3.8-flash]
"""
import io, os, re, sys, json, time, argparse, urllib.request, urllib.error

KEY_PATH = os.path.join(os.path.expanduser('~'), '.deno', 'gemini_api_key.txt')
DEFAULT_MODEL = 'gemini-3.8-flash'
ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent'

# 런북 「1-1. 대본 작성법」이 소유하는 합격 기준을 검사 항목으로 옮긴 것이다.
CRITERIA = """당신은 한국어 교육 숏츠 대본을 검수합니다. 아래 기준으로만 보고,
기준 밖의 총평이나 칭찬은 쓰지 마세요.

[0] 보상 — 다 보고 난 시청자에게 남는 것이 있는가 (가장 중요, 먼저 판단)
    이 항목이 불합격이면 나머지가 전부 좋아도 `verdict`는 "수정 필요"입니다.

    아래 문장을 이 대본으로 채워 보세요.
      "이 영상을 보기 전의 나는 [겪은 일 / 하던 오해] 였는데,
       보고 난 나는 [달라진 것] 이다."

    - 채울 수 없으면 불합격입니다.
    - **뒤 빈칸을 `~을 알게 되었다` `~을 이해했다` `~임을 알았다` `~을 알 수 있다`
      로 쓰면 불합격입니다.** 그것은 지식이지 보상이 아닙니다. 원리를 아무리 정확히
      설명해도 시청자 쪽에서 달라지는 것이 없으면 「그래서 어쩌라고」가 됩니다.
      이 금지를 어긴 문장을 만들어 놓고 `verdict`를 "합격"으로 주지 마세요.
    - 뒤 빈칸은 시청자가 **앞으로 하게 되는 일**로 씁니다. 다음 꼴이어야 합니다.
        "이제 ~를 보면 ~로 읽는다"
        "더 이상 ~라고 생각하지 않는다"
        "~를 기다릴 때 ~를 떠올린다"
        "누가 물으면 ~라고 말해 줄 수 있다"
      `안다`가 아니라 `한다`로 끝나야 합니다.
    - 앞 빈칸에는 **시청자가 실제로 겪는 장면**이 들어가야 합니다. 화면에서 본 것,
      눌러 본 것, 기다려 본 것입니다. 상상 속 궁금증은 안 됩니다.

    보상은 네 종류이고 최소 하나가 있어야 합니다.
      설명 보상 — 전에 직접 겪었는데 이유를 몰랐던 일이 설명된다 (가장 강함)
      예측 보상 — 다음에 그것을 만나면 알아본다
      교정 보상 — 잘못 알고 있던 것이 깨진다
      전달 보상 — 남에게 옮길 한 문장이 생긴다 (이것만 있으면 불합격)

    배치도 봅니다.
      - 첫 구간의 질문이 시청자가 실제로 겪는 일을 가리키는가 (예고)
      - 그 현상을 원리로 풀어 주는 구간이 중간에 있는가 (회수)
      - 마지막 구간이 결론 요약이 아니라 시청자 쪽의 변화로 닫는가 (확인)

    지적할 때는 **어떤 보상을 어느 구간에 넣으면 되는지**까지 쓰세요.
    주의: `파라미터 이름`이나 `권장 설정값`을 넣으라고 제안하지 마세요. 그것은
    이 시리즈에서 금지입니다. 보상은 "이렇게 설정하세요"가 아니라
    "당신이 본 그것이 이것입니다"로 만듭니다.

[0.5] 후킹 — 3초 안에 무엇에 관한 영상인지 나오는가 (보상 다음으로 중요)
    이 항목이 불합격이면 `verdict`는 "수정 필요"입니다.

    3초는 약 20음절입니다(6.4음절/초). 대본 맨 앞 20음절을 떼어 읽고 판단하세요.

      "이 영상은 무엇에 관한 것인가?" 를 **한 단어로** 답할 수 있어야 합니다.

    - 답이 안 나오거나 "글쎄"면 불합격입니다. 그 20음절을 그대로 인용하고,
      주제어가 앞으로 오게 고친 첫 문장을 제안하세요.
    - 뜸 들이는 세 가지는 전부 불합격 사유입니다.
        (1) 상황 묘사를 먼저 깔고 나중에 본론으로 들어간다
        (2) 두 구간이 연속으로 답 없이 질문만 던진다 — 질문을 던진 다음 구간은
            반드시 답의 실체를 줘야 합니다. 또 다른 질문으로 받으면 불합격입니다
        (3) 주제어를 아껴 두었다가 20초쯤에 공개한다
    - **답을 먼저 줘도 됩니다.** 원리형이라도 결론을 3초에 주고 "왜 그런가"로
      끌고 가는 편이 낫습니다. 아껴야 하는 것은 답이 아니라 반전입니다.
      따라서 "결론을 뒤로 미루라"는 제안은 하지 마세요.

[1] 말투 — 듣는 사람에게 자연스럽고, 신뢰가 있는가 (2026-09-06 개정)
    - 기준: 시청자가 실제로 들었을 때 잘 들리고, 자연스럽고, 이해가 바로 되는가. 그리고 **가볍게
      들리지 않는가.** 이 채널의 톤은 담백하고 신뢰가 있는 정중체입니다.
    - 어미의 기본은 `~습니다/~입니다` 입니다(문장의 대다수). `~죠`는 되묻거나 앞말을 물릴 때만
      소수로 씁니다. 의문은 `~까요?` 로 던집니다.
    - **`~요` 종결(`~에요` `~예요` `~거든요` `~어요` `~는데요` `~고요`)은 지적 대상입니다** — 틀려서가
      아니라 가볍게 들려서입니다(디노 판정 2026-09-06: "요를 허용하니까 말투가 너무 가벼워 보인다").
      대안은 `~습니다` 또는 문장을 다시 짜는 것으로 제안하세요.
    - 문장을 전부 `~합니다.`로 끊어 닫아 낭독처럼 들리는 구간은 지적해도 됩니다. 단 대안은 `~요`가
      아니라 문장 길이·리듬·`죠` 한 번으로 푸세요.
    - 어색한 한국어, 번역투(「~에 의해」「~것이다」 남발, 주어 과다, 영어 어순), 입에 붙지 않는 문장,
      한 번 듣고 못 따라갈 만큼 정보가 많은 문장을 지적하세요.
    - 문장 음절 수와 쉼표 개수는 지적하지 마세요.

[2] 구조 — 깨달음의 계단
    - 앞 계단이 없으면 뒤가 성립하지 않아야 합니다. 순서가 뒤집힌 곳을 지적하세요.
    - 정의 나열이 되어버린 구간이 있으면 지적하세요.

[3] 질문형 문법과 결속 (운영자 확정 2026-09-12 — 이 채널 대본의 기본 뼈대는 질문형입니다)
    - 구간을 시청자가 속으로 물을 질문(~까요?)으로 열고, 같은 구간 안에서 바로 답하는가.
      질문을 구간 끝에 걸어 두고 다음 구간에서야 답하면 지적하세요.
    - 모든 구간이 질문으로 열려 공식처럼 들리면 지적하세요(평서 구간이 한두 개는 있어야 합니다).
      단 이유형(앞 구간의 답이 다음 질문을 부르는 사슬 — 에이전트 설명 편의 기본)은 질문 구간이
      두세 개 이어져도 지적하지 마세요.
    - 첫 질문이 시청자가 화면에서 본 말(주제어)을 묻고, 마지막 질문이 그것을 되받아 닫는가(수미상관).
      마지막에 같은 질문을 되풀이하지 말고 시청자가 할 일(어떻게 읽으면·보면 될까요)로 물어야 합니다.
    - 질문형이 아닌 대본이면 어느 구간을 어떤 질문으로 열면 되는지 제안하세요.

[4] 이해
    - 처음 듣는 사람이 그 자리에서 못 알아들을 표현.
    - 앞에서 안 깔아준 것을 뒤에서 근거로 쓰는 곳.

[5] 길이
    - 한국어 음절 수를 세고 6.4음절/초로 나눠 예상 길이를 초 단위로 알려주세요.
    - 구간별 음절 수도 함께.

출력은 아래 JSON 하나만. 다른 말은 쓰지 마세요.
{
  "verdict": "합격" | "수정 필요",
  "estimated_seconds": <숫자>,
  "reward": {
    "filled": "<[0]의 빈칸을 채운 문장 전문. 못 채우면 빈 문자열>",
    "kinds": ["설명"|"예측"|"교정"|"전달", ...],
    "announce_segment": "<보상을 예고하는 구간ID. 없으면 빈 문자열>",
    "payoff_segment": "<보상을 회수하는 구간ID. 없으면 빈 문자열>",
    "confirm_segment": "<보상을 확인하며 닫는 구간ID. 없으면 빈 문자열>"
  },
  "hook": {
    "first_20": "<대본 맨 앞 20음절 그대로>",
    "topic_word": "<그 20음절로 답한 주제어 한 단어. 답할 수 없으면 빈 문자열>",
    "stalls": ["상황묘사선행"|"질문연쇄"|"주제어지연", ...]
  },
  "segments": [{"id": "<구간ID>", "syllables": <숫자>, "seconds": <숫자>}],
  "issues": [
    {"severity": "높음"|"보통"|"낮음",
     "category": "보상"|"후킹"|"말투"|"구조"|"결속"|"이해"|"길이",
     "where": "<구간ID 또는 인용>", "problem": "<무엇이 문제인가>",
     "suggestion": "<고친 문장. 없으면 빈 문자열>"}
  ],
  "rewrite": {"<구간ID>": "<그 구간을 다듬은 전문. 고칠 게 없으면 원문 그대로>"}
}"""


# 「그래서 어쩌라고」 테스트의 뒤 빈칸이 `안다`로 끝나면 지식이지 보상이 아니다.
# 검수 모델이 이 꼴을 만들어 놓고 합격을 주는 일이 실제로 있었으므로 코드가 막는다.
KNOWLEDGE_ONLY = re.compile(
    r'(알게\s*(되었|됐|된)|알\s*수\s*있|이해(하게\s*되|했|한)|'
    r'임을\s*알|것을\s*알|깨닫게\s*(되|됐)|배우게\s*(되|됐))[^.]*\.?\s*$')


def load_key():
    k = os.environ.get('GEMINI_API_KEY', '').strip()   # 환경변수가 먼저, 없으면 파일(2026-09-27 — 창고 첨부용)
    if not k:
        if not os.path.exists(KEY_PATH):
            sys.exit('제미나이 API 키가 없다 — 환경변수 GEMINI_API_KEY 또는 파일 ' + KEY_PATH + ' (한 줄)')
        k = io.open(KEY_PATH, encoding='utf-8').read().strip()
    if len(k) < 20:
        sys.exit('API 키가 너무 짧다')
    return k


# gemini-2.5-flash 는 뺐다(2026-09-17) — API 가 404 "no longer available to new users" 를 돌려줘,
# 앞 모델들이 과부하일 때 진짜 원인 대신 404 로 끝났다(할루시네이션 편 검수).
FALLBACKS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.8-flash',
             'gemini-3.5-flash']


def ask_with_retry(model, key, text, tries=3):
    """플래시 모델은 503(과부하)이 잦다. 같은 모델을 몇 번 재시도하고,
    그래도 안 되면 대체 모델로 넘어간다. 어느 모델이 답했는지 반드시 보고한다."""
    chain = [model] + [m for m in FALLBACKS if m != model]
    last = ''
    for m in chain:
        for i in range(tries):
            try:
                txt, usage = ask(m, key, text)
                return m, txt, usage
            except _Overloaded as e:
                last = str(e)
                time.sleep(2 + 3 * i)
            except _Fatal as e:
                sys.exit(str(e))
    sys.exit('모든 모델이 과부하다. 마지막 응답: ' + last[:300])


class _Overloaded(Exception):
    pass


class _Fatal(Exception):
    pass


def ask(model, key, script_text, temperature=0.3):
    body = {
        "contents": [{"role": "user", "parts": [{"text": CRITERIA + "\n\n=== 검수할 대본 ===\n" + script_text}]}],
        "generationConfig": {"temperature": temperature, "responseMimeType": "application/json"},
    }
    req = urllib.request.Request(ENDPOINT % model, data=json.dumps(body).encode('utf-8'),
                                 headers={'Content-Type': 'application/json', 'x-goog-api-key': key})
    try:
        r = json.load(urllib.request.urlopen(req, timeout=180))
    except urllib.error.HTTPError as e:
        msg = e.read().decode('utf-8', 'replace').replace(key, '<KEY>')
        if e.code in (429, 500, 503):
            raise _Overloaded('HTTP %s %s' % (e.code, msg[:160]))
        raise _Fatal('HTTP %s\n%s' % (e.code, msg[:800]))
    except urllib.error.URLError as e:
        raise _Overloaded(str(e))
    cand = (r.get('candidates') or [{}])[0]
    parts = (cand.get('content') or {}).get('parts') or []
    txt = ''.join(p.get('text', '') for p in parts)
    usage = r.get('usageMetadata', {})
    return txt, usage


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('script')
    ap.add_argument('--model', default=DEFAULT_MODEL)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()

    text = io.open(a.script, encoding='utf-8').read()
    key = load_key()
    used, raw, usage = ask_with_retry(a.model, key, text)
    try:
        d = json.loads(raw)
    except Exception:
        print('JSON 파싱 실패. 원문 앞부분:')
        print(raw[:1200])
        sys.exit(1)

    print('모델 %s%s | 토큰 입력 %s 출력 %s'
          % (used, '' if used == a.model else ' (요청한 %s 는 과부하)' % a.model,
             usage.get('promptTokenCount'), usage.get('candidatesTokenCount')))
    # 보상은 대본의 바닥이라 지적 목록보다 먼저, 항상 보여준다.
    #
    # 검수 모델의 판정을 그대로 믿지 않는다. 2026-09-04 실측: 뒤 빈칸을
    # "...알게 된 것이다"로 채워 놓고 verdict 를 "합격"으로 준 판이 있었다.
    # 「그래서 어쩌라고」 여부는 이 대본에서 가장 비싼 판정이므로 코드가 직접 막는다.
    r = d.get('reward') or {}
    filled = (r.get('filled') or '').strip()
    kinds = r.get('kinds') or []
    blocked = []
    if not filled:
        blocked.append('빈칸을 채우지 못했다')
    elif KNOWLEDGE_ONLY.search(filled):
        blocked.append('뒤 빈칸이 `안다`로 끝난다 — 지식이지 보상이 아니다')
    if kinds == ['전달']:
        blocked.append('전달 보상만 있다 — 단독으로는 불합격이다')
    for k in ('announce_segment', 'payoff_segment', 'confirm_segment'):
        if not (r.get(k) or '').strip():
            blocked.append('보상 배치에 %s 자리가 비었다' % {'announce_segment': '예고',
                           'payoff_segment': '회수', 'confirm_segment': '확인'}[k])

    print()
    print('[보상] %s' % (filled if filled else '** 채우지 못함 **'))
    print('       종류 %s | 예고 %s -> 회수 %s -> 확인 %s'
          % ('·'.join(kinds) or '없음',
             r.get('announce_segment') or '-', r.get('payoff_segment') or '-',
             r.get('confirm_segment') or '-'))
    # 후킹 — 3초(약 20음절) 안에 주제어가 나오는가. 판단은 작업자가 눈으로 하되,
    # 주제어를 못 대거나 뜸 들이기가 잡히면 코드가 막는다.
    h = d.get('hook') or {}
    topic = (h.get('topic_word') or '').strip()
    stalls = h.get('stalls') or []
    if not topic:
        blocked.append('첫 20음절로 주제어를 한 단어로 댈 수 없다')
    if stalls:
        blocked.append('뜸 들이기: ' + '·'.join(stalls))

    print('[후킹] 첫 20음절 %s' % (h.get('first_20') or '(없음)'))
    print('       주제어 %s' % (topic or '** 못 댐 **'))

    for b in blocked:
        print('       [불합격] ' + b)
    if blocked and d.get('verdict') == '합격':
        print('       -> 검수 모델은 합격을 줬지만 보상 기준에서 막는다. 판정을 뒤집는다.')
        d['verdict'] = '수정 필요'
        d.setdefault('issues', []).insert(0, {
            'severity': '높음', 'category': '보상', 'where': '전체',
            'problem': '「그래서 어쩌라고」 테스트를 통과하지 못했다: ' + ' / '.join(blocked),
            'suggestion': '시청자가 실제로 겪은 장면을 첫 구간에서 지목하고, '
                          '마지막 구간을 시청자 쪽의 변화로 닫는다.'})
    print()
    print('판정: %s | 예상 길이 %.1f초'
          % (d.get('verdict'), float(d.get('estimated_seconds') or 0)))
    print()
    order = {'높음': 0, '보통': 1, '낮음': 2}
    for it in sorted(d.get('issues', []), key=lambda x: order.get(x.get('severity'), 9)):
        print('[%s/%s] %s' % (it.get('severity'), it.get('category'), it.get('where')))
        print('   문제: %s' % it.get('problem'))
        if it.get('suggestion'):
            print('   제안: %s' % it.get('suggestion'))
    if a.out:
        io.open(a.out, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=1))
        print('\n->', a.out)


if __name__ == '__main__':
    main()
