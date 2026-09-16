export const MINI_APP_RETURN_PARAM = '__veneer_return';

export interface MiniAppNavigation {
  appUrl: string;
  returnUrl: string;
  returnsToOrigin: boolean;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** Remove Veneer's launch metadata before an app handles the request and only
 * honor same-origin return destinations. */
export function miniAppNavigation(
  requestUrl: string | URL,
  publicOrigin: string,
  appsUrl: string,
): MiniAppNavigation {
  const appUrl = new URL(requestUrl);
  const rawReturnUrl = appUrl.searchParams.get(MINI_APP_RETURN_PARAM);
  appUrl.searchParams.delete(MINI_APP_RETURN_PARAM);

  let returnUrl = appsUrl;
  let returnsToOrigin = false;
  if (rawReturnUrl) {
    try {
      const candidate = new URL(rawReturnUrl);
      const expectedOrigin = new URL(publicOrigin).origin;
      if (
        candidate.origin === expectedOrigin &&
        (candidate.protocol === 'https:' || candidate.protocol === 'http:')
      ) {
        returnUrl = candidate.toString();
        returnsToOrigin = true;
      }
    } catch {
      // Invalid or partial return URLs fail closed to the Apps directory.
    }
  }

  return { appUrl: appUrl.toString(), returnUrl, returnsToOrigin };
}

export function miniAppControlsMarkup(navigation: MiniAppNavigation): string {
  const closeLabel = navigation.returnsToOrigin ? 'Close app and return to chat' : 'Close app';
  return (
    '<nav data-veneer-app-controls aria-label="App controls" style="position:fixed;' +
    'top:max(8px,calc(env(safe-area-inset-top) + 8px));left:12px;right:12px;z-index:2147483647;' +
    'display:flex;align-items:center;justify-content:space-between;gap:8px;pointer-events:none;' +
    'font:600 14px/1 Inter,system-ui,sans-serif;color:#26221c">' +
    '<a data-veneer-app-close data-veneer-app-exit href="' + escapeAttribute(navigation.returnUrl) + '" aria-label="' + closeLabel + '" ' +
    'style="box-sizing:border-box;display:inline-flex;min-height:48px;align-items:center;gap:8px;padding:0 16px;' +
    'pointer-events:auto;border:1px solid rgba(38,34,28,.18);border-radius:999px;background:rgba(250,247,242,.96);' +
    'box-shadow:0 4px 18px rgba(38,34,28,.16);color:#26221c;text-decoration:none;' +
    'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">' +
    '<span aria-hidden="true" style="font-size:20px;font-weight:400">&#10005;</span><span>Close</span></a>' +
    '<a data-veneer-app-new-window href="' + escapeAttribute(navigation.appUrl) + '" target="_blank" rel="noopener noreferrer" ' +
    'aria-label="Open app in new window" style="box-sizing:border-box;display:inline-flex;min-height:48px;align-items:center;' +
    'gap:8px;padding:0 16px;pointer-events:auto;border:1px solid rgba(38,34,28,.18);border-radius:999px;' +
    'background:rgba(250,247,242,.96);box-shadow:0 4px 18px rgba(38,34,28,.16);color:#26221c;' +
    'text-decoration:none;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">' +
    '<span>New window</span><span aria-hidden="true" style="font-size:20px;font-weight:400">&#8599;</span></a></nav>'
  );
}
