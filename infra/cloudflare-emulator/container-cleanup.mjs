// A random run name is an ownership boundary, not a broad project-name filter.
export function stopRunContainers(runName, docker) {
  if (!/^weletic-local-probe-[a-f0-9]{12}$/.test(runName)) {
    throw new Error("Invalid emulator run identity");
  }
  const pattern = new RegExp(
    `^workerd-${runName}-LoyaltyProbe-[a-f0-9]{64}(?:-proxy)?$`,
  );
  const list = () => {
    const output = docker([
      "ps",
      "--no-trunc",
      "--filter",
      `name=workerd-${runName}-`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ]).trim();
    if (!output) return [];
    return output.split("\n").map((line) => {
      const [id, name, extra] = line.split("\t");
      if (
        extra !== undefined ||
        !/^[a-f0-9]{64}$/.test(id) ||
        !pattern.test(name)
      ) {
        throw new Error("Unexpected container identity; cleanup refused");
      }
      return id;
    });
  };
  const ids = list();
  if (ids.length > 2 || new Set(ids).size !== ids.length) {
    throw new Error("Unexpected container inventory; cleanup refused");
  }
  for (const id of ids) {
    try {
      docker(["stop", "--timeout", "10", id]);
    } catch {
      // An auto-removed container may disappear after enumeration. Still attempt
      // the other owned ID, then use fresh state as the cleanup success gate.
    }
  }
  if (list().length)
    throw new Error("Emulator containers remain after cleanup");
  return ids.length;
}
