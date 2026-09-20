export * as DatabaseDriveMigration from "./drive-migration"

import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

type Input = {
  from: string
  to: string
}

const eventPaths: Record<string, readonly [string, string]> = {
  "session.created.1": ["info", "directory"],
  "session.updated.1": ["info", "directory"],
  "session.deleted.1": ["info", "directory"],
  "session.next.moved.1": ["location", "directory"],
}

export function apply(db: Database) {
  const from = process.env.OPENCODE_PORTABLE_MIGRATE_FROM
  const to = process.env.OPENCODE_PORTABLE_MIGRATE_TO
  if (!from || !to) return Effect.void
  return remap(db, { from, to })
}

export function remap(db: Database, input: Input) {
  const from = drive(input.from)
  const to = drive(input.to)
  if (from === to) return Effect.void

  const fromPrefix = `${from}/`
  const toPrefix = `${to}/`
  return db.transaction(
    (tx) =>
      Effect.gen(function* () {
        const collision = yield* tx.get<{ projectID: string; directory: string }>(sql`
          SELECT source.project_id AS projectID, source.directory
          FROM project_directory AS source
          INNER JOIN project_directory AS target
            ON target.project_id = source.project_id
            AND lower(target.directory) = lower(${toPrefix} || substr(source.directory, 4))
          WHERE lower(substr(source.directory, 1, 3)) = lower(${fromPrefix})
          LIMIT 1
        `)
        if (collision) {
          return yield* Effect.fail(
            new Error(`Cannot move ${collision.directory}: project ${collision.projectID} already has the target directory`),
          )
        }

        yield* relocateColumn(tx, "project", "worktree", fromPrefix, toPrefix)
        yield* relocateColumn(tx, "project_directory", "directory", fromPrefix, toPrefix)
        yield* relocateColumn(tx, "session", "directory", fromPrefix, toPrefix)
        yield* relocateColumn(tx, "workspace", "directory", fromPrefix, toPrefix)

        const projects = yield* tx.all<{ id: string; sandboxes: string }>(sql`SELECT id, sandboxes FROM project`)
        yield* Effect.forEach(
          projects,
          (project) => {
            const current = JSON.parse(project.sandboxes) as string[]
            const next = current.map((item) => relocatePath(item, fromPrefix, toPrefix))
            if (next.every((item, index) => item === current[index])) return Effect.void
            return tx.run(sql`UPDATE project SET sandboxes = ${JSON.stringify(next)} WHERE id = ${project.id}`)
          },
          { discard: true },
        )

        const events = yield* tx.all<{ id: string; type: string; data: string }>(sql`
          SELECT id, type, data
          FROM event
          WHERE type IN ('session.created.1', 'session.updated.1', 'session.deleted.1', 'session.next.moved.1')
        `)
        yield* Effect.forEach(
          events,
          (event) => {
            const data = JSON.parse(event.data) as Record<string, unknown>
            const path = eventPaths[event.type]
            if (!path) return Effect.void
            const parent = data[path[0]]
            if (!parent || typeof parent !== "object") return Effect.void
            const value = (parent as Record<string, unknown>)[path[1]]
            if (typeof value !== "string") return Effect.void
            const next = relocatePath(value, fromPrefix, toPrefix)
            if (next === value) return Effect.void
            ;(parent as Record<string, unknown>)[path[1]] = next
            return tx.run(sql`UPDATE event SET data = ${JSON.stringify(data)} WHERE id = ${event.id}`)
          },
          { discard: true },
        )
      }),
    { behavior: "immediate" },
  )
}

function relocateColumn(tx: Transaction, table: string, column: string, from: string, to: string) {
  return tx.run(sql`
    UPDATE ${sql.identifier(table)}
    SET ${sql.identifier(column)} = ${to} || substr(${sql.identifier(column)}, 4)
    WHERE lower(substr(${sql.identifier(column)}, 1, 3)) = lower(${from})
  `)
}

function drive(input: string) {
  const match = /^([A-Za-z]):(?:[\\/])?$/.exec(input)
  if (!match) throw new Error(`Invalid Windows drive root: ${input}`)
  return `${match[1].toUpperCase()}:`
}

function relocatePath(input: string, from: string, to: string) {
  if (input.slice(0, 3).toLowerCase() !== from.toLowerCase()) return input
  return to + input.slice(3)
}
