/** Landing light/dark preference, shared by the pre-paint boot script and the toggle. */
export const THEME_STORAGE_KEY = 'capacity-landing-theme';
export const THEME_ATTRIBUTE = 'data-landing-theme';

/**
 * Applies a stored choice to <html> before first paint. Without a stored choice nothing is set and CSS
 * follows the system preference. Storage can throw in private modes.
 */
export const themeBootScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.setAttribute('${THEME_ATTRIBUTE}',t)}}catch(e){}})()`;
