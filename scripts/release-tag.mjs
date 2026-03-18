const RELEASE_TAG_RE =
  /^v(?<version>\d+\.\d+\.\d+(?:-(?<prerelease>[0-9A-Za-z.-]+))?(?:\+(?<build>[0-9A-Za-z.-]+))?)$/;
const CHANNEL_RE = /^[A-Za-z][0-9A-Za-z-]*$/;

export function parseReleaseTag(tagName) {
  if (!tagName) {
    throw new Error("Missing release tag. Expected vX.Y.Z or vX.Y.Z-beta.N");
  }

  const match = tagName.trim().match(RELEASE_TAG_RE);
  if (!match?.groups?.version) {
    throw new Error(`Invalid release tag: ${tagName}. Expected vX.Y.Z or vX.Y.Z-beta.N`);
  }

  const prerelease = match.groups.prerelease ?? null;
  const firstIdentifier = prerelease ? prerelease.split(".")[0] : null;
  const channel = firstIdentifier ? firstIdentifier.toLowerCase() : null;

  if (channel && !CHANNEL_RE.test(channel)) {
    throw new Error(
      `Invalid prerelease channel in tag ${tagName}: ${firstIdentifier}. Expected a leading alphabetic identifier like beta or rc.`,
    );
  }

  return {
    tagName: tagName.trim(),
    version: match.groups.version,
    prerelease,
    isPrerelease: prerelease !== null,
    channel,
    npmDistTag: channel ?? "latest",
  };
}
