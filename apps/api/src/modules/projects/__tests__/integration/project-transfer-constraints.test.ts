import { beforeEach, describe, expect, it } from 'bun:test';
import {
  db,
  projectMember,
  teamInvite,
  teamMember,
  agentSchedule,
  agentRun,
  gitProviderConnection,
  gitManagedRepository,
} from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { pgErrorCode } from '#shared/lib';
import { authedApi, createProject, ownWorkspaceId } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { createRole } from '#tests/helpers/roles';

async function setup() {
  const owner = await signUpTestUser();
  const api = authedApi(owner.cookie);
  const source = (await createProject(api, { key: 'MOVE', name: 'Project' })).data!;
  const target = (
    await api.teams.post({
      name: 'Destination',
      slug: 'destination',
      workspaceId: await ownWorkspaceId(api),
    })
  ).data!;
  const agent = (
    await api.teams({ teamId: source.teamId })['ai-agents'].post({
      name: 'Worker',
      username: 'worker',
      kind: 'external',
      projectIds: [],
    })
  ).data!.agent;
  const sourceRole = (await createRole(api, source.key, { name: 'Analyst', permissions: {} }))
    .data!;
  expect(
    (
      await api.projects({ projectKey: source.ref }).transfer.post({
        projectId: source.id,
        sourceTeamId: source.teamId,
        targetTeamId: target.id,
      })
    ).status,
  ).toBe(200);
  return { owner, api, source, target, agent, sourceRole };
}

async function expectConflict(write: () => Promise<unknown>, reason: string) {
  // Simulate a writer whose API validation happened before the transfer. Its
  // database commit must independently reject the now-stale team reference, and
  // for this reason: a check that passes earlier would otherwise hide a missing one.
  let error: unknown;
  try {
    await write();
  } catch (caught) {
    error = caught;
  }
  expect(pgErrorCode(error)).toBe('40001');
  // drizzle wraps the Postgres error; the RAISE text is on its cause.
  const raised = (error as { cause?: { message?: string } }).cause?.message ?? '';
  expect(raised).toContain(reason);
}

describe('project transfer database boundaries', () => {
  beforeEach(resetDb);

  it('rejects a late source-agent membership and a source-role update', async () => {
    const { owner, api, source, target, agent, sourceRole } = await setup();
    // The agent is on the destination team, so the membership check passes and the
    // agent-team check is the one that refuses the row.
    await db.insert(teamMember).values({ teamId: target.id, userId: agent.userId, role: 'member' });
    await expectConflict(
      async () =>
        db.insert(projectMember).values({
          projectId: source.id,
          userId: agent.userId,
          role: 'member',
          roleId: null,
        }),
      'Project agent belongs to a different team',
    );
    await expectConflict(
      async () =>
        db
          .update(projectMember)
          .set({ roleId: sourceRole.id })
          .where(
            and(eq(projectMember.projectId, source.id), eq(projectMember.userId, owner.userId)),
          ),
      'Project role belongs to a different team',
    );
    const members = (
      await api.teams({ teamId: target.id }).projects({ projectId: source.id }).members.get()
    ).data!.items;
    expect(members.some((m) => m.userId === agent.userId)).toBe(false);
    expect(members.find((m) => m.userId === owner.userId)).toMatchObject({
      role: 'owner',
      roleId: null,
    });
  });

  it('lets a team member hold a system role on a project of the team', async () => {
    // Default agent members get the system member role, which belongs to no team.
    const owner = await signUpTestUser();
    const api = authedApi(owner.cookie);
    const source = (await createProject(api, { key: 'MOVE', name: 'Project' })).data!;
    const member = await signUpTestUser();
    const invite = (
      await api
        .teams({ teamId: source.teamId })
        .invites.post({ email: member.email, role: 'member' })
    ).data!;
    await authedApi(member.cookie).invites({ token: invite.token }).accept.post();
    const systemRole = (await api.teams({ teamId: source.teamId }).roles.options.get()).data!.find(
      (r) => r.system,
    )!;
    await db.insert(projectMember).values({
      projectId: source.id,
      userId: member.userId,
      role: 'member',
      roleId: systemRole.id,
    });
    const [row] = await db
      .select({ roleId: projectMember.roleId })
      .from(projectMember)
      .where(and(eq(projectMember.projectId, source.id), eq(projectMember.userId, member.userId)));
    expect(row?.roleId).toBe(systemRole.id);
  });

  it('rejects a late source-team invitation', async () => {
    const { api, source, target } = await setup();
    await expectConflict(
      async () =>
        db.insert(teamInvite).values({
          teamId: source.teamId,
          projectId: source.id,
          email: 'late@example.com',
          projectRole: 'member',
        }),
      'Project invitation belongs to a different team',
    );
    expect((await api.teams({ teamId: target.id }).invites.get()).data).toEqual([]);
  });

  it('rejects late source-agent schedules and pending runs', async () => {
    const { source, agent } = await setup();
    await expectConflict(
      async () =>
        db.insert(agentSchedule).values({
          agentId: agent.id,
          projectId: source.id,
          name: 'Late schedule',
          prompt: 'Task',
          cron: '* * * * *',
          timezone: 'UTC',
          nextRunAt: new Date(),
        }),
      'Project agent belongs to a different team',
    );
    await expectConflict(
      async () =>
        db.insert(agentRun).values({
          agentId: agent.id,
          projectId: source.id,
          trigger: 'manual',
          prompt: 'Task',
        }),
      'Project agent belongs to a different team',
    );
  });

  it('rejects a late project member who is not on the project team', async () => {
    const { source } = await setup();
    const outsider = await signUpTestUser();
    await expectConflict(
      async () =>
        db.insert(projectMember).values({
          projectId: source.id,
          userId: outsider.userId,
          role: 'member',
          roleId: null,
        }),
      'Project member no longer belongs to its team',
    );
  });

  it('rejects a late repository on a connection of another team', async () => {
    const { source } = await setup();
    const [connection] = await db
      .insert(gitProviderConnection)
      .values({
        teamId: source.teamId,
        provider: 'github',
        baseUrl: 'https://github.com',
        accountLogin: 'acme',
        ciphertext: 'x',
        iv: 'x',
        authTag: 'x',
      })
      .returning({ id: gitProviderConnection.id });
    await expectConflict(
      async () =>
        db.insert(gitManagedRepository).values({
          projectId: source.id,
          connectionId: connection.id,
          externalId: '1',
          fullName: 'acme/repo',
          webUrl: 'https://github.com/acme/repo',
          webhookExternalId: '1',
        }),
      'Project repository connection belongs to a different team',
    );
  });
});
