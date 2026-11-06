import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  agentRun,
  agentSchedule,
  db,
  gitManagedRepository,
  gitProviderConnection,
  projectMember,
  scimGroup,
  scimGroupMapping,
  teamRole,
} from '@repo/db';
import { and, eq } from 'drizzle-orm';
import { PROJECT_FEATURES } from '#shared/features';
import { createAgent } from '#tests/helpers/agents';
import { authedApi, createProject, ownWorkspaceId } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { clearLimits, setLimits } from '#tests/helpers/limits';
import { createRole } from '#tests/helpers/roles';

// A project on its own team, and a second team in the same workspace to move it to.
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
  return { owner, api, source, target };
}

describe('project transfer blockers', () => {
  beforeEach(resetDb);
  afterEach(clearLimits);

  it('blocks a member whose role belongs to another team', async () => {
    const { api, source, target } = await setup();
    const role = (await createRole(api, source.key, { name: 'Analyst', permissions: {} })).data!;
    const member = await signUpTestUser();
    const invite = (
      await api
        .projects({ projectKey: source.ref })
        .invites.post({ email: member.email, role: 'member', roleId: role.id })
    ).data!;
    expect(
      (await authedApi(member.cookie).invites({ token: invite.token }).accept.post()).status,
    ).toBe(200);
    // Moving the role to the destination leaves the member on a role the source team does not own.
    await db.update(teamRole).set({ teamId: target.id }).where(eq(teamRole.id, role.id));
    const preview = (
      await api
        .projects({ projectKey: source.ref })
        .transfer.preview.post({ targetTeamId: target.id })
    ).data!;
    expect(preview.blockers.map((b) => b.code)).toContain('foreign_roles');
  });

  it('blocks a project that a SCIM group maps to', async () => {
    const { api, source, target } = await setup();
    const [group] = await db
      .insert(scimGroup)
      .values({ displayName: 'Engineering' })
      .returning({ id: scimGroup.id });
    await db.insert(scimGroupMapping).values({ groupId: group.id, projectId: source.id });
    const preview = (
      await api
        .projects({ projectKey: source.ref })
        .transfer.preview.post({ targetTeamId: target.id })
    ).data!;
    expect(preview.blockers.map((b) => b.code)).toContain('scim_memberships');
  });

  it('blocks a paused agent schedule', async () => {
    const { api, source, target } = await setup();
    const created = (
      await createAgent(api, source.key, { name: 'Pauser', username: 'pauser', kind: 'external' })
    ).data!;
    await db.insert(agentSchedule).values({
      agentId: created.agent.id,
      projectId: source.id,
      name: 'Weekly',
      prompt: 'Task',
      cron: '0 9 * * 1',
      timezone: 'UTC',
      nextRunAt: new Date(),
      status: 'paused',
    });
    const preview = (
      await api
        .projects({ projectKey: source.ref })
        .transfer.preview.post({ targetTeamId: target.id })
    ).data!;
    expect(preview.blockers.map((b) => b.code)).toContain('agent_schedules');
  });

  it('blocks a project with a pending agent run', async () => {
    const { api, source, target } = await setup();
    const created = (
      await createAgent(api, source.key, { name: 'Runner', username: 'runner', kind: 'external' })
    ).data!;
    await db.insert(agentRun).values({
      agentId: created.agent.id,
      projectId: source.id,
      trigger: 'manual',
      prompt: 'Task',
    });
    const preview = (
      await api
        .projects({ projectKey: source.ref })
        .transfer.preview.post({ targetTeamId: target.id })
    ).data!;
    expect(preview.blockers.map((b) => b.code)).toContain('pending_runs');
  });

  it('blocks a project with a managed repository', async () => {
    const { api, source, target } = await setup();
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
    await db.insert(gitManagedRepository).values({
      projectId: source.id,
      connectionId: connection.id,
      externalId: '1',
      fullName: 'acme/repo',
      webUrl: 'https://github.com/acme/repo',
      webhookExternalId: '1',
    });
    const preview = (
      await api
        .projects({ projectKey: source.ref })
        .transfer.preview.post({ targetTeamId: target.id })
    ).data!;
    expect(preview.blockers.map((b) => b.code)).toContain('managed_repositories');
  });

  it('moves a member with no role to the destination default', async () => {
    const { owner, api, source, target } = await setup();
    const member = await signUpTestUser();
    const invite = (
      await api
        .projects({ projectKey: source.ref })
        .invites.post({ email: member.email, role: 'member' })
    ).data!;
    expect(
      (await authedApi(member.cookie).invites({ token: invite.token }).accept.post()).status,
    ).toBe(200);
    await db
      .update(projectMember)
      .set({ roleId: null })
      .where(and(eq(projectMember.projectId, source.id), eq(projectMember.userId, member.userId)));
    const join = (
      await api.teams({ teamId: target.id }).invites.post({ email: member.email, role: 'member' })
    ).data!;
    expect(
      (await authedApi(member.cookie).invites({ token: join.token }).accept.post()).status,
    ).toBe(200);
    const preview = (
      await api
        .projects({ projectKey: source.ref })
        .transfer.preview.post({ targetTeamId: target.id })
    ).data!;
    // A null role matches no role, so no mapping is required.
    expect(preview.requiredRoles).toEqual([]);
    const body = { targetTeamId: target.id, sourceTeamId: source.teamId, projectId: source.id };
    expect((await api.projects({ projectKey: source.ref }).transfer.post(body)).status).toBe(200);
    const sysDefault = (await api.teams({ teamId: target.id }).roles.options.get()).data!.find(
      (r) => r.system && r.isDefault,
    )!;
    const members = (await api.projects({ projectKey: 'destination.MOVE' }).members.get()).data!
      .items;
    expect(members.find((m) => m.userId === member.userId)?.roleId).toBe(sysDefault.id);
    // The owner keeps no role, and the backfill does not touch owners.
    expect(members.find((m) => m.userId === owner.userId)?.roleId).toBeNull();
  });

  it('lists each source role that members hold, with how many hold it', async () => {
    const { api, source, target } = await setup();
    const role = (await createRole(api, source.key, { name: 'Analyst', permissions: {} })).data!;
    const member = await signUpTestUser();
    const invite = (
      await api
        .projects({ projectKey: source.ref })
        .invites.post({ email: member.email, role: 'member', roleId: role.id })
    ).data!;
    expect(
      (await authedApi(member.cookie).invites({ token: invite.token }).accept.post()).status,
    ).toBe(200);
    const preview = (
      await api
        .projects({ projectKey: source.ref })
        .transfer.preview.post({ targetTeamId: target.id })
    ).data!;
    expect(preview.requiredRoles).toEqual([
      { sourceRoleId: role.id, name: 'Analyst', memberCount: 1 },
    ]);
  });

  it('reports the destination features, default role, and notification change', async () => {
    const { api, source, target } = await setup();
    setLimits({ blockedFeatures: ['initiatives'] });
    const preview = (
      await api
        .projects({ projectKey: source.ref })
        .transfer.preview.post({ targetTeamId: target.id })
    ).data!;
    expect(preview.targetAvailableFeatures).toEqual(
      PROJECT_FEATURES.filter((feature) => feature !== 'initiatives'),
    );
    expect(preview.notificationProvidersChange).toBe(true);
    const sysDefault = (await api.teams({ teamId: target.id }).roles.options.get()).data!.find(
      (r) => r.system && r.isDefault,
    )!;
    expect(preview.targetDefaultRoleId).toBe(sysDefault.id);
  });
});
