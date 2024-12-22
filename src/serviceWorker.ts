import "core-js/stable";
import "regenerator-runtime/runtime";
import browser from "webextension-polyfill";
import { SEASONS } from "./seasons";
import { changesToValues, hasTimedout } from "./utils";

import debug from "debug";

browser.storage.local.set({ debug: "*" });
debug.enabled("*");

const log = debug("background");

//let seasonOverride = -1;
//let bungieApiKey: string | undefined = undefined;
//let lastChangedDate = 0;

const allBgImages = SEASONS.map(
  (v) => `https://www.bungie.net${v.progressPageImage}`
);

browser.storage.onChanged.addListener(async (changes, area) => {
  const { seasonOverride, bungieApiKey } = await browser.storage.local.get([
    "seasonOverride",
    "bungieApiKey",
  ]);
  const prevSeasonOverride = seasonOverride;

  log("storage.onChanged emitted", changes);
  const values = changesToValues(changes);
  unpackStorageValues(values);

  if (
    bungieApiKey &&
    seasonOverride &&
    seasonOverride > 0 &&
    seasonOverride !== prevSeasonOverride
  ) {
    tryReloadTabs();
  }
});

browser.storage.local.get().then((values) => {
  log("storage.local.get", values);
  unpackStorageValues(values);
});

browser.webRequest.onSendHeaders.addListener(
  interceptPlatformHeaders,
  {
    urls: ["https://www.bungie.net/Platform/*"],
  },
  ["requestHeaders"]
);

browser.webRequest.onBeforeRequest.addListener(
  interceptBackgroundImages,
  { urls: allBgImages },
  ["blocking"]
);

function chromeOnlySettingsIntercept() {
  log("Registering chrome-only onBeforeRequest");
  browser.webRequest.onBeforeRequest.addListener(
    chromeInterceptSettingsRequest,
    { urls: ["https://www.bungie.net/Platform/Settings*"] },
    ["blocking"]
  );
}

chromeOnlySettingsIntercept();

// if (browser.runtime.getBrowserInfo) {
//   browser.runtime.getBrowserInfo().then((browserInfo) => {
//     if (browserInfo.name.toLowerCase() !== "firefox") {
//       chromeOnlySettingsIntercept();
//     }
//   });
// } else {
//   // If we don't have getBrowserInfo, we're probably in Chrome
//   chromeOnlySettingsIntercept();
// }

async function unpackStorageValues(values: Record<string, any>) {
  console.groupCollapsed("Synced storage values to local variables");
  log("Values:", values);

  if ("lastChangedDate" in values && hasTimedout(values.lastChangedDate)) {
    log("Last change was too long ago, clearing all storage");
    browser.storage.local.remove(["seasonHash", "lastChangedDate"]);
    console.groupEnd();
    return;
  }

  const { seasonOverride, bungieApiKey, lastChangedDate } =
    await browser.storage.local.get([
      "seasonOverride",
      "bungieApiKey",
      "lastChangedDate",
    ]);

  if (values.seasonHash) {
    browser.storage.local.set({ seasonOverride: Number(values.seasonHash) });
    log("seasonOverride", seasonOverride);
  }

  if (values.bungieApiKey) {
    browser.storage.local.set({ bungieApiKey: values.bungieApiKey });
    log("bungieApiKey", bungieApiKey);
  }

  if (values.lastChangedDate) {
    browser.storage.local.set({ lastChangedDate: values.lastChangedDate });
    log("lastChangedDate", lastChangedDate);
  }

  console.groupEnd();
}

let lastRefresh = 0;

async function tryReloadTabs() {
  const sinceLastRefresh = Date.now() - lastRefresh;
  log("ms since last refresh", sinceLastRefresh);

  if (sinceLastRefresh < 2000) {
    log("refreshed too recently, not going to ");
    return;
  }

  lastRefresh = Date.now();

  const bungieTabs = await browser.tabs.query({
    url: "https://www.bungie.net/7/en/Seasons/PreviousSeason",
  });

  for (const tab of bungieTabs) {
    log("Reloading tab", tab.id);
    browser.tabs.reload(tab.id);
  }
}

/**
 * Intercepts Bungie.net API header requests to obtain the API key
 */
async function interceptPlatformHeaders(
  request: browser.WebRequest.OnSendHeadersDetailsType
) {
  const apiKeyHeader = request.requestHeaders?.find(
    (v) => v.name.toLowerCase() === "x-api-key"
  );
  if (!apiKeyHeader?.value) return;
  if (request.url.includes("?seasonPassPass")) return;

  const path = new URL(request.url).pathname;
  log("Grabbed API key from Bungie request", path);
  await browser.storage.local.set({ bungieApiKey: apiKeyHeader.value });
}

/**
 * Intercepts requests for season background images to return the background image for the overridden season
 */
async function interceptBackgroundImages(
  request: browser.WebRequest.OnSendHeadersDetailsType
): Promise<{ redirectUrl: string } | { cancel: boolean }> {
  const { lastChangedDate, seasonOverride } = await browser.storage.local.get([
    "lastChangedDate",
    "seasonOverride",
  ]);

  if (hasTimedout(lastChangedDate)) {
    return { cancel: true };
  }

  const requestedImagePathname = new URL(request.url).pathname;
  console.groupCollapsed("Request for", requestedImagePathname);

  log("seasonOverride", seasonOverride);

  const seasonForOverride = SEASONS.find((v) => v.hash === seasonOverride);
  log("seasonForOverride", seasonForOverride);

  if (!seasonForOverride) {
    log("Could not find season data for the override");
    console.groupEnd();
    return { cancel: true };
  }

  if (seasonForOverride.progressPageImage === requestedImagePathname) {
    log("Correct image anyway");
    console.groupEnd();
    return { cancel: true };
  }

  const requestedSeason = SEASONS.find(
    (v) => v.progressPageImage === requestedImagePathname
  );

  log("The season the browser requested is", requestedSeason);

  if (requestedSeason && requestedSeason.endDate.getTime() < Date.now()) {
    const redirectUrl = `https://www.bungie.net${seasonForOverride.progressPageImage}`;
    log("Redirecting", request.url, "to", redirectUrl);

    console.groupEnd();
    return {
      redirectUrl,
    };
  }

  console.groupEnd();
  return { cancel: true };
}

/**
 * Intercepts requests for the Settings endpoint and potentially provides a modified response
 */
async function chromeInterceptSettingsRequest(
  request: browser.WebRequest.OnBeforeSendHeadersDetailsType
): Promise<{ redirectUrl: string } | { cancel: boolean }> {
  const { lastChangedDate, seasonOverride } = await browser.storage.local.get([
    "lastChangedDate",
    "seasonOverride",
  ]);

  const logIntercept = debug("background:intercept:" + request.requestId);
  logIntercept("Intercepted settings request", request.url);

  if (request.url.includes("?seasonPassPass")) {
    logIntercept("Intercepted our own request. Stopping.");
    return { cancel: true };
  }

  if (hasTimedout(lastChangedDate)) {
    logIntercept("Has timed out. Stopping.");
    return { cancel: true };
  }

  if (!seasonOverride) {
    logIntercept("Don't have a season override. Stopping.");
    return { cancel: true };
  }

  return {
    redirectUrl: `https://destiny-activities.destinyreport.workers.dev/seasonPassPass?season=${seasonOverride}`,
  };
}
