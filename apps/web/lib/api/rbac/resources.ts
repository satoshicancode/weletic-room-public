export const DUB_RESOURCE_KEYS = [
  "links",
  "workspaces",
  "analytics",
  "domains",
  "tags",
  "folders",
  "tokens",
  "webhooks",
  "groups",
] as const;

export type DubResourceKey = (typeof DUB_RESOURCE_KEYS)[number];
export type ResourceKey = DubResourceKey | (string & {});

export const DUB_RESOURCES: {
  name: string;
  key: ResourceKey;
  description: string;
}[] = [
  {
    name: "Links",
    key: "links",
    description: "Create, read, update, and delete links",
  },
  {
    name: "Analytics",
    key: "analytics",
    description: "Create and read analytics events",
  },
  {
    name: "Domains",
    key: "domains",
    description: "Create, read, update, and delete domains",
  },
  {
    name: "Tags",
    key: "tags",
    description: "Create, read, update, and delete tags",
  },
  {
    name: "Folders",
    key: "folders",
    description: "Create, read, update, and delete folders",
  },
];

import { permissionRegistry } from "./plugin-registry";

function getCombinedResourceKeys(): readonly ResourceKey[] {
  const pluginKeys = permissionRegistry.getRegisteredResourceKeys();
  return [
    ...new Set([...DUB_RESOURCE_KEYS, ...pluginKeys]),
  ] as readonly ResourceKey[];
}

export const RESOURCE_KEYS = new Proxy(
  [] as unknown as readonly ResourceKey[],
  {
    get(_target, prop, receiver) {
      const current = getCombinedResourceKeys();
      if (prop === "length") return current.length;
      if (prop === Symbol.iterator)
        return current[Symbol.iterator].bind(current);
      if (typeof prop === "string" && !isNaN(Number(prop)))
        return current[Number(prop)];
      const val = (current as any)[prop];
      if (typeof val === "function") return val.bind(current);
      return Reflect.get(current, prop, receiver);
    },
  },
) as readonly ResourceKey[];

function getCombinedResources() {
  const pluginResources = permissionRegistry.getRegisteredResources();
  return [...DUB_RESOURCES, ...pluginResources];
}

export const RESOURCES: {
  name: string;
  key: ResourceKey;
  description: string;
}[] = new Proxy([] as any, {
  get(_target, prop, receiver) {
    const current = getCombinedResources();
    if (prop === "length") return current.length;
    if (prop === Symbol.iterator) return current[Symbol.iterator].bind(current);
    if (typeof prop === "string" && !isNaN(Number(prop)))
      return current[Number(prop)];
    const val = (current as any)[prop];
    if (typeof val === "function") return val.bind(current);
    return Reflect.get(current, prop, receiver);
  },
}) as any;
