export interface ObjectInfo {
  readonly key: string
  readonly size: number
  readonly etag?: string
  readonly lastModified?: Date
}

/** Minimal immutable object-storage capability required by replication. */
export interface ObjectStore {
  readonly put: (key: string, value: Uint8Array) => Promise<void>
  readonly get: (key: string) => Promise<Uint8Array | undefined>
  readonly list: (prefix: string) => Promise<ReadonlyArray<ObjectInfo>>
  readonly remove: (key: string) => Promise<void>
}

export const memory = (): ObjectStore & { readonly entries: () => ReadonlyMap<string, Uint8Array> } => {
  const values = new Map<string, Uint8Array>()
  return Object.freeze<ObjectStore & { readonly entries: () => ReadonlyMap<string, Uint8Array> }>({
    put: async (key, value) => { values.set(key, value.slice()) },
    get: async key => values.get(key)?.slice(),
    list: async prefix => Object.freeze([...values].filter(([key]) => key.startsWith(prefix)).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => Object.freeze({ key, size: value.length }))),
    remove: async key => { values.delete(key) },
    entries: () => new Map([...values].map(([key,value]) => [key, value.slice()]))
  })
}
