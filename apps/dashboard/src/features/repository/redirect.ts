/** Sends the browser to a provider's authorization page. A module of its
 * own so tests can stand in for the navigation. */
export function goTo(url: string) {
  window.location.assign(url);
}
