import React from 'react';
import {AbsoluteFill, Composition, registerRoot} from 'remotion';
import {BrandMark} from './BrandMark';
import {Surface, Type, C, useStudioFonts} from '../motion-studio';

// Proof composition for the hierarchy rule (channel-motion-profile.md → 연속 텍스트의 변주):
// the title gets a title treatment; the sibling items below share one treatment, each with a same-size tinted mark.
function Proof() {
  const fonts = useStudioFonts();
  if (!fonts) return null;
  const items: Array<[string, string]> = [['x', 'X'], ['instagram', 'Instagram'], ['threads', 'Threads']];
  return <AbsoluteFill style={{background: C.black}}>
    <Surface opacity={1} />
    {/* title: display face, big, centred, with a short accent rule beneath */}
    <Type x={0} y={250} width={1920} align="center" size={150} face={fonts.display}>GPT-6 ASTRA</Type>
    <div style={{position: 'absolute', left: 960 - 60, top: 428, width: 120, height: 8, background: C.accent}} />
    <Type x={0} y={462} width={1920} align="center" size={30} face={fonts.mono} color={C.muted}>POSTS TO</Type>
    {/* items: one treatment, same size, same colour, same gap */}
    <div style={{position: 'absolute', left: 0, top: 560, width: 1920, display: 'flex', justifyContent: 'center', gap: 120}}>
      {items.map(([slug, label]) => <div key={slug} style={{display: 'flex', alignItems: 'center', gap: 22}}>
        <BrandMark slug={slug} size={64} color={C.cream} />
        <Type x={0} y={0} size={60} face={fonts.text} color={C.cream} style={{position: 'relative'}}>{label}</Type>
      </div>)}
    </div>
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="proof" component={Proof} width={1920} height={1080} fps={30} durationInFrames={30} />);
