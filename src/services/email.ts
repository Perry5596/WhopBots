/**
 * Gmail ignores dots in the local part of an address.
 * A bitmask of length (localPart.length - 1) encodes every unique variation.
 */
export function generateDotVariations(
  gmailAddress: string,
  count: number,
  offset = 0,
): string[] {
  const [localRaw, domain] = gmailAddress.split("@");
  const local = localRaw.replace(/\./g, "");
  const gaps = local.length - 1;
  const totalVariations = 2 ** gaps;

  if (offset + count > totalVariations) {
    throw new Error(
      `Cannot generate ${count} variations (offset=${offset}). ` +
      `"${local}" only supports ${totalVariations} dot permutations total.`,
    );
  }

  const results: string[] = [];
  for (let mask = offset; mask < offset + count; mask++) {
    let addr = "";
    for (let i = 0; i < local.length; i++) {
      addr += local[i];
      if (i < gaps && (mask >> i) & 1) {
        addr += ".";
      }
    }
    results.push(`${addr}@${domain}`);
  }

  return results;
}

export function maxVariations(gmailAddress: string): number {
  const local = gmailAddress.split("@")[0].replace(/\./g, "");
  return 2 ** (local.length - 1);
}
