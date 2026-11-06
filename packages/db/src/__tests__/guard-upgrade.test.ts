import { describe, expect, it } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Each case upgrades its own scratch database, so the test database is never migrated.
// The journal and SQL come from the repository, so the test follows what ships.
const DRIZZLE = fileURLToPath(new URL('../../drizzle/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const NEW_TAG = '0160_transfer_guard_before_system_roles';
const NEW_ENTRY_WHEN = 1793197500000;
const CORRECTED_ROLE_CHECK =
  'referenced_team IS NOT NULL AND referenced_team IS DISTINCT FROM owning_team';

// The earlier guard each fork lineage installed, and where it sits in the upstream history.
const LINEAGES = [
  {
    // The fork's main: the guard was 0147, recorded before upstream's 0147 migrations.
    name: 'main',
    fixture: join(FIXTURES, '0147_project_transfer_guards.sql'),
    tag: '0147_project_transfer_guards',
    when: 1791484733357,
    after: '0146_agent_schedule_extension',
  },
  {
    // The fork's origin/upstream-main branch: the guard was 0150, recorded after upstream 0149.
    name: 'origin',
    fixture: join(FIXTURES, '0150_project_transfer_guards.sql'),
    tag: '0150_project_transfer_guards',
    when: 1792062663164,
    after: '0149_oauth_provider_tables',
  },
];

const base = new URL(process.env.DATABASE_URL!);
const template = base.pathname.slice(1);

function urlFor(database: string) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function recreate(name: string) {
  const admin = postgres(urlFor('postgres'), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

async function drop(name: string) {
  const admin = postgres(urlFor('postgres'), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

// A migrations folder holding upstream's journal up to `lastTag`, plus an optional extra entry.
async function folderThrough(lastTag: string, extra?: { tag: string; when: number; file: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'itsaplan-upgrade-'));
  await mkdir(join(dir, 'meta'));
  const journal = JSON.parse(await readFile(join(DRIZZLE, 'meta/_journal.json'), 'utf8'));
  // Upstream's own history: this fork's entry is the one under test, so the setup omits it.
  const upstream = journal.entries.filter((entry: { tag: string }) => entry.tag !== NEW_TAG);
  const cut = upstream.findIndex((entry: { tag: string }) => entry.tag === lastTag);
  const entries = upstream.slice(0, cut + 1);
  for (const entry of entries) {
    await copyFile(join(DRIZZLE, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  if (extra) {
    entries.push({
      idx: entries.length,
      version: '7',
      when: extra.when,
      tag: extra.tag,
      breakpoints: true,
    });
    await copyFile(extra.file, join(dir, `${extra.tag}.sql`));
  }
  await writeFile(
    join(dir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

async function migrateFolder(url: string, folder: string) {
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}

// The migrate service's own entry point, run against the scratch database.
async function runMigrateScript(url: string) {
  const proc = Bun.spawn([process.execPath, 'packages/db/src/migrate.ts'], {
    cwd: REPO,
    env: { ...process.env, DATABASE_URL: url, SKIP_PRE_MIGRATION_BACKUP: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${out}${err}` };
}

function expectMigrated(result: { code: number | null; output: string }) {
  if (result.code !== 0) {
    throw new Error(`migrate.ts exited ${result.code}:\n${result.output}`);
  }
}

// One workspace owner, and two legacy members with no role. 0161 backfills those onto
// the system member role, which the guard must then accept.
async function seedLegacyProject(url: string) {
  const sql = postgres(url, { max: 1 });
  try {
    await sql`insert into "user" (id, name, email) values
      ('ada', 'Ada', 'ada@example.test'), ('leo', 'Leo', 'leo@example.test'),
      ('mia', 'Mia', 'mia@example.test')`;
    const [workspace] = await sql`insert into workspace (name) values ('Legacy') returning id`;
    await sql`insert into workspace_manager (workspace_id, user_id, role)
      values (${workspace.id}, 'ada', 'owner')`;
    const [team] = await sql`insert into team (name, workspace_id)
      values ('Core', ${workspace.id}) returning id`;
    await sql`insert into team_member (team_id, user_id, role) values
      (${team.id}, 'ada', 'owner'), (${team.id}, 'leo', 'member'), (${team.id}, 'mia', 'member')`;
    const [project] = await sql`insert into project (key, name, team_id)
      values ('OPS', 'Operations', ${team.id}) returning id`;
    await sql`insert into project_member (project_id, user_id, role, role_id) values
      (${project.id}, 'ada', 'owner', null), (${project.id}, 'leo', 'member', null),
      (${project.id}, 'mia', 'member', null)`;
    return project.id as number;
  } finally {
    await sql.end();
  }
}

async function guardFunction(url: string) {
  const sql = postgres(url, { max: 1 });
  try {
    const [row] =
      await sql`select pg_get_functiondef('check_project_team_reference'::regproc) as def`;
    return row.def as string;
  } finally {
    await sql.end();
  }
}

async function appliedAt(url: string, when: number) {
  const sql = postgres(url, { max: 1 });
  try {
    const [row] = await sql`select count(*)::int as n from drizzle.__drizzle_migrations
      where created_at = ${when}`;
    return row.n as number;
  } finally {
    await sql.end();
  }
}

describe('guard upgrade', () => {
  it.each(LINEAGES)(
    'upgrades a $name database with the earlier guard and legacy members to the corrected guard',
    async (lineage) => {
      const name = `${template}_upgrade_${lineage.name}_${process.pid}`;
      const folders: string[] = [];
      await recreate(name);
      try {
        const early = await folderThrough(lineage.after, {
          tag: lineage.tag,
          when: lineage.when,
          file: lineage.fixture,
        });
        folders.push(early);
        await migrateFolder(urlFor(name), early);
        const projectId = await seedLegacyProject(urlFor(name));

        expectMigrated(await runMigrateScript(urlFor(name)));

        expect(await guardFunction(urlFor(name))).toContain(CORRECTED_ROLE_CHECK);
        const sql = postgres(urlFor(name), { max: 1 });
        try {
          const [triggers] = await sql`select count(*)::int as n from pg_trigger
            where tgname like '%_team_reference' and not tgisinternal`;
          expect(triggers.n).toBe(7);
          const [system] = await sql`select id from team_role
            where team_id is null and is_default`;
          const rows = await sql`select user_id, role_id from project_member
            where project_id = ${projectId}`;
          const roleOf = (user: string) => rows.find((row) => row.user_id === user)?.role_id;
          expect(roleOf('leo')).toBe(system.id);
          expect(roleOf('mia')).toBe(system.id);
          expect(roleOf('ada')).toBeNull();
        } finally {
          await sql.end();
        }
        expect(await appliedAt(urlFor(name), NEW_ENTRY_WHEN)).toBe(1);
      } finally {
        await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
        await drop(name);
      }
    },
    240_000,
  );

  it('skips the new entry on a database already past 0161 and still installs the guard', async () => {
    const name = `${template}_upgrade_head_${process.pid}`;
    const folders: string[] = [];
    await recreate(name);
    try {
      const head = await folderThrough('0176_sharing_controls');
      folders.push(head);
      await migrateFolder(urlFor(name), head);

      expectMigrated(await runMigrateScript(urlFor(name)));

      expect(await guardFunction(urlFor(name))).toContain(CORRECTED_ROLE_CHECK);
      expect(await appliedAt(urlFor(name), NEW_ENTRY_WHEN)).toBe(0);
    } finally {
      await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
      await drop(name);
    }
  }, 240_000);

  it('applies the new entry on a fresh database before the role backfill', async () => {
    const name = `${template}_upgrade_fresh_${process.pid}`;
    await recreate(name);
    try {
      expectMigrated(await runMigrateScript(urlFor(name)));

      expect(await guardFunction(urlFor(name))).toContain(CORRECTED_ROLE_CHECK);
      expect(await appliedAt(urlFor(name), NEW_ENTRY_WHEN)).toBe(1);
    } finally {
      await drop(name);
    }
  }, 240_000);
});
