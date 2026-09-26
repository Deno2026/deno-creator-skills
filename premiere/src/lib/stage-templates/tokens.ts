export const PLUM_NOIR = {
  deepBackground: '#0F0E12',
  primarySurface: '#1B1320',
  raisedSurface: '#2E1E38',
  plumDetail: '#5A386B',
  signalAccent: '#F2FF59',
  secondaryText: '#A3A6AD',
  neutralControl: '#2A2A31',
  primaryText: '#E8E6E1',
  warmText: '#F0EEE8',
} as const;

export const STAGE_FONT_FAMILY =
  '"Noto Sans KR", "Noto Sans", "Malgun Gothic", sans-serif';

export const STAGE_SAFE_AREA = {
  horizontal: 96,
  vertical: 72,
} as const;

export const withAlpha = (hex: string, alpha: number) => {
  const normalized = hex.replace('#', '');
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const clampedAlpha = Math.max(0, Math.min(1, alpha));
  return `rgba(${red}, ${green}, ${blue}, ${clampedAlpha})`;
};
