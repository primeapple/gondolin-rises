import type { Stats } from "node:fs";
import type {
  VirtualFileHandle,
  VirtualProvider,
} from "@earendil-works/gondolin";

// Bind delegation to original receiver: providers and handles use private fields.
function delegate<T extends object>(backend: T, overrides: Partial<T>): T {
  return new Proxy(backend, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value, target);
    },
  });
}

export function createOwnershipProvider(
  backend: VirtualProvider,
  hostUid: number,
  hostGid: number,
): VirtualProvider {
  function translateId(id: number | bigint, hostId: number): number | bigint {
    if (typeof id === "bigint") return id === BigInt(hostId) ? 0n : id;
    return id === hostId ? 0 : id;
  }

  function translate(stats: Stats): Stats {
    if (!stats) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
      uid: translateId(stats.uid, hostUid),
      gid: translateId(stats.gid, hostGid),
    });
  }

  function wrapHandle(handle: VirtualFileHandle): VirtualFileHandle {
    return delegate(handle, {
      stat: async (options) => translate(await handle.stat(options)),
      statSync: (options) => translate(handle.statSync(options)),
    });
  }

  return delegate(backend, {
    stat: async (path, options) => translate(await backend.stat(path, options)),
    statSync: (path, options) => translate(backend.statSync(path, options)),
    lstat: async (path, options) =>
      translate(await backend.lstat(path, options)),
    lstatSync: (path, options) => translate(backend.lstatSync(path, options)),
    open: async (path, flags, mode) =>
      wrapHandle(await backend.open(path, flags, mode)),
    openSync: (path, flags, mode) =>
      wrapHandle(backend.openSync(path, flags, mode)),
  });
}
