/**
 * The delivery gate's missing keys, said in the reader's language.
 *
 * Shared rather than written twice, because two surfaces say it now - the deployment card
 * and the finish dialog - and a second copy is how the two would come to disagree about
 * what the same gate is waiting for.
 *
 * Mapped explicitly rather than looked up by a built key, because a key the Host adds later
 * would then be printed raw: a name nobody translated is worse than the Host's own English
 * sentence, and this list is the one place that can notice. An unrecognised key falls back
 * to the key itself - it is shown, not swallowed.
 * @param t - the translation function in force.
 * @param missing - the keys the Host named.
 * @returns them joined the way this language joins a list of two.
 */
export function gateMissingText(t: (key: string) => string, missing: string[]): string {
  const labels: Record<string, string> = {
    deployment: t("deployGateMissingDeployment"),
    smoke: t("deployGateMissingSmoke"),
  }
  return missing.map((key) => labels[key] ?? key).join(t("deployGateAnd"))
}
