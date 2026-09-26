import React, {type CSSProperties} from 'react';
import * as icons from 'simple-icons';

// Single-colour brand mark from Simple Icons (CC0), tinted to the Studio palette so it sits on the paper surface
// like type does. Vector: any size, no PNG hunting. Rule owner: channel-motion-profile.md → 연속 텍스트의 변주 → 아이콘·마크.
//   <BrandMark slug="x" size={64} color={C.cream} />      slug = Simple Icons slug: 'x', 'instagram', 'threads', 'youtube', 'github', 'nvidia', 'claude', 'anthropic', 'discord', 'meta'
// Brands missing from Simple Icons (OpenAI, Adobe, Higgsfield) are generated with GPT image as transparent PNG instead.

type IconRecord = {title: string; slug: string; hex: string; path: string};

export function brandMark(slug: string): IconRecord {
  const key = 'si' + slug.replace(/[^a-z0-9]/gi, '').toLowerCase().replace(/^./, (c) => c.toUpperCase());
  const icon = (icons as unknown as Record<string, IconRecord | undefined>)[key];
  if (!icon) throw new Error(`Simple Icons has no mark for "${slug}" (looked up ${key}); generate it with GPT image instead`);
  return icon;
}

export function BrandMark({slug, size = 64, color = '#F0EEE8', x, y, opacity = 1, style = {}, title}: {
  slug: string; size?: number; color?: string; x?: number; y?: number; opacity?: number; style?: CSSProperties; title?: string;
}) {
  const icon = brandMark(slug);
  const pos: CSSProperties = x !== undefined || y !== undefined ? {position: 'absolute', left: x, top: y} : {};
  return (
    <svg role="img" aria-label={title ?? icon.title} viewBox="0 0 24 24" width={size} height={size}
      style={{display: 'block', opacity, ...pos, ...style}}>
      <path d={icon.path} fill={color} />
    </svg>
  );
}
