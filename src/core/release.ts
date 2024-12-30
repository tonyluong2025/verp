const [ALPHA, BETA, RELEASE_CANDIDATE, FINAL] = ['ALPHA', 'BETA', 'RELEASE_CANDIDATE', 'FINAL'];
const RELEASE_LEVELS_DISPLAY = {
  [ALPHA]: 'alpha',
  [BETA]: 'beta',
  [RELEASE_CANDIDATE]: 'rc',
  [FINAL]: ''
}
export const versionInfo = [1, 0, 0, FINAL, 0, ''];
export const productName = 'Verp';
export const description = 'Verp Server';
export const version = versionInfo.slice(0,2).map((v)=>`${v}`).join('.') 
  + RELEASE_LEVELS_DISPLAY[`${versionInfo[3]}`]
  + `${versionInfo[4] as number > 0 ? versionInfo[4] : ''}` + versionInfo[5];
export const series = versionInfo.slice(0,2).map((v)=>`${v}`).join('.');
export const serie = series;
export const majorVersion = series; 

export const url = 'https://www.theverp.com';
export const author = 'The Verp JSC';
export const authorEmail = 'info@theverp.com';
export const license = 'MIT Expat';

export const ntServiceName = "verp-server-" + series.replace('~','-')