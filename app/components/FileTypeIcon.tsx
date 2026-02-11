import React, { useMemo } from 'react';
import { SvgXml } from 'react-native-svg';
import { getIcon, themeIcons } from 'seti-icons';

// Seti dark theme — VS Code's default file icon color palette
const SETI_DARK_THEME: Record<string, string> = {
  blue: '#519aba',
  grey: '#4d5a5e',
  'grey-light': '#6d8086',
  green: '#8dc149',
  orange: '#e37933',
  pink: '#f55385',
  purple: '#a074c4',
  red: '#cc3e44',
  white: '#d4d7d6',
  yellow: '#cbcb41',
  ignore: '#41535b',
};

const getThemedIcon = themeIcons(SETI_DARK_THEME);

interface FileTypeIconProps {
  filename: string;
  size?: number;
}

export function FileTypeIcon({ filename, size = 16 }: FileTypeIconProps) {
  const { svg, color } = useMemo(() => {
    const basename = filename.includes('/') ? filename.split('/').pop()! : filename;
    return getThemedIcon(basename);
  }, [filename]);

  // Inject fill color into SVG — seti SVGs are monochrome paths without fill
  const coloredSvg = useMemo(() => {
    return svg.replace('<svg ', `<svg fill="${color}" `);
  }, [svg, color]);

  return <SvgXml xml={coloredSvg} width={size} height={size} />;
}
