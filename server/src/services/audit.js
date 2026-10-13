// Audit trail for people and agents, plus the customer timeline.
export async function audit(client, ctx, action, entity, entityId, before = null, after = null) {
  await client.query(
    `insert into audit_log (business_id, actor_user_id, actor_agent, action, entity, entity_id, before, after, ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ctx.businessId, ctx.userId || null, ctx.agent || null, action, entity, entityId ? String(entityId) : null, before, after, ctx.ip || null]);
}

export async function activity(client, ctx, contactId, kind, summary, { refId = null, data = {} } = {}) {
  if (!contactId) return;
  await client.query(
    `insert into activities (business_id, contact_id, kind, ref_id, summary, data, actor_user_id, actor_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ctx.businessId, contactId, kind, refId, summary, data, ctx.userId || null, ctx.agent || null]);
  await client.query('update contacts set last_activity_at = now() where id = $1', [contactId]);
}

/** Every AI action is logged: which agent, based on what, what changed, approval needed, result. */
export async function logAgentAction(client, businessId, { agent, action, basedOn = {}, change = {}, approvalRequired = false, approvalStatus = null, result, detail = null }) {
  const { rows } = await client.query(
    `insert into agent_actions (business_id, agent, action, based_on, change, approval_required, approval_status, result, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [businessId, agent, action, basedOn, change, approvalRequired, approvalStatus ?? (approvalRequired ? 'pending' : 'n/a'), result, detail]);
  return rows[0].id;
}
