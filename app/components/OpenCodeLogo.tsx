import React from 'react';
import Svg, { Path } from 'react-native-svg';

interface OpenCodeLogoProps {
  width?: number;
  height?: number;
  color?: string;
  variant?: 'dark' | 'light';
}

/**
 * OpenCode logo icon component
 * Based on the official OpenCode brand assets from https://opencode.ai/brand
 */
export function OpenCodeLogo({
  width = 24,
  height = 24,
  color,
  variant = 'dark'
}: OpenCodeLogoProps) {
  // Auto-select color based on variant if not explicitly provided
  const fillColor = color || (variant === 'dark' ? '#F1ECEC' : '#211E1E');
  const innerColor = variant === 'dark' ? '#4B4646' : '#CFCECD';
  const outerColor = variant === 'dark' ? '#B7B1B1' : '#656363';

  return (
    <Svg width={width} height={height} viewBox="0 0 24 42" fill="none">
      {/* Inner filled rectangle */}
      <Path d="M18 30H6V18H18V30Z" fill={innerColor} />

      {/* Outer bracket shape */}
      <Path
        d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z"
        fill={outerColor}
      />
    </Svg>
  );
}

/**
 * OpenCode full wordmark logo
 * Based on the official OpenCode brand assets from https://opencode.ai/brand
 */
export function OpenCodeWordmark({
  width = 234,
  height = 42,
  variant = 'dark'
}: { width?: number; height?: number; variant?: 'dark' | 'light' }) {
  // Color scheme based on variant
  const innerColor = variant === 'dark' ? '#4B4646' : '#CFCECD';
  const outerColor = variant === 'dark' ? '#B7B1B1' : '#656363';
  const textColor = variant === 'dark' ? '#F1ECEC' : '#211E1E';

  return (
    <Svg width={width} height={height} viewBox="0 0 234 42" fill="none">
      {/* First bracket - O */}
      <Path d="M18 30H6V18H18V30Z" fill={innerColor}/>
      <Path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" fill={outerColor}/>

      {/* Second bracket - P */}
      <Path d="M48 30H36V18H48V30Z" fill={innerColor}/>
      <Path d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" fill={outerColor}/>

      {/* E */}
      <Path d="M84 24V30H66V24H84Z" fill={innerColor}/>
      <Path d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" fill={outerColor}/>

      {/* N */}
      <Path d="M108 36H96V18H108V36Z" fill={innerColor}/>
      <Path d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" fill={outerColor}/>

      {/* C */}
      <Path d="M144 30H126V18H144V30Z" fill={innerColor}/>
      <Path d="M144 12H126V30H144V36H120V6H144V12Z" fill={textColor}/>

      {/* O */}
      <Path d="M168 30H156V18H168V30Z" fill={innerColor}/>
      <Path d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" fill={textColor}/>

      {/* D */}
      <Path d="M198 30H186V18H198V30Z" fill={innerColor}/>
      <Path d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" fill={textColor}/>

      {/* E */}
      <Path d="M234 24V30H216V24H234Z" fill={innerColor}/>
      <Path d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" fill={textColor}/>
    </Svg>
  );
}
