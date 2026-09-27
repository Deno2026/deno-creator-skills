"""Current H3 production graphs: mode-matched INT8 pruned + VDN.

Both modes: draft 864x480 and standard 1344x768, native 8 steps.
R2V 1088p-class recipes: general = 960x544 7 steps -> latent x2 -> last step + cinematic 0.6,
action = 1344x768 all 8 steps -> latent x1.5 -> last step (8+1).
"""
from __future__ import annotations
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
# 정본 그래프 여섯: 이 파일 옆(창고 첨부로 같이 받은 경우)이 먼저, 없으면 디노 리포 배치
WORKFLOWS = next((p for p in (HERE, ROOT / 'library/workflows/minimax-h3') if (p / 'minimax_h3_ref2va_pruned_vdn8_native.api.json').exists()), ROOT / 'library/workflows/minimax-h3')
SIZES = {'draft': (864, 480), 'standard': (1344, 768),
         'general': (960, 544), 'action': (1344, 768)}
TEMPLATES = {'draft': 'native', 'standard': 'native',
             'general': 'general7plus1', 'action': 'action8plus1'}
R2V_ONLY = ('general', 'action')
MODELS = {
    'ref2va': 'Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors',
    'fl2va': 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
}
LORAS = {mode: f'H3_R2V_AB\\minimax_h3_dmd_{mode}_8step_turbo_pruned.safetensors' for mode in MODELS}

def frame_grid(seconds: float) -> int:
    if not 5 <= seconds <= 15.1:
        raise ValueError('H3 production duration must be 5 to 15.1 seconds')
    return max(124, 5 + round((seconds * 24 - 5) / 17) * 17)

def build_graph(*, mode='ref2va', quality='standard', prompt, images, seed=1,
                seconds=10, frames=None, prefix='H3_VDN/output', orientation='landscape',
                width=None, height=None, last_image=None, audio=None):
    if mode not in MODELS or quality not in SIZES:
        raise ValueError('mode=ref2va/fl2va; quality=draft/standard/general/action '
                         '(1088p-class R2V is general or action)')
    if mode == 'fl2va' and quality in R2V_ONLY:
        raise ValueError('general/action are R2V (ref2va) recipes')
    if orientation not in ('landscape', 'portrait'):
        raise ValueError('orientation=landscape/portrait')
    if not images or (mode == 'fl2va' and len(images) != 1):
        raise ValueError('R2V requires references; FL2VA requires one independent start image')
    if (width is None) != (height is None):
        raise ValueError('width and height must be supplied together')
    if width is None:
        width, height = SIZES[quality]
        if orientation == 'portrait': width, height = height, width
    if min(width, height) < 64 or width % 32 or height % 32:
        raise ValueError('H3 dimensions must be positive multiples of 32')
    length = frame_grid(seconds) if frames is None else frames
    if not 124 <= length <= 362 or length % 17 != 5:
        raise ValueError('H3 frames must be 17k+5 in the 124..362 production range')
    path = WORKFLOWS / f'minimax_h3_{mode}_pruned_vdn8_{TEMPLATES[quality]}.api.json'
    graph = json.loads(path.read_text(encoding='utf-8'))
    graph['140']['inputs'].update(width=width, height=height)
    graph['7']['inputs'].update(prompt=prompt, length=length)
    graph['8']['inputs']['noise_seed'] = seed
    graph['120']['inputs']['filename_prefix'] = prefix
    graph.pop('6', None)
    if mode == 'ref2va':
        for key in list(graph['7']['inputs']):
            if key.startswith('ref_images.'): del graph['7']['inputs'][key]
        for i, image in enumerate(images):
            nid = str(200 + i)
            graph[nid] = {'class_type': 'LoadImage', 'inputs': {'image': image}}
            graph['7']['inputs'][f'ref_images.ref_image_{i}'] = [nid, 0]
        if audio:
            graph['310'] = {'class_type': 'LoadAudio', 'inputs': {'audio': audio}}
            graph['7']['inputs']['ref_audios.ref_audio_0'] = ['310', 0]
    else:
        graph['6'] = {'class_type': 'LoadImage', 'inputs': {'image': images[0]}}
        if last_image:
            graph['61'] = {'class_type': 'LoadImage', 'inputs': {'image': last_image}}
            graph['7']['inputs']['last_frame'] = ['61', 0]
    return graph
