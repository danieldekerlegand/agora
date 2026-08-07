/**
 * The KGP §7.1 license axis: what class a record's license falls in, and whether a consumer's
 * allowlist admits it.
 *
 * License rides on the *record*, never in the claim hash (§7.1), so admitting or refusing one
 * never changes what a claim is — it changes only what crosses. A consumer "admits per record
 * and rejects with a report anything outside its allowlist", which is why nothing here drops a
 * record silently: it answers a question, and `admission.ts` reports the answer.
 *
 * The classification table is a **default**, not the contract. koine names an ecosystem policy
 * file (`policy/license-classes.json`) as the authority, so a deployment whose licenses this
 * table has never heard of passes its own `classify` through {@link LicenseOptions} rather than
 * editing this map — a second authored copy of somebody's license policy is exactly the kind of
 * caller-specific data that must not live in the commons.
 */

/** The §7.1 classes, in the order they are usually enumerated (most to least permissive). */
export const LICENSE_CLASSES = [
  'public-domain',
  'permissive',
  'attribution',
  'share-alike',
  'non-commercial',
  'proprietary',
] as const;

export type LicenseClass = (typeof LICENSE_CLASSES)[number];

/** §7.1's stated default allowlist. */
export const DEFAULT_LICENSE_ALLOWLIST: readonly LicenseClass[] = [
  'public-domain',
  'permissive',
  'attribution',
];

export function isLicenseClass(value: unknown): value is LicenseClass {
  return typeof value === 'string' && (LICENSE_CLASSES as readonly string[]).includes(value);
}

/** SPDX ids and the ecosystem pseudo-ids §7.1 names, keyed uppercase. */
const CLASSIFICATION: Readonly<Record<string, LicenseClass>> = {
  'CC0-1.0': 'public-domain',
  'PUBLIC-DOMAIN': 'public-domain',
  UNLICENSE: 'public-domain',
  MIT: 'permissive',
  'APACHE-2.0': 'permissive',
  'BSD-2-CLAUSE': 'permissive',
  'BSD-3-CLAUSE': 'permissive',
  ISC: 'permissive',
  'CC-BY-3.0': 'attribution',
  'CC-BY-4.0': 'attribution',
  'CC-BY-SA-3.0': 'share-alike',
  'CC-BY-SA-4.0': 'share-alike',
  'GPL-3.0-ONLY': 'share-alike',
  'GPL-3.0-OR-LATER': 'share-alike',
  'AGPL-3.0-ONLY': 'share-alike',
  'CC-BY-NC-4.0': 'non-commercial',
  'CC-BY-NC-SA-4.0': 'non-commercial',
  PROPRIETARY: 'proprietary',
  PERSONAL: 'proprietary',
};

/** A deployment's own license policy, when the default table does not cover its licenses. */
export type LicenseClassifier = (license: string) => LicenseClass | undefined;

/**
 * The class a license id falls in.
 *
 * **Fails closed:** a license this build cannot classify is `proprietary`, the most restrictive
 * class, so an unrecognised id is withheld rather than admitted. Getting it wrong in the other
 * direction publishes somebody's data under a license nobody checked, and that is not
 * recoverable.
 */
export function classifyLicense(license: string, classify?: LicenseClassifier): LicenseClass {
  const own = classify?.(license);
  if (own !== undefined) return own;
  return CLASSIFICATION[license.trim().toUpperCase()] ?? 'proprietary';
}

/** True when `allowlist` admits the record carrying `license` (§7.1). */
export function admitsLicense(
  license: string,
  allowlist: readonly LicenseClass[] = DEFAULT_LICENSE_ALLOWLIST,
  classify?: LicenseClassifier,
): boolean {
  return allowlist.includes(classifyLicense(license, classify));
}
