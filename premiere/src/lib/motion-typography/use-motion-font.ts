import {useEffect, useState} from 'react';
import {cancelRender, continueRender, delayRender, staticFile} from 'remotion';
import {selectMotionFont, validateMotionText, type MotionFontId} from './catalog';

const loads = new Map<MotionFontId, Promise<FontFace>>();
function prepareFont(id: MotionFontId) {
  const existing = loads.get(id);
  if (existing) return existing;
  const font = selectMotionFont(id);
  // Adobe binaries stay in the licensed local installation, never in assets.
  const source = 'local' in font ? `local(${JSON.stringify(font.local)})` : `url(${JSON.stringify(staticFile(font.file))})`;
  const promise = new FontFace(font.family, source, {weight: String(font.weight), style: 'normal'}).load().then(face => {
    document.fonts.add(face);
    return face;
  });
  loads.set(id, promise);
  return promise;
}

export function useMotionFont(id: MotionFontId | null, lines: string[]) {
  if (id !== null) { selectMotionFont(id); validateMotionText(lines, id); }
  const [readyId, setReadyId] = useState<MotionFontId | null>(null);
  useEffect(() => {
    if (id === null) return;
    const handle = delayRender(`Loading selected motion font: ${id}`);
    let active = true;
    prepareFont(id).then(() => {
      if (active) setReadyId(id);
      continueRender(handle);
    }).catch(error => {
      if (active) cancelRender(new Error(`Required font ${id} could not load. Activate the Adobe face or run prepare-motion-fonts.mjs for the selected Google face. No fallback was rendered. ${String(error)}`));
      else continueRender(handle);
    });
    return () => {active = false;};
  }, [id]);
  return id !== null && readyId === id ? selectMotionFont(id) : null;
}
