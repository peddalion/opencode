import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { DatabaseDriveMigration } from "@opencode-ai/core/database/drive-migration"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

describe("DatabaseDriveMigration", () => {
  test("moves canonical Windows paths and known durable events", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project', 'F:/projects/demo', '["F:/projects/demo/worktree","C:/external"]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO project_directory (project_id, directory, type, time_created)
          VALUES ('project', 'F:/projects/demo', 'main', 1)
        `)
        yield* db.run(sql`
          INSERT INTO workspace (id, type, name, directory, project_id, time_used)
          VALUES ('workspace', 'local', '', 'F:/projects/demo', 'project', 1)
        `)
        yield* db.run(sql`
          INSERT INTO session (id, project_id, workspace_id, slug, directory, path, title, version, time_created, time_updated)
          VALUES ('session', 'project', 'workspace', 'session', 'F:/projects/demo/packages/api', 'packages/api', 'Demo', 'test', 1, 1)
        `)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 2)`)
        yield* db.run(sql`
          INSERT INTO event (id, aggregate_id, seq, type, data)
          VALUES
            ('created', 'session', 1, 'session.created.1', '{"info":{"directory":"F:/projects/demo"}}'),
            ('moved', 'session', 2, 'session.next.moved.1', '{"location":{"directory":"F:/projects/demo/packages/api"}}')
        `)

        yield* DatabaseDriveMigration.remap(db, { from: "f:\\", to: "D:" })
        yield* DatabaseDriveMigration.remap(db, { from: "F:", to: "D:\\" })

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'project'`)).toEqual({
          worktree: "D:/projects/demo",
          sandboxes: '["D:/projects/demo/worktree","C:/external"]',
        })
        expect(yield* db.get(sql`SELECT directory FROM project_directory`)).toEqual({
          directory: "D:/projects/demo",
        })
        expect(yield* db.get(sql`SELECT directory FROM workspace`)).toEqual({ directory: "D:/projects/demo" })
        expect(yield* db.get(sql`SELECT directory, path FROM session`)).toEqual({
          directory: "D:/projects/demo/packages/api",
          path: "packages/api",
        })
        expect(yield* db.all(sql`SELECT id, data FROM event ORDER BY id`)).toEqual([
          { id: "created", data: '{"info":{"directory":"D:/projects/demo"}}' },
          { id: "moved", data: '{"location":{"directory":"D:/projects/demo/packages/api"}}' },
        ])
      }),
    )
  })

  test("rolls back when a project directory already exists on the target drive", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`
          INSERT INTO project (id, worktree, sandboxes, time_created, time_updated)
          VALUES ('project', 'F:/projects/demo', '[]', 1, 1)
        `)
        yield* db.run(sql`
          INSERT INTO project_directory (project_id, directory, type, time_created)
          VALUES
            ('project', 'F:/projects/demo', 'main', 1),
            ('project', 'D:/projects/demo', 'git_worktree', 2)
        `)

        const result = yield* DatabaseDriveMigration.remap(db, { from: "F:", to: "D:" }).pipe(Effect.exit)
        expect(result._tag).toBe("Failure")
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'project'`)).toEqual({
          worktree: "F:/projects/demo",
        })
      }),
    )
  })
})
