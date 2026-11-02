import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, relative, resolve, sep } from "node:path"
import type { ObjectInfo, ObjectStore } from "./ObjectStore.ts"

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT"

/** Local object storage; writes become visible through an atomic rename. */
export const make = (directory: string): ObjectStore => {
  const root = resolve(directory)
  const path = (key: string): string => {
    const output = resolve(root, key), name = relative(root, output)
    if (!name || name === ".." || name.startsWith(`..${sep}`) || key.includes("\\")) throw new Error("invalid object key")
    return output
  }
  return Object.freeze<ObjectStore>({
    put: async (key, value) => {
      const output = path(key), temporary = `${output}.${crypto.randomUUID()}.tmp`
      await mkdir(dirname(output), { recursive: true })
      try { await writeFile(temporary, value); await rename(temporary, output) }
      finally { await rm(temporary, { force: true }) }
    },
    get: async key => {
      try { return new Uint8Array(await readFile(path(key))) }
      catch (error) { if (missing(error)) return undefined; throw error }
    },
    remove: async key => { await rm(path(key), { force: true }) },
    list: async prefix => {
      const output: ObjectInfo[] = []
      const walk = async (directory: string): Promise<void> => {
        let entries
        try { entries = await readdir(directory, { withFileTypes: true }) }
        catch (error) { if (missing(error)) return; throw error }
        for (const entry of entries) {
          const fullPath = resolve(directory, entry.name)
          if (entry.isDirectory()) await walk(fullPath)
          else if (entry.isFile() && !entry.name.endsWith(".tmp")) {
            const key = relative(root, fullPath).split(sep).join("/")
            if (key.startsWith(prefix)) {
              const info = await stat(fullPath)
              output.push(Object.freeze({ key, size: info.size, lastModified: info.mtime }))
            }
          }
        }
      }
      await walk(root)
      return Object.freeze(output.sort((a, b) => a.key.localeCompare(b.key)))
    }
  })
}
