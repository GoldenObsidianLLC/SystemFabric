'use strict';

/**
 * Handle site-scoped membership administration and invitation creation.
 *
 * The API composition layer authenticates the actor and supplies the shared
 * site-selector resolver and capability guard. Every path site ID is reconciled
 * with header, query, and (for JSON writes) body selectors before authorization
 * or identity-store access. Invitation secrets are returned to the trusted
 * caller but never included in audit metadata.
 */
async function handleSiteMembershipRoute(ctx) {
  const {
    req,
    res,
    url,
    actor,
    siteIdFor,
    requireCapability,
    readJson,
    sendJson,
    requestId,
    identity,
    maxBody,
  } = ctx;

  async function resolveRouteSite(siteId, body) {
    // Reconcile selectors here, but preserve this route family's established
    // site:manage authorization/error contract as the membership gate.
    return siteIdFor({ req, url, body, actor, routeSiteId: siteId, requireMembership: false });
  }

  const membersMatch = url.pathname.match(
    /^\/api\/v1\/sites\/([0-9a-f-]{36})\/members$/i,
  );

  if (req.method === 'GET' && membersMatch) {
    const siteId = await resolveRouteSite(membersMatch[1]);
    await requireCapability(actor, siteId, 'site:manage');

    const members = await identity.listMembers({ siteId });
    return sendJson(res, 200, { members, requestId });
  }

  if (req.method === 'POST' && membersMatch) {
    const body = await readJson(req, Math.min(maxBody, 16_384));
    const siteId = await resolveRouteSite(membersMatch[1], body);
    await requireCapability(actor, siteId, 'site:manage');

    const member = await identity.addMember({
      siteId,
      email: body.email,
      roleSlug: body.role,
    });
    await identity.audit({
      siteId,
      actorId: actor.user.id,
      action: 'site.member_added',
      targetType: 'user',
      targetId: member.id,
      requestId,
      details: { role: body.role },
    });

    return sendJson(res, 201, { member, requestId });
  }

  const memberMatch = url.pathname.match(
    /^\/api\/v1\/sites\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/i,
  );

  if (req.method === 'DELETE' && memberMatch) {
    const [, routeSiteId, userId] = memberMatch;
    const siteId = await resolveRouteSite(routeSiteId);
    await requireCapability(actor, siteId, 'site:manage');
    await identity.removeMember({ siteId, userId });
    await identity.audit({
      siteId,
      actorId: actor.user.id,
      action: 'site.member_removed',
      targetType: 'user',
      targetId: userId,
      requestId,
    });

    return sendJson(res, 200, { removed: true, requestId });
  }

  const inviteMatch = url.pathname.match(
    /^\/api\/v1\/sites\/([0-9a-f-]{36})\/invitations$/i,
  );

  if (req.method === 'POST' && inviteMatch) {
    const body = await readJson(req, Math.min(maxBody, 16_384));
    const siteId = await resolveRouteSite(inviteMatch[1], body);
    await requireCapability(actor, siteId, 'site:manage');

    const invitation = await identity.createInvitation({
      siteId,
      email: body.email,
      roleSlug: body.role,
      invitedBy: actor.user.id,
    });
    await identity.audit({
      siteId,
      actorId: actor.user.id,
      action: 'site.invitation_created',
      targetType: 'invitation',
      requestId,
      details: { email: invitation.email, role: invitation.role },
    });

    return sendJson(res, 201, {
      invitation,
      note: 'Deliver the one-time invitation token through a trusted channel; do not write it to ordinary logs.',
      requestId,
    });
  }

  return false;
}

module.exports = { handleSiteMembershipRoute };
