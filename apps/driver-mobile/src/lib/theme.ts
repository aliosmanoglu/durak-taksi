// Onaylı görsel tasarım (docs/design + *.dc.html): koyu tema, Atkinson Hyperlegible.

export const colors = {
  bg: '#0B0F14',
  surface: '#151B23',
  border: '#26303B',
  divider: '#1F2730',
  inputBorder: '#2E3843',
  text: '#FFFFFF',
  textSoft: '#C9D1D9',
  textBody: '#E6EBF0',
  muted: '#9AA4AF',
  disabledText: '#6B7580',
  ring: '#5B6672',
  green: '#3DDC84',
  greenInk: '#04130B',
  yellow: '#FFC940',
  red: '#FF6B6B',
  redSoft: '#FF8A8A',
  light: '#F2F4F6',
  outline: '#6B7682',
  outlineSoft: '#3A4552',
} as const;

export type Tone = 'yellow' | 'red' | 'green' | 'blue';

/** Uyarı şeritleri ve bildirim kartları için ton paleti. */
export const tones: Record<Tone, { bg: string; border: string; color: string }> = {
  yellow: { bg: '#2A2310', border: '#6B5516', color: '#FFD66B' },
  red: { bg: '#2B1414', border: '#6E2A2A', color: '#FF9A9A' },
  green: { bg: '#0F2A1C', border: '#1E5C3A', color: '#7CE8A8' },
  blue: { bg: '#10223A', border: '#1F4470', color: '#9CC8FF' },
};

export const fonts = {
  regular: 'AtkinsonHyperlegible_400Regular',
  bold: 'AtkinsonHyperlegible_700Bold',
} as const;

export const sizes = {
  primaryButton: 88,
  homeButton: 96,
  secondaryTarget: 56,
  gap: 16,
  title: 40,
  body: 20,
  minText: 16,
} as const;
