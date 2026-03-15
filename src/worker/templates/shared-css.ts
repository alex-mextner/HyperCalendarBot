import { fontFaceCSS } from './fonts.ts';

export function sharedCSS(vars: { bg: string; textPrimary: string }): string {
  return `
    ${fontFaceCSS}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: ${vars.bg};
      color: ${vars.textPrimary};
      -webkit-font-smoothing: antialiased;
    }
    #__root {
      width: 1080px;
      padding: 48px;
    }
  `;
}
