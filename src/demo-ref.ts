/** Order reference ids this demo creates. A loose prefix such as mc-test- does not match. */
export function isDemoReference(reference: string): boolean {
  return /^(mendcash-seed-[a-z0-9]+(?:-[a-z0-9]+)?|mendcash-\d{10,}|sim-\d+|mc-\d+)$/i.test(reference.trim());
}
